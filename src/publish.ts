import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { ProjectStore } from './project-store.js';
import { FirestoreAccessError, serviceAccountTokens } from './firestore.js';
import { releaseAdapter } from './website-releases.js';
import { qualityReport } from './quality.js';
import { createManagedDocumentation, readDocumentationEncryptionKey } from './managed-documentation.js';
import type { RecordData, ReleaseMetadata, CryptoCore } from './v3-client.js';
import { convertDocumentation } from './convert.js';
import { validateRecords, wireRecord } from './validation.js';
import { expandAll, isFacts } from './facts.js';
import { readValidationSigningKey } from './config.js';
import { sourceBaselines } from './source-baselines.js';

// The MCP publishes documentation itself: apply a reviewed draft, promote a whole environment, or roll
// one back, with the project's service-account key and the website's own release engine. Every write is
// create-only and validated, and the environment pointer moves in one transaction that re-checks the
// expected releases, so a stale draft never overwrites newer work.
//
// Who may write: authors publish to Development; owners and admins publish anywhere, promote and roll back.
// Viewers only read. The AI must have the user's explicit approval for each write (confirmed: true).

const ENVIRONMENTS = ['development', 'beta', 'production'] as const;
type Environment = typeof ENVIRONMENTS[number];
interface Engine {
  open(adapter: unknown, environment: string): Promise<{ head: { data: { releaseId: string } } | null; release: Record<string, unknown> | null; manifest: Record<string, string> }>;
  publish(adapter: unknown, options: Record<string, unknown>): Promise<{ releaseId: string; count: number; stats: Record<string, number> }>;
  load(adapter: unknown, environment: string): Promise<{ head: { data: { releaseId: string } } | null; release: Record<string, unknown> | null; records: RecordData[] }>;
  release(value: unknown, environment: string): Record<string, string>;
  readRecords(adapter: unknown, manifest: Record<string, string>, keys: string[]): Promise<RecordData[]>;
}
const require = createRequire(import.meta.url);
const engine: Engine = require('../vendor/documentation-engine.js');
const core: CryptoCore = require('../vendor/documentation-v3.js');
const model: { assemble(records: RecordData[]): unknown; fullReview(source: RecordData[], target: RecordData[]): { missing: string[] } } =
  require('../vendor/documentation-model.js');

export class PublishError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Every current publication rule (structure the website assembles, quality, audience coverage, outline, reader rules). */
function publicationReport(records: RecordData[], publicationVersion?: string) {
  model.assemble(records);
  return qualityReport(records, undefined, undefined, { requireAudienceCoverage: true, complete: true, ...(publicationVersion ? {publicationVersion} : {}) });
}

export function assertPublicationQuality(records: RecordData[], publicationVersion?: string) {
  const quality = publicationReport(records, publicationVersion);
  if (!quality.ok) throw new PublishError(400, 'Not published: quality issues: ' +
    quality.issues.slice(0, 5).map(issue => issue.key + ' ' + issue.code + ': ' + issue.message).join(' | '));
}

const releaseId = z.string().regex(/^[a-f0-9-]{36}$/, 'Use a release ID from documentation_release_status.');
const expected = z.union([z.literal('empty'), releaseId]);
const version = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, 'Use a version of letters, digits, dots, dashes or underscores.');
const tags = z.array(z.enum(['New', 'Changed', 'Hotfix'])).min(1).max(3);
const summary = z.string().trim().min(1).max(4000);
const confirmed = z.literal(true, { error: 'Ask the user to approve this exact change first, then send confirmed: true.' });
const target = { project: z.string().trim().min(1).max(120), workspace: z.string().uuid().optional() };

// One AI reply cannot hold a large documentation and the hosting limits a request to 4.5 MB, so a call carries at most
// PART_RECORDS records. Larger documentation is staged in parts (stage_documentation) and published by draftId.
export const PART_RECORDS = 25;
const MAX_PART_BYTES = 4_500_000;
const tooMany = 'More than ' + PART_RECORDS + ' records in one call. Nothing was written. Send the documentation in parts with stage_documentation (up to ' +
  PART_RECORDS + ' records per part, same draftId), then call this tool again with draftId instead of records.';
const sendRecords = 'records (more than ' + PART_RECORDS + ': stage them with stage_documentation and send draftId instead)';
const partRecords = z.array(z.unknown()).min(1).max(PART_RECORDS, tooMany);
const draftId = z.string().uuid('Use the draftId returned by stage_documentation.')
  .describe('The draft from stage_documentation, instead of records, for documentation of more than ' + PART_RECORDS + ' records.');

// What the AI read before writing. Counts and area names only, never paths or source.
export const sourceReview = z.strictObject({
  mode: z.enum(['full', 'incremental']).optional().describe('Default full for initial documentation or migration. Incremental is only for updates to an existing published environment and reviews changed source plus relevant dependencies, not the whole project.'),
  repositories: z.array(z.strictObject({ name: z.string().trim().min(1).max(120), role: z.string().trim().min(1).max(60),
    sourceFiles: z.number().int().min(1).max(1000000), filesRead: z.number().int().min(0).max(1000000),
    changedFiles: z.number().int().min(0).max(1000000).optional().describe('Incremental: number of changed files in the confirmed comparison or agreed feature scope, including removed files reviewed from the baseline.'),
    changedFilesRead: z.number().int().min(0).max(1000000).optional().describe('Incremental: changed files actually reviewed; must equal changedFiles. filesRead also includes relevant dependencies read for this update.') })).min(1).max(12),
  areas: z.array(z.string().trim().min(1).max(120)).min(1).max(300),
  unread: z.array(z.string().trim().min(1).max(200)).max(100).optional()
}).describe('Source review for this work: full initial review or incremental existing-documentation update. Report actual reads, affected areas and inaccessible in-scope code; do not claim a whole-project reread for an incremental update.');
export const MIN_COVERAGE = 0.8;

