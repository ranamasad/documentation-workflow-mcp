import { addSourceBaselineTags, sourceBaselineRecord, type SourceBaseline, type SourceBaselineRecord } from './source-baselines.js';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { createCiphertextCache, ciphertextCacheKey } from './ciphertext-cache.js';
import { applyFirestoreCommit, createFirestoreReader, FirestoreAccessError, serviceAccountTokens, type FirestoreReader, type RestWrite } from './firestore.js';
import { createV3Repository } from './v3-repository.js';
import { feedbackTarget, visitEntry } from './telemetry-schema.js';

interface V3Validators {
  validateEnvelope(value: unknown): unknown;
  validateRelease(value: unknown): unknown;
  validateVault(value: unknown): unknown;
  validateGrant(value: unknown): unknown;
}
const core: V3Validators = createRequire(import.meta.url)('../vendor/documentation-v3.js');
function coreValid(method: keyof V3Validators, value: unknown): boolean {
  try { core[method](value); return true; } catch { return false; }
}
export const V3_REQUEST_BYTES = 10 * 1024 * 1024;
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Not JSON.');
  return text;
};
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = z.string().uuid();
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const environment = z.enum(['development', 'beta', 'production']);
function base64(min: number, max: number) {
  return z.string().max(Math.ceil(max * 4 / 3)).regex(/^[A-Za-z0-9_-]+$/).refine(value => {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= min && bytes.length <= max && bytes.toString('base64url') === value;
  }, 'Invalid canonical base64url.');
}
export const v3Scope = z.strictObject({ projectId: uuid, environment, keyId: uuid });
export const v3Envelope = z.strictObject({
  format: z.literal(3), scope: v3Scope, iv: base64(12, 12), ciphertext: base64(16, 712_500),
  encoding: z.literal('gzip'), plainBytes: z.number().int().min(0).max(32 * 1024 * 1024)
}).refine(value => Buffer.byteLength(canonical(value)) <= 950_000, 'Envelope exceeds 950000 bytes.')
  .refine(value => coreValid('validateEnvelope', value), 'Invalid v3 envelope.');
export const v3Bundle = z.strictObject({ id: hex, data: v3Envelope })
  .refine(value => value.id === hash(canonical(value.data)), 'Envelope hash does not match.');
export const v3Release = z.strictObject({
  format: z.literal(3), scope: v3Scope, manifest: v3Envelope,
  bundles: z.array(hex).min(1).max(2000), recordCount: z.number().int().min(1).max(2000)
}).refine(value => canonical(value.scope) === canonical(value.manifest.scope) &&
  new Set(value.bundles).size === value.bundles.length, 'Release scope or bundle list is invalid.')
  .refine(value => coreValid('validateRelease', value), 'Invalid v3 release.');
export const v3PublicKey = z.strictObject({ kty: z.literal('RSA'), n: base64(256, 512), e: z.literal('AQAB'),
  alg: z.literal('RSA-OAEP-256').optional(), ext: z.boolean().optional(), key_ops: z.array(z.literal('encrypt')).max(1).optional() });
const sealed = { iv: base64(12, 12), ciphertext: base64(16, 16400) };
export const v3Vault = z.strictObject({
  format: z.literal(3), publicKey: v3PublicKey, fingerprint: hex,
  password: z.strictObject({ ...sealed, kdf: z.strictObject({
    name: z.literal('PBKDF2'), hash: z.literal('SHA-256'), iterations: z.number().int().min(600000).max(2000000), salt: base64(16, 16)
  }) }), recovery: z.strictObject(sealed)
}).refine(value => value.fingerprint === hash(canonical({ e: value.publicKey.e, kty: value.publicKey.kty, n: value.publicKey.n })),
  'Public key fingerprint does not match.').refine(value => coreValid('validateVault', value), 'Invalid v3 vault.');
export const v3Grant = z.strictObject({ format: z.literal(3), scope: v3Scope, recipient: hex, wrappedKey: base64(256, 512) })
  .refine(value => coreValid('validateGrant', value), 'Invalid v3 grant.');
