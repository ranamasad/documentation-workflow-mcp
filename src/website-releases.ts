import { createRequire } from 'node:module';
import { z } from 'zod';
import { applyFirestoreCommit, FirestoreAccessError, serviceAccountTokens, type RestWrite, type TokenSource } from './firestore.js';
import { websiteState, WebsiteAccessError } from './website-access.js';
import type { ProjectStore } from './project-store.js';
import { assertPublicationQuality, createDocumentationPublisher, PublishError } from './publish.js';
import type { RecordData } from './v3-client.js';

// Promote and roll back documentation releases from the dashboard, with the website's own release engine
// (vendored). This adapter mirrors the docs-site CLI's IAM adapter: every write is create-only and
// validated before it is sent (a service account bypasses security rules), and the environment pointer
// moves in one Firestore transaction that re-checks both the target and the source release.

type Rpc = (name: string, body: unknown) => Promise<unknown>;
type Fetch = typeof fetch;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Stored { data: Record<string, unknown>; token?: string }
interface Snapshot { environment: string; head: { data: { releaseId: string; generation: number } } | null; release: Record<string, unknown> | null; manifest: Record<string, string> }
interface Engine {
  hash(payload: string): Promise<string>;
  open(adapter: unknown, environment: string): Promise<Snapshot>;
  load(adapter: unknown, environment: string): Promise<Snapshot & { records: RecordData[] }>;
  publish(adapter: unknown, options: Record<string, unknown>): Promise<{ releaseId: string; count: number; stats: Record<string, number> }>;
  release(value: unknown, environment: string): Record<string, string>;
  pointer(value: unknown): void;
  expected(snapshot: { head: Stored | null }, id: string): void;
  discovery: { validateEnvelope(path: string, value: unknown): unknown; equal(left: unknown, right: unknown): boolean };
}
interface Model { record(value: unknown): { key: string; title: string }; environment(value: string): string }
const require = createRequire(import.meta.url);
const engine: Engine = require('../vendor/documentation-engine.js');
const model: Model = require('../vendor/documentation-model.js');

const REQUEST_TIME = '__REQUEST_TIME__';
const REVISION = /^(?:documentationRevisions|documentationEnvironments\/(?:development|beta|production)\/revisions)\/([a-f0-9]{64})$/;

function encode(value: Json): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)])) } };
}
function decode(value: Record<string, unknown>): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return ((value.arrayValue as { values?: Record<string, unknown>[] }).values ?? []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries((value.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {}).map(([key, entry]) => [key, decode(entry)]));
  throw new FirestoreAccessError(502, 'Firestore returned an unsupported value type.');
}
const stored = (document: { fields?: Record<string, Record<string, unknown>>; updateTime?: string }): Stored =>
  ({ data: Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decode(value)])), ...(document.updateTime ? { token: document.updateTime } : {}) });