function assertSourceRead(review: z.infer<typeof sourceReview>, refused: string, allowIncremental = false) {
  if (review.mode === 'incremental') {
    if (!allowIncremental) throw new PublishError(400, refused + ': incremental source review requires an existing published environment. Initial documentation and migration require a full review.');
    const incomplete = review.repositories.filter(repository => repository.changedFiles === undefined || repository.changedFilesRead === undefined ||
      repository.changedFilesRead !== repository.changedFiles || repository.filesRead < repository.changedFilesRead);
    if (incomplete.length || review.unread?.length) throw new PublishError(400, refused + ': incremental source review is incomplete. Report changedFiles and changedFilesRead for each affected repository, review every changed file in the confirmed scope and relevant dependencies, and resolve inaccessible in-scope code. Do not reread unrelated files to satisfy a whole-project percentage.');
    return;
  }
  const thin = review.repositories.filter(repository => repository.filesRead < repository.sourceFiles * MIN_COVERAGE);
  if (thin.length) {
    if (allowIncremental && !review.mode) throw new PublishError(400, refused + ': this environment already has documentation. For a scoped update, send sourceReview.mode="incremental" with changedFiles and changedFilesRead per affected repository. Do not reread the whole project to satisfy a first-publication coverage report.');
    throw new PublishError(400, refused + ': the source code was not read fully. ' + thin.map(repository => repository.name + ' (' + repository.filesRead + ' of ' +
      repository.sourceFiles + ' source files)').join(', ') + '. Read at least ' + MIN_COVERAGE * 100 + '% of every repository\'s source files (not the README), update the documentation, then publish again.');
  }
}

/** What is missing or inconsistent in a convert-mode check of every page against the code. */
function verificationProblems(checks: z.infer<typeof featureCheck>[], sourceKeys: string[], finalKeys: string[], draftKeys: string[], removed: string[]) {
  const problems: string[] = [];
  const source = new Set(sourceKeys), drafted = new Set(draftKeys), gone = new Set(removed);
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.key)) problems.push(check.key + ' is listed twice.');
    seen.add(check.key);
    const known = source.has(check.key);
    if (check.verdict === 'accurate' && (!known || drafted.has(check.key))) problems.push(check.key + ' is marked accurate but ' + (known ? 'was rewritten; mark it corrected.' : 'is not an existing page.'));
    if (check.verdict === 'corrected' && (!known || !drafted.has(check.key))) problems.push(check.key + ' is marked corrected but ' + (known ? 'no rewrite was sent in records.' : 'is not an existing page; mark it added.'));
    if (check.verdict === 'added' && (known || !drafted.has(check.key))) problems.push(check.key + ' is marked added but ' + (known ? 'already exists; mark it corrected or accurate.' : 'no page was sent in records.'));
    if (check.verdict === 'removed' && !gone.has(check.key)) problems.push(check.key + ' is marked removed but is not in remove.');
  }
  for (const key of finalKeys) if (key !== 'foundation' && !seen.has(key)) problems.push(key + ' was not checked against the code.');
  for (const key of gone) if (!checks.some(check => check.key === key && check.verdict === 'removed')) problems.push(key + ' is removed without a removed check.');
  return problems;
}

/** Apply drafts and removals on top of a complete snapshot. */
function mergeSnapshot(current: RecordData[], drafts: RecordData[], remove: string[] = []) {
  const records = new Map(current.map(record => [record.key, record]));
  const removals = new Set(remove);
  if (removals.size !== remove.length) throw new PublishError(400, 'Remove keys must be unique.');
  if (removals.has('foundation')) throw new PublishError(400, 'Remove cannot delete the foundation.');
  for (const key of removals) {
    if (!records.has(key)) throw new PublishError(400, 'Remove key is not published: ' + key);
    records.delete(key);
  }
  for (const record of drafts) {
    if (removals.has(record.key)) throw new PublishError(400, 'Remove and replacement overlap: ' + record.key);
    records.set(record.key, record);
  }
  if (new Set(drafts.map(record => record.key)).size !== drafts.length) {
    throw new PublishError(400, 'Duplicate draft record key.');
  }
  if (model.fullReview([...records.values()], current).missing.some(key => removals.has(key))) {
    throw new PublishError(400, 'Remove links to deleted articles in the same draft.');
  }
  return [...records.values()];
}

export const publishInput = z.strictObject({ ...target, environment: z.enum(ENVIRONMENTS), expected, records: partRecords.optional(), draftId: draftId.optional(),
  sourceReview, sourceBaselines: sourceBaselines.optional().describe('Exact reviewed repository commits to save atomically with this publication. Existing unchanged repository baselines are retained. The host verifies Git refs locally; never send local paths or credentials.'),
  format: z.literal(3).optional().describe('Use 3 for a new encrypted v3 environment.'),
  replaceLegacy: z.literal(true).optional().describe('With format 3 on an environment that still has older (v1/v2) documentation: publish complete new v3 documentation instead of migrating, then delete the old documentation. Only after the user approves replacing it.'),
  remove: z.array(z.string().max(200)).max(2000).optional(), version, tags, summary, confirmed });