export type V3Scope = z.infer<typeof v3Scope>;
export type V3Release = z.infer<typeof v3Release>;
export class DocumentationV3Error extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new DocumentationV3Error(status, message); };
const target = {
  project: z.string().min(1).max(120).optional(), workspace: uuid.optional(), environment: environment.optional(),
  siteToken: z.string().regex(/^dsite_[A-Za-z0-9_-]{43}$/).optional(), idToken: z.string().min(1).max(8192).optional()
};
const source = z.strictObject({ environment, releaseId: uuid });
export const v3Request = z.discriminatedUnion('action', [
  z.strictObject({ ...target, action: z.literal('access') }),
  z.strictObject({ ...target, action: z.literal('vault.get') }),
  z.strictObject({ ...target, action: z.enum(['vault.create', 'vault.update']), vault: v3Vault }),
  z.strictObject({ ...target, action: z.literal('recipients') }),
  z.strictObject({ ...target, action: z.literal('grant.get'), scope: v3Scope.optional() }),
  z.strictObject({ ...target, action: z.literal('grant.put'), scope: v3Scope, userId: uuid, grant: v3Grant }),
  z.strictObject({ ...target, action: z.literal('grant.delete'), scope: v3Scope, userId: uuid }),
  z.strictObject({ ...target, action: z.literal('head') }),
  z.strictObject({ ...target, action: z.literal('usage.put'), visits: z.array(visitEntry).min(1).max(20) }),
  z.strictObject({ ...target, ...feedbackTarget, action: z.literal('feedback.get') }),
  z.strictObject({ ...target, ...feedbackTarget, action: z.literal('feedback.put'), helpful: z.boolean(),
    changeId: uuid, changedAt: z.number().int().nonnegative() }),
  z.strictObject({ ...target, action: z.literal('issues.list'), environment }),
  z.strictObject({ ...target, action: z.literal('issues.create'), environment, type: z.enum(['issue', 'faq']), text: z.string().max(4000),
    page: z.strictObject({ route: z.string().min(1).max(512), title: z.string().min(1).max(256), excerpt: z.string().max(3000).optional() }).optional() }),
  z.strictObject({ ...target, action: z.literal('issues.reply'), environment, id: uuid, text: z.string().max(4000) }),
  z.strictObject({ ...target, action: z.literal('issues.attachment'), environment, id: uuid, attachment: uuid }),
  z.strictObject({ ...target, action: z.literal('issues.attach'), environment, id: uuid, name: z.string().max(200), type: z.string().max(40),
    data: z.string().max(3 * 1024 * 1024) }),
  z.strictObject({ ...target, action: z.literal('profile.stats') }),
  z.strictObject({ ...target, action: z.literal('orbit.ask'), environment, releaseId: uuid,
    question: z.string().trim().min(3).max(1000) }),
  z.strictObject({ ...target, action: z.literal('key.get'), scope: v3Scope }),
  z.strictObject({ ...target, action: z.literal('snapshot.get') }),
  z.strictObject({ ...target, action: z.literal('snapshot.publish'), records: z.array(z.unknown()).min(1).max(2000),
    expected: z.union([uuid, z.literal('empty')]), confirmed: z.literal(true), approveConversion: z.boolean().optional(),
    version: z.string().min(1).max(64), tags: z.array(z.enum(['New', 'Changed', 'Hotfix'])).min(1).max(3),
    summary: z.string().trim().min(1).max(4000), rotate: z.boolean().optional() }),
  z.strictObject({ ...target, action: z.literal('release.get'), releaseId: uuid }),
  z.strictObject({ ...target, action: z.literal('bundle.get'), id: hex, releaseId: uuid }),
  z.strictObject({ ...target, action: z.literal('bundle.put'), bundle: v3Bundle }),
  z.strictObject({ ...target, action: z.literal('publish'), releaseId: uuid, expected: z.union([uuid, z.literal('empty')]),
    release: v3Release, expectedSource: source.optional() })
]);
export const v3Access = z.object({
  projectId: uuid, name: z.string(), role: z.enum(['owner', 'admin', 'author', 'viewer', 'none']),
  environments: z.array(environment), userId: uuid.nullable(), email: z.string(), administrator: z.boolean(),
  reader: z.string().nullable().optional(), team: z.string().max(80).nullable().optional(), firebaseProject: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  readerUid: z.string().min(1).max(128).optional(), displayName: z.string().max(256).optional(),
  serviceAccountKey: z.string().min(1)
});
export type V3Access = z.infer<typeof v3Access>;
type Rpc = (name: string, body: unknown) => Promise<unknown>;
export interface V3Store extends FirestoreReader {
  immutable(path: string, data: Record<string, unknown>): Promise<void>;
  publish(input: { releaseId: string; expected: string; release: V3Release;
    expectedSource?: { environment: z.infer<typeof environment>; releaseId: string; legacy?: boolean } | undefined;
    expectedLegacy?: string | undefined; actor?: string | undefined; sourceBaselines?: SourceBaseline[] | undefined }): Promise<number>;
  registerSourceBaselines?(record: SourceBaselineRecord): Promise<SourceBaselineRecord>;
}
/** Who published a release and when, kept in plaintext next to it because the encrypted metadata has no author. */
export const v3Audit = z.object({ releaseId: uuid, actor: z.string(), createdAt: z.string() });
const headSchema = z.strictObject({ releaseId: uuid, generation: z.number().int().positive(), keyId: uuid, format: z.literal(3) });