/** The release engine's storage adapter over Firestore REST, acting as `actor`. */
export function releaseAdapter(projectId: string, tokens: TokenSource, actor: string, fetchService: Fetch = fetch, endpoint = 'https://firestore.googleapis.com') {
  const database = 'projects/' + projectId + '/databases/(default)';
  const base = endpoint + '/v1/' + database + '/documents';
  const name = (locator: string) => database + '/documents/' + locator;
  async function call(url: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetchService(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Bearer ' + await tokens(), 'Content-Type': 'application/json' } });
    } catch (error) {
      if (error instanceof TypeError || (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))) throw new FirestoreAccessError(503, 'Firestore is temporarily unreachable. Please retry.');
      throw error;
    }
    return response;
  }
  async function failure(response: Response) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (response.status === 401 || response.status === 403) return new FirestoreAccessError(403, 'The service account cannot write documentation releases. Give it the Cloud Datastore User role in project ' + projectId + '.');
    return new FirestoreAccessError(response.status === 409 || response.status === 412 ? 409 : 502,
      'Firestore rejected the release (' + response.status + (body?.error?.message ? ': ' + body.error.message.slice(0, 200) : '') + ').');
  }
  async function get(locator: string, transaction?: string): Promise<Stored | null> {
    const environment = /^documentationEnvironments\/(development|beta|production)$/.exec(locator)?.[1];
    if (environment && await get('documentationV3Environments/' + environment, transaction)) {
      throw new FirestoreAccessError(409, 'This environment uses contract-v3. Use the managed MCP release workflow.');
    }
    const response = await call(base + '/' + locator + (transaction ? '?transaction=' + encodeURIComponent(transaction) : ''));
    if (response.status === 404) return null;
    if (!response.ok) throw await failure(response);
    return stored(await response.json());
  }
  function write(locator: string, data: Record<string, unknown>, precondition: Record<string, unknown>) {
    const fields = { ...data } as Record<string, Json>;
    const transforms: { fieldPath: string; setToServerValue: string }[] = [];
    for (const [key, value] of Object.entries(fields)) if (value === REQUEST_TIME) { delete fields[key]; transforms.push({ fieldPath: key, setToServerValue: 'REQUEST_TIME' }); }
    return { update: { name: name(locator), fields: (encode(fields) as { mapValue: { fields: unknown } }).mapValue.fields }, currentDocument: precondition,
      ...(transforms.length ? { updateTransforms: transforms } : {}) };
  }
  async function commit(body: Record<string, unknown>) {
    const response = await call(base + ':commit', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw await failure(response);
    await applyFirestoreCommit(projectId, (body.writes ?? []) as RestWrite[], await response.json().catch(() => null), endpoint);
  }
  async function batchRead(locators: string[], pattern: RegExp) {
    if (locators.length > 90 || new Set(locators).size !== locators.length || locators.some(locator => !pattern.test(locator))) throw new Error('Invalid documentation batch');
    const found = new Map<string, Stored | null>();
    await Promise.all(Array.from({ length: Math.ceil(locators.length / 30) }, async (_, index) => {
      const group = locators.slice(index * 30, index * 30 + 30);
      const response = await call(base + ':batchGet', { method: 'POST', body: JSON.stringify({ documents: group.map(name) }) });
      if (!response.ok) throw await failure(response);
      for (const message of await response.json() as { found?: { name: string; fields?: Record<string, Record<string, unknown>>; updateTime?: string }; missing?: string }[]) {
        const location = (message.found?.name ?? message.missing ?? '').replace(database + '/documents/', '');
        if (!group.includes(location) || found.has(location)) throw new Error('Unexpected or duplicate documentation batch result');
        found.set(location, message.found ? stored(message.found) : null);
      }
      if (group.some(location => !found.has(location))) throw new Error('Incomplete documentation batch');
    }));
    return locators.map(location => found.get(location) ?? null);
  }
  return {
    actor, get, timestamp: () => REQUEST_TIME, environmentBatches: true,
    getMany: (locators: string[]) => batchRead(locators, REVISION),
    getDiscoveryShards: (locators: string[]) => batchRead(locators, /^documentationDiscovery\/[a-f0-9]{64}\/shards\/[0-9]{4}$/),
    async create(locator: string, data: Record<string, unknown>) {
      // A service account bypasses security rules: validate the same immutable envelopes before every write.
      const revision = REVISION.exec(locator);
      if (revision) {
        const parsed = model.record(JSON.parse(String(data.payload)));
        if (Object.keys(data).sort().join() !== 'key,payload,schema,title' || data.schema !== 1 || parsed.key !== data.key || parsed.title !== data.title ||
            await engine.hash(String(data.payload)) !== revision[1]) throw new Error('Revision hash/schema mismatch');
      } else if (locator.startsWith('documentationDiscovery/')) {
        engine.discovery.validateEnvelope(locator, data);
      } else if (locator.startsWith('documentationReleases/')) {
        engine.release(data, String(data.environment));
        if (data.actor !== actor || data.createdAt !== REQUEST_TIME) throw new Error('Invalid release audit identity');
      } else throw new Error('Unexpected write collection');
      const previous = await get(locator);
      if (previous) {
        if ((revision || locator.startsWith('documentationDiscovery/')) && engine.discovery.equal(previous.data, data)) return;
        throw new Error('Immutable object conflict');
      }
      try { await commit({ writes: [write(locator, data, { exists: false })] }); }
      catch (error) {
        const raced = await get(locator);
        if ((revision || locator.startsWith('documentationDiscovery/')) && raced && engine.discovery.equal(raced.data, data)) return;
        throw error;
      }
    },
    async advance(target: Snapshot, source: Snapshot | null, releaseId: string) {
      const started = await call(base + ':beginTransaction', { method: 'POST', body: JSON.stringify({ options: { readWrite: {} } }) });
      if (!started.ok) throw await failure(started);
      const { transaction } = await started.json() as { transaction: string };
      try {
        const locator = 'documentationEnvironments/' + model.environment(target.environment);
        const previous = await get(locator, transaction);
        engine.expected({ head: previous }, target.head?.data.releaseId ?? 'empty');
        if (source) engine.expected({ head: await get('documentationEnvironments/' + model.environment(source.environment), transaction) }, source.head!.data.releaseId);
        const release = await get('documentationReleases/' + releaseId, transaction);
        engine.release(release?.data, target.environment);
        if (release!.data.base !== (previous ? String(previous.data.releaseId) : '')) throw new Error('Release base conflict');
        const data = { releaseId, generation: (previous ? Number(previous.data.generation) : 0) + 1, updatedAt: REQUEST_TIME };
        engine.pointer(data);
        await commit({ transaction, writes: [write(locator, data, previous?.token ? { updateTime: previous.token } : { exists: false })] });
      } catch (error) {
        await call(base + ':rollback', { method: 'POST', body: JSON.stringify({ transaction }) }).catch(() => undefined);
        throw error;
      }
    },
    /** Delete one environment's older (v1/v2) documentation once encrypted v3 replaced it. Shared revisions go when no environment still reads them. */
    async retireLegacy(environment: string) {
      const exists = async (locator: string) => {
        const response = await call(base + '/' + locator);
        if (response.status === 404) return false;
        if (!response.ok) throw await failure(response);
        return true;
      };
      const list = async (collection: string) => {
        const documents: { locator: string; data: Record<string, unknown> }[] = [];
        let pageToken = '';
        for (let page = 0; page < 50; page++) {
          const response = await call(base + '/' + collection + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
          if (response.status === 404) break;
          if (!response.ok) throw await failure(response);
          const body = await response.json() as { documents?: { name: string; fields?: Record<string, Record<string, unknown>> }[]; nextPageToken?: string };
          for (const document of body.documents ?? []) documents.push({ locator: document.name.replace(database + '/documents/', ''), data: stored(document).data });
          if (!body.nextPageToken) break;
          pageToken = body.nextPageToken;
        }
        return documents;
      };
      const legacyLive = async (other: string) => await exists('documentationEnvironments/' + other) && !await exists('documentationV3Environments/' + other);
      if (!await exists('documentationV3Environments/' + environment)) throw new Error('Old documentation is deleted only after encrypted v3 replaced it.');
      const pointer = 'documentationEnvironments/' + model.environment(environment);
      const revisions = await list(pointer + '/revisions');
      const releases = (await list('documentationReleases')).filter(document => document.data.environment === environment);
      const live = await Promise.all(ENVIRONMENTS.filter(other => other !== environment).map(legacyLive));
      const shared = live.some(Boolean) ? [] : await list('documentationRevisions');
      const writes = [...revisions, ...releases, ...shared].map(document => ({ delete: name(document.locator) })).concat({ delete: name(pointer) });
      // Firestore applies at most 500 writes per commit; the pointer goes last so a partial clean-up can be repeated.
      for (let index = 0; index < writes.length; index += 450) await commit({ writes: writes.slice(index, index + 450) });
      return { environment, releases: releases.length, revisions: revisions.length + shared.length };
    },
    /** All releases of one environment, newest first (bounded). */
    async history(environment: string) {
      const releases: (Record<string, unknown> & { id: string })[] = [];
      let pageToken = '';
      for (let page = 0; page < 10; page++) {
        const response = await call(base + '/documentationReleases?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
        if (!response.ok) throw await failure(response);
        const body = await response.json() as { documents?: { name: string; fields?: Record<string, Record<string, unknown>> }[]; nextPageToken?: string };
        for (const document of body.documents ?? []) {
          const data = stored(document).data;
          if (data.environment === environment) releases.push({ id: document.name.split('/').pop()!, ...data });
        }
        if (!body.nextPageToken) break;
        pageToken = body.nextPageToken;
      }
      return releases.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    }
  };
}

const ENVIRONMENTS = ['development', 'beta', 'production'] as const;
const PROMOTIONS = ['development:beta', 'development:production', 'beta:production'];
const syncTarget = z.object({ firebaseProject: z.string().nullable(), serviceAccountKey: z.string().nullable() });
const releaseId = z.string().regex(/^[a-f0-9-]{36}$/);
const expectedId = z.union([z.literal('empty'), releaseId]);
const metadata = { version: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, 'Use a version of letters, digits, dots, dashes or underscores.').optional(),
  tags: z.array(z.enum(['Hotfix', 'New', 'Changed'])).min(1).max(3).optional(), summary: z.string().trim().min(1).max(4000).optional() };
const promoteInput = z.strictObject({ source: z.enum(ENVIRONMENTS), target: z.enum(ENVIRONMENTS), expected: expectedId, expectedSource: releaseId,
  acknowledgeMissing: z.boolean().default(false), ...metadata });
const rollbackInput = z.strictObject({ environment: z.enum(ENVIRONMENTS), expected: releaseId, rollbackRelease: releaseId,
  version: metadata.version.unwrap(), tags: metadata.tags.unwrap(), summary: metadata.summary.unwrap() });

const summary = (id: string, data: Record<string, unknown>) => ({ id, version: data.version, tags: data.tags, summary: data.summary, operation: data.operation,
  actor: data.actor, source: data.source, rollbackRelease: data.rollbackRelease, createdAt: data.createdAt,
  articles: typeof data.manifest === 'string' ? Math.max(0, Object.keys(JSON.parse(data.manifest) as object).length - 1) : null });

export function createWebsiteReleases(rpc: Rpc, fetchGoogle: Fetch, adapterFor?: (projectId: string, key: string, actor: string) => ReturnType<typeof releaseAdapter>,
  projectsFor?: (member: string) => ProjectStore) {
  const build = adapterFor ?? ((projectId: string, key: string, actor: string) => releaseAdapter(projectId, serviceAccountTokens(key, fetchGoogle), actor, fetchGoogle));
  // Owners and admins of the workspace (who manage website access) may publish.
  async function target(member: string, workspace: string, name: string, actor: string) {
    const state = websiteState.safeParse(await rpc('mcp_website_get', { member, workspace, project_name: name }));
    if (!state.success) throw new WebsiteAccessError(503, 'Account storage returned invalid website access.');
    const sync = syncTarget.safeParse(await rpc('mcp_website_sync_target', { project: state.data.projectId }));
    if (!sync.success || !sync.data.firebaseProject || !sync.data.serviceAccountKey) throw new WebsiteAccessError(400, 'Upload the project\'s service-account key first (project setup, step 3).');
    if (!actor) throw new WebsiteAccessError(400, 'Your account has no email address to record as the release author.');
    return build(sync.data.firebaseProject, sync.data.serviceAccountKey, actor.toLowerCase());
  }
  const failed = (error: unknown): never => {
    if (error instanceof PublishError) throw new WebsiteAccessError(error.status, error.message);
    if (error instanceof FirestoreAccessError) throw new WebsiteAccessError(error.status === 403 ? 400 : error.status, error.message);
    if (error instanceof Error && /^(Conflict|Invalid|Only|Source|Unpublished|Choose|Rollback|Immutable|Release|Revision|Missing|Environment|Explicit|select|a target|difference)/i.test(error.message)) {
      throw new WebsiteAccessError(/^Conflict|conflict/.test(error.message) ? 409 : 400, error.message.replace(/^Invalid documentation: /, ''));
    }
    throw error;
  };
  const dashboardRelease = (release: Record<string, unknown>): ReturnType<typeof summary> => ({
    id: z.string().parse(release.releaseId), version: release.version, tags: release.tags, summary: release.summary,
    operation: release.operation, actor: release.author ?? null, source: release.source,
    rollbackRelease: release.rollbackRelease, createdAt: release.publishedAt ?? null,
    articles: typeof release.articles === 'number' ? release.articles : null
  });

  return {
    /** The current release of each environment. */
    async status(member: string, workspace: string, name: string, actor: string) {
      const adapter = await target(member, workspace, name, actor);
      try {
        if (projectsFor) {
          const result = await createDocumentationPublisher(projectsFor(member), fetchGoogle, build).status({ project: name, workspace });
          return { environments: result.environments.map(item => ({
            environment: item.environment, release: item.release ? dashboardRelease(item.release) : null
          })) };
        }
        const environments = await Promise.all(ENVIRONMENTS.map(async environment => {
          const snapshot = await engine.open(adapter, environment);
          return { environment, release: snapshot.head && snapshot.release ? summary(snapshot.head.data.releaseId, snapshot.release) : null };
        }));
        return { environments };
      } catch (error) { return failed(error); }
    },
    async history(member: string, workspace: string, name: string, actor: string, environment: string) {
      const env = z.enum(ENVIRONMENTS).safeParse(environment);
      if (!env.success) throw new WebsiteAccessError(400, 'Choose development, beta or production.');
      const adapter = await target(member, workspace, name, actor);
      try {
        if (projectsFor) {
          const result = await createDocumentationPublisher(projectsFor(member), fetchGoogle, build).status({ project: name, workspace, environment: env.data });
          return { environment: env.data, releases: (result.history ?? []).map(dashboardRelease) };
        }
        return { environment: env.data, releases: (await adapter.history(env.data)).slice(0, 100).map(item => summary(item.id, item)) };
      }
      catch (error) { return failed(error); }
    },
    /** Copy the whole source snapshot to the target. Defaults to the source's version and tags. */
    async promote(member: string, workspace: string, name: string, actor: string, input: unknown) {
      const parsed = promoteInput.safeParse(input);
      if (!parsed.success) throw new WebsiteAccessError(400, parsed.error.issues[0]?.message ?? 'Invalid promotion.');
      const plan = parsed.data;
      if (!PROMOTIONS.includes(plan.source + ':' + plan.target)) throw new WebsiteAccessError(400, 'Only Development → Beta, Development → Production and Beta → Production are allowed.');
      const adapter = await target(member, workspace, name, actor);
      try {
        if (projectsFor) {
          const result = await createDocumentationPublisher(projectsFor(member), fetchGoogle, build).promote({
            ...plan, project: name, workspace, confirmed: true
          });
          return { ...result, count: result.articles };
        }
        const source = await engine.load(adapter, plan.source);
        if (!source.head || !source.release) throw new WebsiteAccessError(400, 'Nothing is published in ' + plan.source + ' yet.');
        engine.expected(source, plan.expectedSource);
        assertPublicationQuality(source.records, String(plan.version ?? source.release.version));
        const label = (environment: string) => environment[0]!.toUpperCase() + environment.slice(1);
        return await engine.publish(adapter, { operation: 'promote', environment: plan.target, source: plan.source, expected: plan.expected, expectedSource: plan.expectedSource,
          version: plan.version ?? source.release.version, tags: plan.tags ?? source.release.tags,
          summary: plan.summary ?? 'Promoted version ' + String(source.release.version) + ' from ' + label(plan.source) + ' to ' + label(plan.target) + ' on the dashboard.',
          actor: adapter.actor, acknowledgeMissing: plan.acknowledgeMissing });
      } catch (error) {
        if (error instanceof WebsiteAccessError) throw error;
        return failed(error);
      }
    },
    /** Make an earlier release of the same environment current again, as a new audited release. */
    async rollback(member: string, workspace: string, name: string, actor: string, input: unknown) {
      const parsed = rollbackInput.safeParse(input);
      if (!parsed.success) throw new WebsiteAccessError(400, 'A rollback needs a version, at least one tag and a summary of why.');
      const adapter = await target(member, workspace, name, actor);
      try {
        if (projectsFor) return await createDocumentationPublisher(projectsFor(member), fetchGoogle, build).rollback({
          ...parsed.data, project: name, workspace, confirmed: true
        });
        return await engine.publish(adapter, { operation: 'rollback', environment: parsed.data.environment, expected: parsed.data.expected,
          rollbackRelease: parsed.data.rollbackRelease, version: parsed.data.version, tags: parsed.data.tags, summary: parsed.data.summary, actor: adapter.actor });
      } catch (error) { return failed(error); }
    }
  };
}