export const promoteInput = z.strictObject({ ...target, source: z.enum(ENVIRONMENTS), target: z.enum(ENVIRONMENTS), expected, expectedSource: releaseId,
  acknowledgeMissing: z.boolean().optional(), version: version.optional(), tags: tags.optional(), summary: summary.optional(), confirmed });
export const rollbackInput = z.strictObject({ ...target, environment: z.enum(ENVIRONMENTS), expected: releaseId, rollbackRelease: releaseId, version, tags, summary, confirmed });
export const statusInput = z.strictObject({ ...target, environment: z.enum(ENVIRONMENTS).optional() });
export const getSourceBaselinesInput = z.strictObject({...target, environment: z.enum(ENVIRONMENTS), releaseId: releaseId.optional()});
export const recordSourceBaselinesInput = z.strictObject({...target, environment: z.enum(ENVIRONMENTS), expected: releaseId,
  repositories: sourceBaselines,
  verified: z.literal(true).describe('The host and user verified these exact commits were covered by the existing documentation. Never substitute current HEAD merely because a baseline is missing.'),
  confirmed});
// Migration copies the published snapshot, but the result must meet every current rule. When it does not, the AI reads
// the code and sends rewritten articles (records/remove) with sourceReview, exactly as for a publication.
export const migrationModes = ['convert', 'rewrite'] as const;
export const featureVerdicts = ['accurate', 'corrected', 'added', 'removed'] as const;
const featureCheck = z.strictObject({
  key: z.string().min(1).max(200),
  verdict: z.enum(featureVerdicts).describe('accurate: the page matches the code as is; corrected: rewritten in records because the code differs; added: a new page in records for a feature the old documentation missed; removed: listed in remove because the feature no longer exists in the code.'),
  checked: z.array(z.string().trim().min(1).max(200)).min(1).max(50).describe('The code areas or source file names compared with this page (names only, never code).'),
  note: z.string().trim().max(500).optional()
});
export const migrateInput = z.strictObject({ ...target, environment: z.enum(ENVIRONMENTS), expected: releaseId,
  mode: z.enum(migrationModes).describe('The user\'s choice. convert: keep the existing pages, check every feature against the code and fix what is wrong or missing. rewrite: write the whole documentation again from the code; the old pages are replaced.'),
  verification: z.array(featureCheck).min(1).max(2000).optional().describe('convert mode: one entry per page of the migrated documentation (and per removed page) saying how it was checked against the code.'),
  approveConversion: z.boolean().optional(),
  records: partRecords.optional().describe('Rewritten articles (and foundation) that replace the converted ones so the snapshot meets every current rule. More than ' +
    PART_RECORDS + ': stage them and send draftId.'), draftId: draftId.optional(),
  remove: z.array(z.string().max(200)).max(2000).optional(), sourceReview: sourceReview.optional(),
  version: version.optional(), tags: tags.optional(), summary: summary.optional(), confirmed });

export const stageInput = z.strictObject({ ...target, environment: z.enum(ENVIRONMENTS),
  draftId: z.string().uuid('Use the draftId returned by part 1.').optional().describe('Omit for part 1; then send the draftId it returned with every later part.'),
  part: z.number().int().min(1).max(200).describe('1, 2, 3 … Sending a part number again replaces that part.'),
  records: partRecords.describe('Up to ' + PART_RECORDS + ' records (the foundation and articles) of this part.') });

// Staged parts are gzipped and sealed with AES-256-GCM before they leave the server; the draft ID and part number are bound in.
let draftKey: Buffer | undefined;
const sealKey = () => draftKey ??= createHmac('sha256', readValidationSigningKey()).update('documentation-draft-seal-v1').digest();
function sealPart(id: string, part: number, records: unknown[]) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(), iv).setAAD(Buffer.from(id + ':' + part));
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(records))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function openPart(id: string, part: number, payload: string): unknown[] {
  try {
    const bytes = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', sealKey(), bytes.subarray(0, 12)).setAAD(Buffer.from(id + ':' + part));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(gunzipSync(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])).toString('utf8')) as unknown[];
  } catch {
    throw new PublishError(410, 'Draft part ' + part + ' can no longer be read. Stage the documentation again from part 1 without draftId.');
  }
}

const label = (environment: string) => environment[0]!.toUpperCase() + environment.slice(1);
const describe = (id: string, data: Record<string, unknown>) => ({ releaseId: id, version: data.version, tags: data.tags, summary: data.summary,
  operation: data.operation, author: data.actor, publishedAt: data.createdAt,
  articles: typeof data.manifest === 'string' ? Math.max(0, Object.keys(JSON.parse(data.manifest) as object).length - 1) : null });