/** Exported migration guard for all hosted legacy readers/writers. Direct customer SDKs need matching rules. */
export async function assertNotMigrated(reader: FirestoreReader, env: string): Promise<void> {
  if (await reader.get('documentationV3Environments/' + env)) fail(409, 'This environment requires the encrypted v3 client. Plaintext access is disabled.');
}

function encode(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, encode(v)])) } };
}
export function createV3FirestoreStore(access: V3Access, fetchService: typeof fetch = fetch): V3Store {
  const tokens = serviceAccountTokens(access.serviceAccountKey, fetchService);
  const reader = createFirestoreReader(access.firebaseProject, tokens, fetchService);
  const root = 'projects/' + access.firebaseProject + '/databases/(default)/documents';
  const database = 'https://firestore.googleapis.com/v1/projects/' + access.firebaseProject + '/databases/(default)';
  async function call(path: string, body: unknown) {
    const response = await fetchService(database + path, { method: 'POST',
      headers: { Authorization: 'Bearer ' + await tokens(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(response.status === 409 ? 409 : 503, response.status === 409 ? 'Concurrent publication; reload the current head.' : 'Encrypted storage is unavailable.');
    const result = await response.json() as Record<string, unknown>;
    if (path === '/documents:commit') await applyFirestoreCommit(access.firebaseProject, (body as { writes: RestWrite[] }).writes, result);
    return result;
  }
  const write = (path: string, data: Record<string, unknown>, exists?: boolean) => ({
    update: { name: root + '/' + path, fields: (encode(data).mapValue as { fields: unknown }).fields },
    ...(exists === undefined ? {} : { currentDocument: { exists } })
  });
  return {
    ...reader,
    async immutable(path, data) {
      const before = await reader.get(path);
      if (before) { if (canonical(before.data) !== canonical(data)) fail(409, 'Immutable ID already contains different data.'); return; }
      try { await call('/documents:commit', { writes: [write(path, data, false)] }); }
      catch (error) {
        if (!(error instanceof DocumentationV3Error && error.status === 409)) throw error;
        const winner = await reader.get(path, { fresh: true });
        if (!winner || canonical(winner.data) !== canonical(data)) throw error;
      }
    },
    async publish(input) {
      const transaction = z.string().parse((await call('/documents:beginTransaction', {})).transaction);
      try {
        // Every immutable document and pointer is read inside the transaction before any write.
        const paths = ['documentationV3Environments/' + input.release.scope.environment,
          'documentationV3Releases/' + input.releaseId,
          'documentationV3History/' + input.release.scope.environment,
          ...(input.expectedSource ? [(input.expectedSource.legacy ? 'documentationEnvironments/' : 'documentationV3Environments/') + input.expectedSource.environment] : []),
          ...(input.expectedLegacy ? ['documentationEnvironments/' + input.release.scope.environment] : [])];
        const response = await call('/documents:batchGet', { documents: paths.map(path => root + '/' + path), transaction });
        // Firestore batchGet REST is a JSON array, despite the general call return type.
        const entries = response as unknown as { found?: { name: string; fields: Record<string, unknown> }; missing?: string }[];
        const { decodeFields } = await import('./firestore.js');
        const docs = new Map(entries.filter(entry => entry.found).map(entry =>
          [entry.found!.name.slice(root.length + 1), decodeFields(entry.found!.fields as Parameters<typeof decodeFields>[0])]));
        const pointer = docs.get(paths[0]!);
        if ((pointer?.releaseId ?? 'empty') !== input.expected) fail(409, 'The current release changed. Reload before publishing.');
        if (input.expectedLegacy && (pointer || (docs.get('documentationEnvironments/' + input.release.scope.environment)?.releaseId ?? 'empty') !== input.expectedLegacy)) {
          fail(409, 'The legacy release changed. Reload and review the migration again.');
        }
        if (pointer) {
          const previousId = headSchema.parse(pointer).releaseId;
          const previous = await call('/documents:batchGet', {
            transaction, documents: [root + '/documentationV3Releases/' + previousId], mask: { fieldPaths: ['scope'] }
          }) as unknown as typeof entries;
          const previousScope = previous[0]?.found ?
            v3Scope.parse(decodeFields(previous[0].found.fields as Parameters<typeof decodeFields>[0]).scope) : null;
          if (!previousScope || previousScope.projectId !== input.release.scope.projectId ||
              previousScope.environment !== input.release.scope.environment) fail(403, 'Existing environment belongs to another project scope.');
        }
        if (docs.has(paths[1]!)) fail(409, 'Release IDs are immutable; choose a new release ID.');
        const staged = await call('/documents:batchGet', { transaction,
          documents: input.release.bundles.map(id => root + '/documentationV3Bundles/' + id), mask: { fieldPaths: ['scope'] } });
        const stagedEntries = staged as unknown as typeof entries;
        if (stagedEntries.length !== input.release.bundles.length) fail(400, 'Staged bundles are missing.');
        const stagedByName = new Map(stagedEntries.filter(entry => entry.found).map(entry => [entry.found!.name, entry.found!]));
        for (const id of input.release.bundles) {
          const found = stagedByName.get(root + '/documentationV3Bundles/' + id);
          if (!found || canonical(decodeFields(found.fields as Parameters<typeof decodeFields>[0]).scope) !== canonical(input.release.scope)) {
            fail(400, 'Staged bundle is missing or its scope does not match.');
          }
        }
        if (input.expectedSource && docs.get((input.expectedSource.legacy ? 'documentationEnvironments/' : 'documentationV3Environments/') +
            input.expectedSource.environment)?.releaseId !== input.expectedSource.releaseId) {
          fail(409, 'The source release changed.');
        }
        const generation = pointer ? headSchema.parse(pointer).generation + 1 : 1;
        const history = docs.get('documentationV3History/' + input.release.scope.environment);
        const previousReleases = history ? z.object({ projectId: uuid, environment, releases: z.array(uuid).max(100) }).parse(history) : null;
        if (previousReleases && (previousReleases.projectId !== input.release.scope.projectId ||
            previousReleases.environment !== input.release.scope.environment)) fail(403, 'History belongs to another project scope.');
        const releases = [...new Set([input.releaseId, ...(pointer ? [headSchema.parse(pointer).releaseId] : []),
          ...(previousReleases?.releases ?? [])])].slice(0, 100);
        await call('/documents:commit', { transaction, writes: [
          write(paths[1]!, input.release, false),
          write(paths[0]!, { format: 3, releaseId: input.releaseId, generation, keyId: input.release.scope.keyId }),
          write('documentationV3History/' + input.release.scope.environment, {
            format: 3, projectId: input.release.scope.projectId, environment: input.release.scope.environment, releases
          }),
          ...(input.actor ? [write('documentationV3Audit/' + input.releaseId,
            { releaseId: input.releaseId, actor: input.actor, createdAt: new Date().toISOString() }, false)] : []),
          ...(input.sourceBaselines?.length ? [write('documentationV3SourceBaselines/' + input.releaseId, sourceBaselineRecord.parse({
            version: 1, projectId: input.release.scope.projectId, environment: input.release.scope.environment,
            releaseId: input.releaseId, repositories: input.sourceBaselines, recordedAt: new Date().toISOString(), recordedBy: input.actor ?? 'mcp'
          }), false)] : [])
        ] });
        return generation;
      } finally {
        await call('/documents:rollback', { transaction }).catch(() => undefined);
      }
    },
    async registerSourceBaselines(value) {
      const record = sourceBaselineRecord.parse(value);
      if (record.projectId !== access.projectId || !access.environments.includes(record.environment)) fail(403, 'Baseline scope is not authorized.');
      const transaction = z.string().parse((await call('/documents:beginTransaction', {})).transaction);
      try {
        const pointerPath = 'documentationV3Environments/' + record.environment;
        const baselinePath = 'documentationV3SourceBaselines/' + record.releaseId;
        const paths = [pointerPath, 'documentationV3Releases/' + record.releaseId, baselinePath];
        const entries = await call('/documents:batchGet', {documents: paths.map(path => root + '/' + path), transaction}) as unknown as
          {found?: {name: string; fields: Record<string, unknown>}}[];
        const {decodeFields} = await import('./firestore.js');
        const docs = new Map(entries.filter(entry => entry.found).map(entry => [entry.found!.name.slice(root.length + 1),
          decodeFields(entry.found!.fields as Parameters<typeof decodeFields>[0])]));
        if (docs.get(pointerPath)?.releaseId !== record.releaseId) fail(409, 'The documentation release changed. Reload before recording its source baseline.');
        const scope = v3Scope.parse(docs.get(paths[1]!)?.scope);
        if (scope.projectId !== record.projectId || scope.environment !== record.environment) fail(403, 'Baseline does not match the published release scope.');
        const existing = docs.get(baselinePath);
        if (existing) {
          const previous = sourceBaselineRecord.parse(existing);
          if (previous.projectId !== record.projectId || previous.environment !== record.environment || previous.releaseId !== record.releaseId) fail(403, 'Baseline scope does not match the published release.');
          let repositories: SourceBaseline[];
          try { repositories = addSourceBaselineTags(previous.repositories, record.repositories); }
          catch (error) { return fail(409, error instanceof Error ? error.message : 'Conflicting source baseline.'); }
          if (canonical(repositories) === canonical(previous.repositories)) return previous;
          const updated = sourceBaselineRecord.parse({...previous, repositories, updatedAt: record.recordedAt, updatedBy: record.recordedBy});
          await call('/documents:commit', {transaction, writes: [write(baselinePath, updated, true)]});
          return updated;
        }
        await call('/documents:commit', {transaction, writes: [write(baselinePath, record, false)]});
        return record;
      } finally {
        await call('/documents:rollback', {transaction}).catch(() => undefined);
      }
    }
  };
}

export async function readV3Body(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > V3_REQUEST_BYTES)) fail(413, 'Encrypted request is too large.');
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(415, 'Use application/json.');
  const encoding = req.headers['content-encoding']?.trim().toLowerCase();
  if (encoding && encoding !== 'identity' && encoding !== 'gzip') fail(415, 'Use gzip or no content encoding.');
  let text = '';
  // A gzip body (the encryption page compresses large snapshots so they fit the hosting request limit) is read
  // raw, never through a pre-parsed body, and may unpack to at most V3_REQUEST_BYTES.
  if (encoding === 'gzip') {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length; if (size > V3_REQUEST_BYTES) fail(413, 'Encrypted request is too large.');
      chunks.push(bytes);
    }
    try { text = gunzipSync(Buffer.concat(chunks), { maxOutputLength: V3_REQUEST_BYTES }).toString('utf8'); }
    catch (error) {
      if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') fail(413, 'Encrypted request is too large.');
      fail(400, 'Invalid gzip body.');
    }
  } else if (req.body !== undefined) {
    try { text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body); }
    catch { fail(400, 'Invalid JSON body.'); }
  } else {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length; if (size > V3_REQUEST_BYTES) fail(413, 'Encrypted request is too large.');
      chunks.push(bytes);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof text !== 'string' || Buffer.byteLength(text) > V3_REQUEST_BYTES) fail(413, 'Encrypted request is too large.');
  try { return JSON.parse(text); } catch { return fail(400, 'Invalid JSON body.'); }
}