type Adapter = ReturnType<typeof releaseAdapter>;
export function createDocumentationPublisher(store: ProjectStore, fetchService: typeof fetch = fetch,
  adapterFor: (firebaseProject: string, key: string, actor: string) => Adapter =
    (project, key, actor) => releaseAdapter(project, serviceAccountTokens(key, fetchService), actor, fetchService)) {
  async function open(input: { project: string; workspace?: string | undefined }, write?: Environment) {
    const access = await store.readAccess(input.project, input.workspace);
    if (write) {
      if (access.role === 'viewer') throw new PublishError(403, 'Viewers can read documentation but not publish. Ask a workspace owner, admin or author.');
      if (access.role === 'author' && write !== 'development') throw new PublishError(403, 'Authors publish to Development. Ask a workspace owner or admin to publish to ' + label(write) + ' or promote it.');
      if (!access.environments.includes(write)) throw new PublishError(403, 'You cannot publish to this environment.');
    }
    if (!access.firebaseProject) throw new PublishError(400, 'This project has no Firebase project ID yet. Add firebaseProject to the project in projects.json.');
    if (access.mode !== 'service-account' || !access.serviceAccountKey) {
      throw new PublishError(400, 'Publishing uses the project\'s service-account key. An owner or admin uploads it under Projects (project setup, step 3) with the Cloud Datastore User role.');
    }
    const adapter = adapterFor(access.firebaseProject, access.serviceAccountKey, await store.memberEmail());
    const get = adapter.get;
    adapter.get = async path => {
      const environment = /^documentationEnvironments\/(development|beta|production)$/.exec(path)?.[1];
      if (environment && await get('documentationV3Environments/' + environment)) {
        throw new PublishError(409, 'This environment uses contract-v3; plaintext publication cannot replace an encrypted release. A managed encryption key is required.');
      }
      return get(path);
    };
    const managed = () => {
      if (!readDocumentationEncryptionKey()) throw new PublishError(503,
        'Server-managed encryption is not configured. Contract-v3 requires MCP_DOCUMENTATION_ENCRYPTION_KEY; old E2EE releases must be explicitly migrated.');
      return createManagedDocumentation({ ...access, firebaseProject: access.firebaseProject!,
        serviceAccountKey: access.serviceAccountKey! }, { fetchService, actor: adapter.actor });
    };
    return Object.assign(adapter, { readable: access.environments, access, managed,
      encrypted: async (environment: Environment) => Boolean(await get('documentationV3Environments/' + environment)) });
  }
  type Opened = Awaited<ReturnType<typeof open>>;
  async function snapshot(adapter: Opened, environment: Environment) {
    if (!adapter.readable.includes(environment)) throw new PublishError(403, 'You cannot read this environment.');
    if (await adapter.encrypted(environment)) {
      const value = await adapter.managed().read(environment);
      return { encrypted: true, releaseId: value.head!.releaseId, records: value.records, metadata: value.metadata, sourceBaselines: value.sourceBaselines };
    }
    const value = await engine.load(adapter, environment);
    return { encrypted: false, releaseId: value.head?.data.releaseId ?? 'empty', records: value.records,
      sourceBaselines: null,
      metadata: value.release ? { version: String(value.release.version), tags: value.release.tags as ReleaseMetadata['tags'],
        summary: String(value.release.summary), operation: 'import' as const } : undefined };
  }
  function expect(actual: string, expected: string) {
    if (actual !== expected) throw new PublishError(409, 'Release conflict: refresh documentation_release_status and rebase the change.');
  }
  const notes = (input: { version: string; tags: ReleaseMetadata['tags']; summary: string }, operation: ReleaseMetadata['operation']): ReleaseMetadata =>
    ({ version: input.version, tags: input.tags, summary: input.summary, operation });
  const failed = (error: unknown): never => {
    if (error instanceof PublishError) throw error;
    if (error instanceof FirestoreAccessError) throw new PublishError(error.status, error.message);
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') throw new PublishError(error.status, error.message);
    if (error instanceof Error && /conflict/i.test(error.message)) {
      throw new PublishError(409, error.message + ' Someone published since you last checked: call documentation_release_status, review the newer release, and rebase the change on it.');
    }
    if (error instanceof Error && /^(Invalid|Only|Source|Unpublished|Choose|Rollback|Immutable|Release|Revision|Missing|Environment|Explicit|Remove|Duplicate|select|a target|difference|Unknown|Record|Section|Navigation|Foundation)/i.test(error.message)) {
      throw new PublishError(400, error.message.replace(/^Invalid documentation: /, ''));
    }
    throw error;
  };

  const drafts = () => {
    if (!store.drafts) throw new PublishError(501, 'Staging in parts needs the hosted MCP. Publish at most ' + PART_RECORDS + ' records per call.');
    return store.drafts;
  };
  /** The records of one call: sent directly, or every staged part of the draft in order. */
  async function recordsOf(input: { project: string; workspace?: string | undefined; environment: Environment; records?: unknown[] | undefined; draftId?: string | undefined }) {
    if (input.records && input.draftId) throw new PublishError(400, 'Send records or draftId, not both.');
    if (!input.draftId) return input.records ? expandAll(input.records) : input.records;
    const draft = await drafts().read(input.project, input.workspace, input.draftId);
    if (draft.environment !== input.environment) throw new PublishError(400, 'This draft was staged for ' + draft.environment + '. Use the same environment.');
    if (!draft.parts.length) throw new PublishError(400, 'This draft has no parts yet. Stage them with stage_documentation.');
    return draft.parts.flatMap(part => openPart(input.draftId!, part.part, part.payload));
  }
  // A published draft is deleted; a failed one stays so the AI can replace parts and try again.
  const discard = async (id: string | undefined) => {
    if (!id) return;
    try { await drafts().remove(id); } catch { /* it expires after 24 hours anyway */ }
  };

  return {
    async sourceBaselines(input: z.infer<typeof getSourceBaselinesInput>) {
      input = getSourceBaselinesInput.parse(input);
      const adapter = await open(input);
      try {
        if (!adapter.readable.includes(input.environment)) throw new PublishError(403, 'You cannot read this environment.');
        if (!await adapter.encrypted(input.environment)) throw new PublishError(409, 'Source baselines require encrypted v3 documentation. Migrate legacy documentation first.');
        const record = await adapter.managed().sourceBaselines(input.environment, input.releaseId);
        return {environment: input.environment, sourceBaselines: record, baselineMissing: record === null,
          nextAction: record ? 'Compare these reviewed commits with the user-confirmed target refs in each local repository. Branch names do not identify documentation environments.' :
            'No verified baseline is recorded. Ask for the documented commits or a confirmed comparison; never label current HEAD as previously documented.'};
      } catch (error) { return failed(error); }
    },
    async recordSourceBaselines(input: z.infer<typeof recordSourceBaselinesInput>) {
      input = recordSourceBaselinesInput.parse(input);
      const adapter = await open(input, input.environment);
      try {
        if (!await adapter.encrypted(input.environment)) throw new PublishError(409, 'Source baselines require encrypted v3 documentation. Migrate legacy documentation first.');
        const record = await adapter.managed().registerSourceBaselines(input.environment, input.expected, input.repositories);
        return {recorded: true, environment: input.environment, releaseId: record.releaseId, sourceBaselines: record};
      } catch (error) { return failed(error); }
    },
    /** Every record of a staged draft, for checking the whole draft on the server without resending it. */
    async draftRecords(input: { project: string; workspace?: string | undefined; environment: Environment; draftId: string; remove?: string[] | undefined },
      mergePublished = false) {
      const drafts = (await recordsOf(input).catch(failed)) ?? [];
      if (!mergePublished) return drafts;
      // A partial update: check it the way publication will, merged into the published release.
      const adapter = await open(input);
      try {
        const current = await snapshot(adapter, input.environment);
        return mergeSnapshot(current.records as RecordData[], drafts as RecordData[], input.remove);
      } catch (error) { return failed(error); }
    },
    /** Every record of the release currently published in one environment, for checking it against today's rules. */
    async publishedRecords(input: { project: string; workspace?: string | undefined; environment: Environment }) {
      const adapter = await open(input);
      try { return (await snapshot(adapter, input.environment)).records as RecordData[]; }
      catch (error) { return failed(error); }
    },
    /** Store one part of a large documentation; publish_documentation or migrate_documentation_to_v3 then takes the draftId. */
    async stage(input: z.infer<typeof stageInput>) {
      input = stageInput.parse(input);
      if (!input.draftId && input.part !== 1) throw new PublishError(400, 'Start with part 1 without draftId, then send its draftId with every later part.');
      // Facts records are built from the foundation in this part, or in part 1 of the draft.
      let foundation = input.records.find(record => (record as { key?: unknown } | null)?.key === 'foundation') as { data?: unknown } | undefined;
      if (!foundation && input.draftId && input.records.some(isFacts)) {
        const first = (await drafts().read(input.project, input.workspace, input.draftId)).parts.find(part => part.part === 1);
        foundation = first ? openPart(input.draftId, 1, first.payload).find(record => (record as { key?: unknown } | null)?.key === 'foundation') as { data?: unknown } | undefined : undefined;
      }
      input = { ...input, records: expandAll(input.records, foundation) };
      const parsed = input.records.map(record => wireRecord.parse(record));
      const keys = parsed.map(record => record.key);
      const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
      if (repeated.length) throw new PublishError(400, 'Duplicate record key in this part: ' + [...new Set(repeated)].join(', '));
      const id = input.draftId ?? randomUUID();
      const payload = sealPart(id, input.part, input.records);
      if (payload.length > MAX_PART_BYTES) throw new PublishError(413, 'This part is larger than 4.5 MB. Send fewer records per part.');
      const result = await drafts().put(input.project, input.workspace, { id, environment: input.environment, part: input.part, records: parsed.length, payload });
      const next = Math.max(...result.parts.map(part => part.part)) + 1;
      return { staged: true, draftId: id, environment: result.environment, part: input.part, parts: result.parts,
        records: result.parts.reduce((total, part) => total + part.records, 0),
        next: 'Send the next part with draftId "' + id + '" and part ' + next + ' (sending a part number again replaces it). When every part is staged, ' +
          'call publish_documentation or migrate_documentation_to_v3 with draftId "' + id + '" instead of records, after the user approves. ' +
          'The draft expires 24 hours after its last part; a failed publication keeps it so you can replace parts and try again.' };
    },
    /** The current release of each environment (or one), with the IDs a write must expect. */
    async status(input: z.infer<typeof statusInput>) {
      const adapter = await open(input);
      try {
        if (input.environment && !adapter.readable.includes(input.environment)) throw new PublishError(403, 'You can read: ' + adapter.readable.join(', ') + '.');
        const environments = await Promise.all((input.environment ? [input.environment] : ENVIRONMENTS.filter(item => adapter.readable.includes(item))).map(async environment => {
          if (await adapter.encrypted(environment)) {
            const value = await adapter.managed().read(environment);
            const release = { releaseId: value.head!.releaseId, ...value.metadata, articles: value.records.length - 1, format: 3,
              ...await adapter.managed().audit(value.head!.releaseId), sourceBaselines: value.sourceBaselines, baselineMissing: !value.sourceBaselines };
            return { environment, expected: release.releaseId, release };
          }
          const snapshot = await engine.open(adapter, environment);
          const release = snapshot.head && snapshot.release ? describe(snapshot.head.data.releaseId, snapshot.release) : null;
          return { environment, expected: release?.releaseId ?? 'empty', release };
        }));
        const history = input.environment ? await adapter.encrypted(input.environment)
          ? await adapter.managed().history(input.environment)
          : (await adapter.history(input.environment)).slice(0, 20).map(item => describe(item.id, item)) : undefined;
        return { environments, ...(history ? { history } : {}) };
      } catch (error) { return failed(error); }
    },
    /** Apply a reviewed draft: the records replace or add articles; remove deletes articles from the new release only. */
    async publish(input: z.infer<typeof publishInput>) {
      input = publishInput.parse(input);
      assertSourceRead(input.sourceReview, 'Not published', input.expected !== 'empty' && !input.replaceLegacy);
      if (!input.records && !input.draftId) throw new PublishError(400, 'Send records (up to ' + PART_RECORDS + ') or the draftId from stage_documentation.');
      const raw = await recordsOf(input).catch(failed);
      const drafts = raw!.map(record => wireRecord.parse(record));
      const adapter = await open(input, input.environment);
      try {
        const encrypted = await adapter.encrypted(input.environment);
        if (encrypted || input.format === 3) {
          // Older v1/v2 documentation is either migrated or replaced by complete new v3 documentation and then deleted.
          const legacy = encrypted ? undefined : (await engine.open(adapter, input.environment)).head?.data.releaseId;
          if (legacy && !input.replaceLegacy) {
            throw new PublishError(409, 'This environment has older (v1/v2) documentation. Ask the user whether to migrate it with migrate_documentation_to_v3, ' +
              'or to write new v3 documentation from the code and publish it with replaceLegacy: true, which deletes the old documentation.');
          }
          if (input.replaceLegacy && !legacy) throw new PublishError(400, 'replaceLegacy is only for an environment that still has older (v1/v2) documentation.');
          if (legacy && (input.remove?.length || !drafts.some(record => record.key === 'foundation'))) {
            throw new PublishError(400, 'Not published: new documentation replaces the old one completely. Send the foundation and every article, without remove.');
          }
          const current = encrypted ? await snapshot(adapter, input.environment) : { releaseId: legacy ?? 'empty', records: [] };
          expect(current.releaseId, input.expected);
          const records = mergeSnapshot(current.records, drafts, input.remove);
          assertPublicationQuality(records, input.version);
          const result = await adapter.managed().publish(input.environment, { records, expected: encrypted ? input.expected : 'empty',
            ...(!encrypted ? { expectedLegacy: legacy ?? 'empty' } : {}), metadata: notes(input, 'apply'),
            ...(input.sourceBaselines ? {sourceBaselines: input.sourceBaselines} : {}) });
          await discard(input.draftId);
          // The v3 release is live; a failed clean-up leaves unreadable old documents behind and is reported, not undone.
          const legacyRemoved = legacy ? await adapter.retireLegacy(input.environment)
            .catch((error: unknown) => ({ failed: error instanceof Error ? error.message : 'unknown error' })) : undefined;
          return { published: true, environment: input.environment, ...result, author: adapter.actor,
            ...(legacyRemoved ? { legacyRemoved } : {}),
            ...(input.sourceReview.unread?.length ? { notCovered: input.sourceReview.unread } : {}) };
        }
      } catch (error) { return failed(error); }
      try {
        if (input.sourceBaselines) throw new PublishError(409, 'Source baselines require format:3. Migrate legacy documentation before recording Git baselines.');
        const current = await engine.load(adapter, input.environment);
        expect(current.head?.data.releaseId ?? 'empty', input.expected);
        const merged = new Map(current.records.map(record => [record.key, record]));
        for (const key of input.remove ?? []) merged.delete(key);
        for (const record of drafts) merged.set(record.key, record);
        assertPublicationQuality([...merged.values()], input.version);
        const result = await engine.publish(adapter, { operation: 'apply', environment: input.environment, expected: input.expected, records: raw,
          ...(input.remove?.length ? { remove: input.remove } : {}), version: input.version, tags: input.tags, summary: input.summary, actor: adapter.actor });
        await discard(input.draftId);
        return { published: true, environment: input.environment, releaseId: result.releaseId, articles: result.count, author: adapter.actor,
          ...(input.sourceReview.unread?.length ? { notCovered: input.sourceReview.unread } : {}),
          next: 'Ask the user to check it on the documentation website, then promote it when they are happy.' };
      } catch (error) { return failed(error); }
    },
    /** Copy one environment's whole published documentation to another. Defaults to the source version and tags. */
    async promote(input: z.infer<typeof promoteInput>) {
      input = promoteInput.parse(input);
      if (!['development:beta', 'development:production', 'beta:production'].includes(input.source + ':' + input.target)) {
        throw new PublishError(400, 'Only Development → Beta, Development → Production and Beta → Production are allowed.');
      }
      const adapter = await open(input, input.target);
      try {
        if (adapter.access.role === 'author') throw new PublishError(403, 'Only owners and admins may promote documentation.');
        if (!adapter.readable.includes(input.source)) throw new PublishError(403, 'You cannot read the source environment.');
        const sourceManaged = await adapter.encrypted(input.source), targetManaged = await adapter.encrypted(input.target);
        if (sourceManaged || targetManaged) {
          const source = await snapshot(adapter, input.source), target = await snapshot(adapter, input.target);
          expect(source.releaseId, input.expectedSource);
          expect(target.releaseId, input.expected);
          if (!source.metadata) throw new PublishError(400, 'Source is not published.');
          if (model.fullReview(source.records, target.records).missing.length && !input.acknowledgeMissing) {
            throw new PublishError(400, 'Unpublished outgoing links require explicit acknowledgement.');
          }
          assertPublicationQuality(source.records, String(input.version ?? source.metadata.version));
          const result = await adapter.managed().publish(input.target, { records: source.records,
            expected: targetManaged ? input.expected : 'empty',
            ...(!targetManaged ? { expectedLegacy: input.expected } : {}),
            expectedSource: { environment: input.source, releaseId: input.expectedSource, ...(!sourceManaged ? { legacy: true } : {}) },
            sourceBaselines: source.sourceBaselines?.repositories ?? [],
            metadata: { operation: 'promote', sourceRelease: input.expectedSource,
              version: input.version ?? source.metadata.version, tags: input.tags ?? source.metadata.tags,
              summary: input.summary ?? 'Promoted from ' + label(input.source) + '.' } });
          // Encrypted documentation promoted over an older target replaces it; the old target documentation is deleted.
          const legacyRemoved = !targetManaged && input.expected !== 'empty' ? await adapter.retireLegacy(input.target)
            .catch((error: unknown) => ({ failed: error instanceof Error ? error.message : 'unknown error' })) : undefined;
          return { promoted: true, source: input.source, target: input.target, ...result, author: adapter.actor, ...(legacyRemoved ? { legacyRemoved } : {}) };
        }
        const source = await engine.load(adapter, input.source);
        if (!source.head || !source.release) throw new PublishError(400, 'Nothing is published in ' + label(input.source) + ' yet.');
        expect(source.head.data.releaseId, input.expectedSource);
        assertPublicationQuality(source.records, String(input.version ?? source.release.version));
        const result = await engine.publish(adapter, { operation: 'promote', environment: input.target, source: input.source, expected: input.expected,
          expectedSource: input.expectedSource, version: input.version ?? source.release.version, tags: input.tags ?? source.release.tags,
          summary: input.summary ?? 'Promoted version ' + String(source.release.version) + ' from ' + label(input.source) + ' to ' + label(input.target) + '.',
          actor: adapter.actor, acknowledgeMissing: input.acknowledgeMissing === true });
        return { promoted: true, source: input.source, target: input.target, releaseId: result.releaseId, articles: result.count, author: adapter.actor };
      } catch (error) { return failed(error); }
    },
    /** Make an earlier release of the same environment current again, as a new audited release. */
    async rollback(input: z.infer<typeof rollbackInput>) {
      input = rollbackInput.parse(input);
      const adapter = await open(input, input.environment);
      try {
        if (adapter.access.role === 'author') throw new PublishError(403, 'Only owners and admins may roll back documentation.');
        if (await adapter.encrypted(input.environment)) {
          const current = await adapter.managed().head(input.environment);
          expect(current.head?.releaseId ?? 'empty', input.expected);
          let records: RecordData[];
          let baselines: Awaited<ReturnType<ReturnType<typeof adapter.managed>['sourceBaselines']>> = null;
          if (await adapter.get('documentationV3Releases/' + input.rollbackRelease)) {
            const restored = await adapter.managed().read(input.environment, input.rollbackRelease);
            records = restored.records;
            baselines = restored.sourceBaselines;
          } else {
            const previous = await adapter.get('documentationReleases/' + input.rollbackRelease);
            const manifest = engine.release(previous?.data, input.environment);
            records = core.normalize(await engine.readRecords(adapter, manifest, Object.keys(manifest))).records;
          }
          const result = await adapter.managed().publish(input.environment, { records, expected: input.expected,
            sourceBaselines: baselines?.repositories ?? [],
            metadata: { ...notes(input, 'rollback'), rollbackRelease: input.rollbackRelease } });
          return { rolledBack: true, environment: input.environment, ...result, restored: input.rollbackRelease, author: adapter.actor };
        }
        const result = await engine.publish(adapter, { operation: 'rollback', environment: input.environment, expected: input.expected,
          rollbackRelease: input.rollbackRelease, version: input.version, tags: input.tags, summary: input.summary, actor: adapter.actor });
        return { rolledBack: true, environment: input.environment, releaseId: result.releaseId, restored: input.rollbackRelease, author: adapter.actor };
      } catch (error) { return failed(error); }
    },
    async migrate(input: z.infer<typeof migrateInput>) {
      input = migrateInput.parse(input);
      const rewriteAll = input.mode === 'rewrite';
      const raw = await recordsOf(input).catch(failed);
      if (rewriteAll && (input.remove?.length || input.verification)) {
        throw new PublishError(400, 'Not migrated: a rewrite replaces every page. Send the complete new documentation in records, without remove or verification.');
      }
      // Every migration is checked against the code; only the first convert call (which lists the pages to check) needs no source review yet.
      const checking = rewriteAll ? Boolean(raw?.length) : Boolean(input.verification);
      const rewriting = Boolean(raw?.length || input.remove?.length);
      if ((checking || rewriting) && !input.sourceReview) throw new PublishError(400, 'Not migrated: the documentation must be checked against the code. Read at least ' +
        MIN_COVERAGE * 100 + '% of every repository\'s source files and report sourceReview.');
      if (input.sourceReview) assertSourceRead(input.sourceReview, 'Not migrated');
      const drafts = (raw ?? []).map(record => wireRecord.parse(record));
      if (rewriteAll && drafts.length && !drafts.some(record => record.key === 'foundation')) {
        throw new PublishError(400, 'Not migrated: a rewrite must include the foundation and every article of the new documentation.');
      }
      const adapter = await open(input, input.environment);
      try {
        if (await adapter.encrypted(input.environment)) {
          await adapter.managed().read(input.environment);
          throw new PublishError(409, 'This environment already has an encrypted release.');
        }
        const current = await snapshot(adapter, input.environment);
        expect(current.releaseId, input.expected);
        if (!current.metadata) throw new PublishError(400, 'Nothing is published in this environment.');
        const legacyKeys = current.records.map(record => record.key).filter(key => key !== 'foundation');
        if (rewriteAll && !drafts.length) {
          return { migrated: false, mode: input.mode, requiresRewrite: true, articles: legacyKeys,
            next: 'Nothing was written. Write the complete documentation again from the code: read at least ' + MIN_COVERAGE * 100 +
              '% of every repository, plan the topics with design_documentation_structure, write the foundation and every article, and validate them with ' +
              'validate_documentation (complete: true). The old pages are only a list of features to look for in the code, never a source. Show the user the new ' +
              'documentation and which old pages it replaces, then call migrate_documentation_to_v3 again with mode: "rewrite", the same expected, ' +
              'the complete documentation as ' + sendRecords + ', sourceReview and confirmed: true.' };
        }
        const converting = !rewriteAll && current.records.some(record => record.key === 'foundation' &&
          (record.data as { schemaVersion?: unknown }).schemaVersion !== 2);
        const conversion = converting ? convertDocumentation({ foundation: current.records.find(record => record.key === 'foundation'),
          records: current.records.filter(record => record.key !== 'foundation'), complete: true }) : undefined;
        if (conversion && !conversion.records.length) throw new PublishError(400, 'Conversion failed: ' + conversion.errors.join(' | '));
        const source = rewriteAll ? [] : conversion?.records ?? current.records;
        const normalized = core.normalize(mergeSnapshot(source, drafts, input.remove));
        // The migrated release must satisfy the same rules as a new publication; nothing is grandfathered in.
        const structure = validateRecords(normalized.records, { complete: true });
        let quality: ReturnType<typeof publicationReport> | undefined;
        let assembly: string | undefined;
        if (structure.ok) {
          try { quality = publicationReport(normalized.records); }
          catch (error) { if (!(error instanceof Error)) throw error; assembly = error.message; }
        }
        const issues = [...(assembly ? [{ key: 'foundation', code: 'ASSEMBLY', message: assembly }] : []), ...(quality?.issues ?? [])];
        const blocked = !structure.ok || issues.length > 0;
        const awaitingConversion = Boolean(conversion) && !input.approveConversion;
        const awaitingVerification = !rewriteAll && !input.verification;
        if (input.verification) {
          const problems = verificationProblems(input.verification, source.map(record => record.key), normalized.records.map(record => record.key),
            drafts.map(record => record.key), input.remove ?? []);
          if (problems.length) throw new PublishError(400, 'Not migrated: every page must be checked against the code. ' + problems.join(' '));
        }
        if (blocked || awaitingConversion || awaitingVerification) {
          const keys = new Set(['foundation', ...issues.map(issue => issue.key)]);
          const pages = source.filter(record => record.key !== 'foundation').map(record => ({ key: record.key, title: record.title }));
          return { migrated: false, mode: input.mode,
            ...(awaitingConversion ? { requiresConversionApproval: true, report: conversion!.report as unknown } : {}),
            ...(awaitingVerification ? { requiresVerification: true, features: pages } : {}),
            ...(blocked ? { requiresRewrite: true, errors: structure.errors, issues, audienceCoverage: quality?.audienceCoverage,
              articles: normalized.records.map(record => record.key).filter(key => key !== 'foundation'),
              rewrite: normalized.records.filter(record => keys.has(record.key)) } : {}),
            next: rewriteAll
              ? 'Nothing was written. Fix every error and issue in the new documentation from the code (OUTLINE_EXPECTED gives the required outline), validate with ' +
                'validate_documentation (complete: true), show the user the change, then call migrate_documentation_to_v3 again with mode: "rewrite", the same expected, ' +
                sendRecords + ', sourceReview and confirmed: true.'
              : 'Nothing was written. Read the source code (at least ' + MIN_COVERAGE * 100 + '% of every repository). For every page in features, find the feature ' +
                'in the code and compare each statement, step, rule, message and limit with what the code does: keep it (accurate), rewrite it from the code ' +
                '(corrected, in records), or remove it when the feature no longer exists (removed, in remove, with the user\'s approval). Write a page for every ' +
                'feature the code has but the old documentation misses (added, in records). Fix every error and issue as well (OUTLINE_EXPECTED gives the ' +
                'required outline). Validate with validate_documentation (complete: true), show the user what was accurate, corrected, added and removed' +
                (conversion ? ' together with the conversion report' : '') + ', then call migrate_documentation_to_v3 again with mode: "convert", the same ' +
                'expected, verification (one entry per page), ' + sendRecords + ', remove, sourceReview' + (conversion ? ', approveConversion: true' : '') + ' and confirmed: true.' };
        }
        const metadata = { ...current.metadata, ...(input.version ? { version: input.version } : {}), ...(input.tags ? { tags: input.tags } : {}),
          ...(input.summary ? { summary: input.summary } : {}) };
        const result = await adapter.managed().publish(input.environment, { records: normalized.records, expected: 'empty',
          expectedLegacy: input.expected, metadata: { ...metadata, operation: 'import', sourceRelease: input.expected } });
        await discard(input.draftId);
        const finalKeys = new Set(normalized.records.map(record => record.key));
        return { migrated: true, mode: input.mode, environment: input.environment, ...result, report: (conversion?.report ?? normalized.report) as unknown,
          ...(rewriting ? { rewritten: drafts.map(record => record.key), removed: input.remove ?? [] } : {}),
          ...(rewriteAll ? { replaced: legacyKeys.filter(key => !finalKeys.has(key)) } : {}),
          ...(input.verification ? { verification: Object.fromEntries(featureVerdicts.map(verdict =>
            [verdict, input.verification!.filter(check => check.verdict === verdict).length])) } : {}),
          ...(input.sourceReview?.unread?.length ? { notCovered: input.sourceReview.unread } : {}) };
      } catch (error) { return failed(error); }
    }
  };
}