export function createDocumentationV3(options: {
  rpc: Rpc;
  authenticate(req: IncomingMessage, res: ServerResponse, input: z.infer<typeof v3Request>): Promise<V3Access | Pick<V3Access, 'userId'>>;
  preflight?(req: IncomingMessage): Promise<string | null>;
  store?: (access: V3Access) => V3Store;
  cache?: ReturnType<typeof createCiphertextCache>;
  releaseCacheSigningKey?: string;
  managed?: (access: V3Access, input: z.infer<typeof v3Request>) => Promise<unknown>;
  telemetry?: (access: V3Access, input: z.infer<typeof v3Request>) => Promise<unknown>;
  issues?: (access: V3Access, input: z.infer<typeof v3Request>) => Promise<unknown>;
  profile?: (access: V3Access) => Promise<unknown>;
  orbit?: (access: V3Access, input: { environment: z.infer<typeof environment>; question: string; releaseId: string }) => Promise<unknown>;
  allowedOrigins: ReadonlySet<string>;
}) {
  const cache = options.cache ?? createCiphertextCache();
  const releaseCacheSigningKey = options.releaseCacheSigningKey ?? randomBytes(32).toString('hex');
  return async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Origin');
    const answer = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'OPTIONS') {
        const origin = await options.preflight?.(req);
        if (!origin) return answer(403, { error: 'Unregistered site origin.' });
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '300');
        return answer(204, null);
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return answer(405, { error: 'Use POST.' }); }
      const input = v3Request.parse(await readV3Body(req));
      const origin = req.headers.origin;
      if (!input.siteToken && origin && !options.allowedOrigins.has(origin)) fail(403, 'Untrusted Origin header.');
      const identity = await options.authenticate(req, res, input);
      if (input.siteToken && origin) res.setHeader('Access-Control-Allow-Origin', origin);
      if (input.siteToken && !['access', 'head', 'bundle.get', 'key.get', 'snapshot.get', 'usage.put', 'feedback.get', 'feedback.put', 'issues.list', 'issues.create', 'issues.reply', 'issues.attach', 'issues.attachment', 'profile.stats', 'orbit.ask'].includes(input.action)) {
        fail(403, 'Website credentials provide read-only documentation access.');
      }
      if (input.action === 'profile.stats') {
        if (!input.siteToken || !options.profile) fail(403, 'Profile statistics are shown on the documentation website.');
        return answer(200, await options.profile!(v3Access.parse(identity)));
      }
      if (input.action === 'orbit.ask') {
        if (!input.siteToken || !options.orbit) fail(403, 'Workflow Orbit is available from the documentation website.');
        return answer(200, await options.orbit!(v3Access.parse(identity), input));
      }
      if (input.action === 'issues.list' || input.action === 'issues.create' || input.action === 'issues.reply' || input.action === 'issues.attach' || input.action === 'issues.attachment') {
        if (!input.siteToken || !options.issues) fail(403, 'Issues are raised from the documentation website.');
        return answer(200, await options.issues!(v3Access.parse(identity), input));
      }
      if (['usage.put', 'feedback.get', 'feedback.put'].includes(input.action)) {
        if (!input.siteToken || !options.telemetry) fail(403, 'Reader telemetry requires verified website credentials.');
        return answer(200, await options.telemetry!(v3Access.parse(identity), input));
      }
      if (['key.get', 'snapshot.get', 'snapshot.publish'].includes(input.action)) {
        const access = v3Access.parse(identity);
        if (!options.managed) fail(503, 'Server-managed encryption is not configured.');
        return answer(200, await options.managed!(access, input));
      }
      if (input.action === 'vault.get') return answer(200, { vault: z.union([v3Vault, z.null()]).parse(await options.rpc('mcp_v3_vault_get', { member: identity.userId })) });
      if (input.action === 'vault.create' || input.action === 'vault.update') {
        await options.rpc('mcp_v3_vault_save', { member: identity.userId, value: input.vault, creating: input.action === 'vault.create' });
        return answer(200, { ok: true });
      }
      const access = v3Access.parse(identity);
      const chosenEnv = input.environment ?? ('scope' in input ? input.scope?.environment : undefined) ??
        (input.action === 'bundle.put' ? input.bundle.data.scope.environment : input.action === 'publish' ? input.release.scope.environment : undefined) ?? access.environments[0];
      if (!chosenEnv || !access.environments.includes(chosenEnv)) return fail(403, 'Environment access denied.');
      const env = chosenEnv;
      const admin = ['owner', 'admin'].includes(access.role);
      const writer = admin || access.role === 'author' && env === 'development';
      const checkScope = (scope: V3Scope) => {
        if (scope.projectId !== access.projectId || scope.environment !== env) fail(403, 'Scope does not match the authorized project and environment.');
      };
      const rpcTarget = { member: access.userId, project: access.projectId, env };
      if (input.action === 'access') {
        const { serviceAccountKey: _key, firebaseProject: _firebase, ...publicAccess } = access;
        return answer(200, { access: publicAccess });
      }
      if (input.action === 'recipients') {
        if (!admin) fail(403, 'Only owners and admins manage recipients.');
        const recipients = z.array(z.object({ userId: uuid, email: z.string(), publicKey: v3PublicKey, fingerprint: hex }))
          .parse(await options.rpc('mcp_v3_recipients', rpcTarget));
        return answer(200, { recipients });
      }
      const store = (options.store ?? createV3FirestoreStore)(access);
      const repository = createV3Repository(access, env, store, cache, releaseCacheSigningKey);
      const readRelease = repository.readRelease;
      if (input.action === 'grant.put' || input.action === 'grant.delete') {
        if (!admin) fail(403, 'Only owners and admins manage grants.');
        checkScope(input.scope);
        if (input.action === 'grant.put') {
          checkScope(input.grant.scope);
          if (canonical(input.scope) !== canonical(input.grant.scope)) fail(400, 'Grant scope does not match.');
        }
        await options.rpc('mcp_v3_grant_save', { ...rpcTarget, recipient_user: input.userId, scope: input.scope,
          value: input.action === 'grant.put' ? input.grant : null });
        return answer(200, { ok: true, ...(input.action === 'grant.delete' ? { warnings: ['Revocation cannot erase downloaded keys. Rotate the environment key and republish ciphertext.'] } : {}) });
      }
      if (input.action === 'grant.get') {
        let scope = input.scope;
        if (!scope) {
          const head = await store.get('documentationV3Environments/' + env);
          if (!head) return answer(200, { grant: null });
          scope = { projectId: access.projectId, environment: env, keyId: headSchema.parse(head.data).keyId };
        }
        checkScope(scope!);
        const grant = z.union([v3Grant, z.null()]).parse(await options.rpc('mcp_v3_grant_get', { ...rpcTarget, scope }));
        if (grant && canonical(grant.scope) !== canonical(scope)) fail(502, 'Stored grant scope is invalid.');
        return answer(200, { grant });
      }
      if (input.action === 'bundle.put') {
        if (!writer) fail(403, 'Publishing is not allowed in this environment.');
        checkScope(input.bundle.data.scope);
        await store.immutable('documentationV3Bundles/' + input.bundle.id, input.bundle.data);
        const warnings = await cache.set(ciphertextCacheKey(access.firebaseProject, access.projectId, env, input.bundle.id), input.bundle);
        return answer(200, { ok: true, ...(warnings.length ? { warnings } : {}) });
      }
      if (input.action === 'publish') {
        if (!writer) fail(403, 'Publishing is not allowed in this environment.');
        checkScope(input.release.scope);
        const pointer = await store.get('documentationV3Environments/' + env);
        const currentKeyId = pointer ? headSchema.parse(pointer.data).keyId : input.release.scope.keyId;
        if (await store.get('documentationV3ManagedKeys/' + currentKeyId) ||
            currentKeyId !== input.release.scope.keyId && await store.get('documentationV3ManagedKeys/' + input.release.scope.keyId)) {
          fail(409, 'Use hosted managed publication for this environment; raw ciphertext publication cannot replace a managed release.');
        }
        if (input.expectedSource && !access.environments.includes(input.expectedSource.environment)) fail(403, 'Source environment access denied.');
        const generation = await store.publish(input);
        const warnings = await repository.saveRelease(input.releaseId, input.release);
        return answer(200, { releaseId: input.releaseId, generation, ...(warnings.length ? { warnings } : {}) });
      }
      if (input.action === 'release.get') {
        const release = await readRelease(input.releaseId);
        return answer(200, { release });
      }
      if (input.action === 'head') {
        const pointer = await store.get('documentationV3Environments/' + env);
        if (!pointer) return answer(200, { head: null, release: null });
        const head = headSchema.parse(pointer.data);
        const release = await readRelease(head.releaseId);
        if (head.keyId !== release.scope.keyId) fail(502, 'Encrypted pointer key does not match.');
        const { format: _format, ...publicHead } = head;
        return answer(200, { head: publicHead, release });
      }
      if (input.action === 'bundle.get') {
        const bundle = await repository.readBundle(input.id, input.releaseId);
        return answer(200, { bundle });
      }
      return answer(400, { error: 'Unknown encrypted documentation action.' });
    } catch (error) {
      if (error instanceof z.ZodError) return answer(400, { error: 'Invalid encrypted documentation payload.' });
      if (error instanceof DocumentationV3Error || error instanceof FirestoreAccessError) return answer(error.status, {
        error: error.message, ...(/personal E2EE key/.test(error.message) ? { code: 'managed-key-missing' } : {})
      });
      console.error('Encrypted documentation request failed.');
      return answer(503, { error: 'Encrypted documentation is temporarily unavailable.' });
    }
  };
}
