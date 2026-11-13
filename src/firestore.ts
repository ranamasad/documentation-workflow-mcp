import { createRequire } from 'node:module';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { sha256, type WireRecord } from './validation.js';
import type { CacheChange, CachedDocument, CacheStatus, FirestoreCache } from './firestore-cache.js';

// Live, read-only access to a customer's published documentation in Firestore.
// Reads the same environment-scoped paths as reader members and verifies every
// revision hash, so a misconfigured project cannot feed unverified content.

const require = createRequire(import.meta.url);
interface Engine {
  open(adapter: { get(path: string): Promise<{ data: Record<string, unknown> } | null> }, environment: string): Promise<{
    environment: string; head: { data: { releaseId: string; generation: number } } | null;
    release: Record<string, unknown> | null; manifest: Record<string, string>; areaChanges: Record<string, AreaChange>;
  }>;
}
interface Model { record(value: unknown): WireRecord; isDynamic(value: unknown): boolean }
export interface AreaChange { before: string; after: string; version: string; tags: string[]; summary: string; actor: string; releaseId: string; previousRelease: string }
const engine: Engine = require('../vendor/documentation-engine.js');
const model: Model = require('../vendor/documentation-model.js');

export const FIRESTORE_DENIED = 'Firestore denied access to this documentation. Check the project\'s access setup or your reader membership for this environment.';
export const KEY_REJECTED = 'The project\'s service-account key was rejected by Google. Ask an owner to upload a current read-only key.';
export class FirestoreAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Fetch = typeof fetch;
const bounded = (fetchService: Fetch): Fetch => (input, options) => fetchService(input, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
const networkError = (error: unknown) => {
  if (error instanceof TypeError || (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))) {
    return new FirestoreAccessError(503, 'Firestore is temporarily unreachable. Please retry.');
  }
  return error;
};

// ---- Firestore REST value decoding ----
type Value = Record<string, unknown>;
export function decodeValue(value: Value): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return ((value.arrayValue as { values?: Value[] }).values ?? []).map(decodeValue);
  if ('mapValue' in value) return decodeFields((value.mapValue as { fields?: Record<string, Value> }).fields);
  throw new FirestoreAccessError(502, 'Firestore returned an unsupported value type.');
}
export const decodeFields = (fields: Record<string, Value> = {}): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));

// ---- Session cache ----
// Service-account reads go through the shared cache: the server authorizes every caller before it reads,
// so one copy per Firebase project serves them all. Personal sign-in reads are checked by the customer's
// security rules per reader, so they are never cached.
let cache: FirestoreCache | undefined;
export function useFirestoreCache(value: FirestoreCache | undefined) { cache = value; }
export const firestoreCacheStatus = (): Promise<CacheStatus> => cache?.status() ?? Promise.resolve({ redis: 'not-configured', failures: 0 });

const DEFAULT_ENDPOINT = 'https://firestore.googleapis.com';
// Content-addressed or create-only documents (enforced by the reader site's security rules).
const IMMUTABLE = /^(documentationRevisions\/[a-f0-9]{64}|documentationEnvironments\/(development|beta|production)\/revisions\/[a-f0-9]{64}|documentationReleases\/[^/]+|documentationV3Releases\/[^/]+|documentationV3Bundles\/[^/]+|documentationDiscovery\/.+)$/;
const cacheProject = (endpoint: string, projectId: string) => endpoint + '|' + projectId;
const relativePath = (name: string) => name.includes('/documents/') ? name.slice(name.indexOf('/documents/') + 11) : name;

/** A Firestore REST write as sent in a commit body. */
export interface RestWrite { update?: { name: string; fields?: unknown }; delete?: string; updateTransforms?: { fieldPath: string }[] }
/**
 * After a successful commit, put what was written into the cache in place of the old copies, so nothing is re-read.
 * Server-set values (REQUEST_TIME) and the new update times come from the commit response.
 */
export async function applyFirestoreCommit(projectId: string, writes: RestWrite[], response: unknown, endpoint = DEFAULT_ENDPOINT) {
  if (!cache || !writes.length) return;
  const results = (response as { writeResults?: { updateTime?: string; transformResults?: Value[] }[] } | null)?.writeResults ?? [];
  await cache.apply(cacheProject(endpoint, projectId), writes.flatMap((write, index): CacheChange[] => {
    if (write.delete) return [{ path: relativePath(write.delete), value: null }];
    if (!write.update) return [];
    const data = decodeFields(write.update.fields as Record<string, Value> | undefined);
    (write.updateTransforms ?? []).forEach((transform, position) => {
      const value = results[index]?.transformResults?.[position];
      if (value) data[transform.fieldPath] = decodeValue(value);
    });
    const token = results[index]?.updateTime;
    return [{ path: relativePath(write.update.name), value: { data, ...(token ? { token } : {}) } }];
  }));
}

// ---- Access tokens ----
/** `shared` marks service-account tokens, whose reads may be cached for every authorized caller. */
export type TokenSource = (() => Promise<string>) & { readonly shared?: boolean };

export const serviceAccountKey = z.object({
  type: z.literal('service_account'),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  private_key: z.string().startsWith('-----BEGIN PRIVATE KEY-----').max(4000),
  client_email: z.string().email().max(254),
  token_uri: z.string().url().optional()
}).passthrough();

export const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
/** Firestore, Hosting, Rules and Firebase Management, used only when an owner deploys the documentation site. */
export const DEPLOY_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** OAuth access tokens minted from a project's service-account key (Firestore scope unless deploying). */
export function serviceAccountTokens(keyJson: string, fetchService: Fetch = fetch, scope = DATASTORE_SCOPE): TokenSource {
  const key = serviceAccountKey.parse(JSON.parse(keyJson));
  const call = bounded(fetchService);
  let cached: { token: string; expires: number } | undefined;
  return Object.assign(async () => {
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(key.client_email)
      .setAudience('https://oauth2.googleapis.com/token').setIssuedAt(now).setExpirationTime(now + 3600)
      .sign(await importPKCS8(key.private_key, 'RS256'));
    let response: Response;
    try {
      response = await call('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
      });
    } catch (error) { throw networkError(error); }
    const result = z.object({ access_token: z.string(), expires_in: z.number() }).safeParse(await response.json().catch(() => null));
    if (!response.ok || !result.success) throw new FirestoreAccessError(403, KEY_REJECTED);
    cached = { token: result.data.access_token, expires: Date.now() + result.data.expires_in * 1000 };
    return cached.token;
  }, { shared: true });
}

/** Firebase ID tokens for one member's own sign-in to the customer's Firebase project. */
export function personalTokens(apiKey: string, refreshToken: string, fetchService: Fetch = fetch): TokenSource {
  const call = bounded(fetchService);
  let cached: { token: string; expires: number } | undefined;
  return async () => {
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    let response: Response;
    try {
      response = await call('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
      });
    } catch (error) { throw networkError(error); }
    const result = z.object({ id_token: z.string(), expires_in: z.string() }).safeParse(await response.json().catch(() => null));
    if (!response.ok || !result.success) throw new FirestoreAccessError(401, 'Your Firebase sign-in for this project expired or was revoked. Reconnect it in the dashboard under Projects.');
    cached = { token: result.data.id_token, expires: Date.now() + Number(result.data.expires_in) * 1000 };
    return cached.token;
  };
}

// ---- Documents ----
export interface FirestoreReader {
  /** `fresh` bypasses the cache (for checks and conflict handling) and stores what Firestore returns. */
  get(path: string, options?: { fresh?: boolean }): Promise<{ data: Record<string, unknown>; token?: string } | null>;
  getMany(paths: string[]): Promise<({ data: Record<string, unknown>; token?: string } | null)[]>;
}

/** endpoint can point at the Firestore emulator (for example http://127.0.0.1:8088) in local verification. */
export function createFirestoreReader(projectId: string, tokens: TokenSource, fetchService: Fetch = fetch, endpoint = 'https://firestore.googleapis.com'): FirestoreReader {
  const call = bounded(fetchService);
  const root = 'projects/' + projectId + '/databases/(default)/documents';
  const base = endpoint + '/v1/' + root;
  // Google's own error explains whether Firestore is missing or access is denied; keep that distinction.
  const denied = async (response: Response) => {
    const body = await response.json().catch(() => null) as { error?: { status?: string; message?: string } } | null;
    const reason = (body?.error?.status ?? '') + ' ' + (body?.error?.message ?? '');
    if (/SERVICE_DISABLED|has not been used|is disabled|does not exist/i.test(reason)) {
      return new FirestoreAccessError(424, 'Cloud Firestore is not set up in Firebase project ' + projectId + '. In the Firebase console open Build → Firestore Database → Create database, wait a minute, then try again.');
    }
    return response.status === 401 || response.status === 403
      ? new FirestoreAccessError(403, FIRESTORE_DENIED)
      : new FirestoreAccessError(502, 'Firestore returned an error (' + response.status + '). Please retry.');
  };
  type Stored = { data: Record<string, unknown>; token?: string } | null;
  async function load(path: string): Promise<Stored> {
    let response: Response;
    try { response = await call(base + '/' + path, { headers: { Authorization: 'Bearer ' + await tokens() } }); }
    catch (error) { throw networkError(error); }
    // A missing document is normal (nothing published yet); a missing database is a setup problem.
    if (response.status === 404 && !/does not exist/i.test(await response.clone().text().catch(() => ''))) return null;
    if (!response.ok) throw await denied(response);
    const document = await response.json() as { fields?: Record<string, Value>; updateTime?: string };
    return { data: decodeFields(document.fields), ...(document.updateTime ? { token: document.updateTime } : {}) };
  }
  async function loadMany(paths: string[]): Promise<Stored[]> {
    let response: Response;
    try {
      response = await call(base + ':batchGet', {
        method: 'POST', headers: { Authorization: 'Bearer ' + await tokens(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: paths.map(path => root + '/' + path) })
      });
    } catch (error) { throw networkError(error); }
    if (!response.ok) throw await denied(response);
    const results = await response.json() as { found?: { name: string; fields?: Record<string, Value>; updateTime?: string }; missing?: string }[];
    const found = new Map(results.filter(item => item.found).map(item => [item.found!.name, item.found!]));
    return paths.map(path => {
      const document = found.get(root + '/' + path);
      return document ? { data: decodeFields(document.fields), ...(document.updateTime ? { token: document.updateTime } : {}) } : null;
    });
  }
  const shared = cache && tokens.shared ? cache : undefined;
  return {
    async get(path, options = {}) {
      if (!shared) return load(path);
      return shared.document(cacheProject(endpoint, projectId), path, { fresh: options.fresh ?? false, immutable: IMMUTABLE.test(path) }, () => load(path));
    },
    async getMany(paths) {
      if (!paths.length) return [];
      if (!shared) return loadMany(paths);
      return shared.documents(cacheProject(endpoint, projectId), paths, loadMany);
    }
  };
}

// ---- Published documentation (read-only) ----

export interface PublishedRelease {
  environment: string;
  releaseId: string;
  version: string;
  tags: string[];
  summary: string;
  operation: string;
  createdAt: string | null;
  manifest: Record<string, string>;
  areaChanges: Record<string, AreaChange>;
}

export async function openRelease(reader: FirestoreReader, environment: string): Promise<PublishedRelease | null> {
  let snapshot;
  try { snapshot = await engine.open(reader, environment); }
  catch (error) {
    if (error instanceof FirestoreAccessError) throw error;
    throw new FirestoreAccessError(502, 'The published release failed verification: ' + (error instanceof Error ? error.message : 'unknown error'));
  }
  if (!snapshot.head || !snapshot.release) return null;
  const release = snapshot.release;
  return {
    environment, releaseId: snapshot.head.data.releaseId, version: String(release.version), tags: release.tags as string[],
    summary: String(release.summary), operation: String(release.operation),
    createdAt: typeof release.createdAt === 'string' ? release.createdAt : null,
    manifest: snapshot.manifest, areaChanges: snapshot.areaChanges
  };
}

/** Read and verify published revisions through the reader-visible environment copies. */
export async function readArticles(reader: FirestoreReader, release: PublishedRelease, keys: string[]): Promise<WireRecord[]> {
  for (const key of keys) {
    if (!release.manifest[key]) throw new FirestoreAccessError(404, 'Not published in ' + release.environment + ': ' + key);
  }
  const paths = keys.map(key => 'documentationEnvironments/' + release.environment + '/revisions/' + release.manifest[key]);
  const snapshots = await reader.getMany(paths);
  return keys.map((key, index) => {
    const data = snapshots[index]?.data;
    if (!data || data.schema !== 1 || data.key !== key || typeof data.payload !== 'string' || sha256(data.payload) !== release.manifest[key]) {
      throw new FirestoreAccessError(502, 'A published revision is missing or failed verification: ' + key);
    }
    let record: WireRecord;
    try { record = model.record(JSON.parse(data.payload)); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message.startsWith('Invalid documentation'))) throw error;
      throw new FirestoreAccessError(502, 'A published revision is not valid documentation: ' + key);
    }
    if (record.key !== key || data.title !== record.title) throw new FirestoreAccessError(502, 'Revision title or key does not match the manifest: ' + key);
    return record;
  });
}

export interface NavigationEntry { key: string; label: string; section: string; group: string }

/** Article list from the foundation's navigation (labels as readers see them). */
export function navigationEntries(foundation: WireRecord): NavigationEntry[] {
  const navigation = foundation.data.navigation as { entries?: { key: string; label: string; tab: string; group: string; visible?: boolean }[] } | undefined;
  return (navigation?.entries ?? []).filter(entry => entry.visible !== false && entry.key !== 'foundation')
    .map(entry => ({ key: entry.key, label: entry.label, section: entry.tab, group: entry.group }));
}

const words = (text: string) => text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1);

/** Rank navigation entries for a query; titles and keys only, so it never reads every article. */
export function searchEntries(entries: NavigationEntry[], query: string, limit = 20) {
  const terms = words(query);
  return entries.map(entry => {
    const label = entry.label.toLowerCase(), key = entry.key.toLowerCase();
    const matched = terms.filter(term => label.includes(term) || key.includes(term));
    const score = matched.reduce((total, term) => total + (label.includes(term) ? 3 : 1), 0);
    return { ...entry, score, matchedTerms: matched };
  }).filter(entry => entry.score > 0)
    .sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || b.score - a.score || a.key.localeCompare(b.key, 'en'))
    .slice(0, limit);
}

export const isDynamic = (record: WireRecord) => model.isDynamic(record.data);

// ---- Writes (website access sync): list small collections and apply atomic batches ----
export interface FirestoreDocument { id: string; data: Record<string, unknown> }
export type FirestoreWrite =
  | { set: string; fields: Record<string, boolean | string | string[]>; stamp?: string }
  | { delete: string };
/** `token` is the document's update time: the version a conditional write (currentDocument.updateTime) needs. */
export interface QueryDocument { path: string; id: string; data: Record<string, unknown>; token?: string }
export interface FirestoreWriter {
  list(collection: string): Promise<FirestoreDocument[]>;
  commit(writes: FirestoreWrite[]): Promise<void>;
  /** Run a structured query (optionally across all collections with that id), following cursors up to `max` documents. */
  query(collection: string, options: { parent?: string; allDescendants?: boolean;
    where?: ({ field: string; op: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL'; timestamp: string } |
      { field: string; op: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL'; string: string })[]; orderBy?: string; max: number }):
    Promise<{ documents: QueryDocument[]; truncated: boolean }>;
}

type QueryOptions = Parameters<FirestoreWriter['query']>[1];
/** Firestore query semantics over cached documents: inequality filters and ordering skip documents without the field. */
function evaluateQuery(documents: CachedDocument[], options: QueryOptions): { documents: QueryDocument[]; truncated: boolean } {
  const matches = documents.filter(document => (options.where ?? []).every(filter => {
    const value = document.data[filter.field];
    if (typeof value !== 'string') return false;
    const [left, right] = 'timestamp' in filter ? [Date.parse(value), Date.parse(filter.timestamp)] : [value, filter.string];
    return filter.op === 'GREATER_THAN_OR_EQUAL' ? left >= right : left <= right;
  }) && (!options.orderBy || options.orderBy in document.data));
  const compare = (a: unknown, b: unknown) => a === b ? 0 : String(a) < String(b) ? -1 : 1;
  matches.sort((a, b) => options.orderBy
    ? compare(b.data[options.orderBy], a.data[options.orderBy]) || compare(b.path, a.path)
    : compare(a.path, b.path));
  return { documents: matches.slice(0, options.max).map(document => ({ path: document.path, id: decodeURIComponent(document.path.split('/').at(-1) ?? ''), data: document.data })),
    truncated: matches.length > options.max };
}

const encodeField = (value: boolean | string | string[]): Value =>
  typeof value === 'boolean' ? { booleanValue: value } : typeof value === 'string' ? { stringValue: value }
    : { arrayValue: { values: value.map(item => ({ stringValue: item })) } };

/** Service-account writes for platform documents (teams, feedbackAccess, adminAccess); security rules do not apply. */
export function createFirestoreWriter(projectId: string, tokens: TokenSource, fetchService: Fetch = fetch, endpoint = 'https://firestore.googleapis.com'): FirestoreWriter {
  const call = bounded(fetchService);
  const database = 'projects/' + projectId + '/databases/(default)';
  const base = endpoint + '/v1/' + database + '/documents';
  const failed = async (response: Response, action: string) => {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (response.status === 401 || response.status === 403) {
      return new FirestoreAccessError(403, 'The service account cannot ' + action + ' in Firestore. Give it the Cloud Datastore User role in project ' + projectId + '.');
    }
    return new FirestoreAccessError(502, 'Firestore could not ' + action + ' (' + response.status + (body?.error?.message ? ': ' + body.error.message.slice(0, 200) : '') + ').');
  };
  const direct: FirestoreWriter = {
    async list(collection) {
      const documents: FirestoreDocument[] = [];
      let pageToken = '';
      for (let page = 0; page < 50; page++) {
        let response: Response;
        try {
          response = await call(base + '/' + collection + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''),
            { headers: { Authorization: 'Bearer ' + await tokens() } });
        } catch (error) { throw networkError(error); }
        if (!response.ok) throw await failed(response, 'read ' + collection);
        const body = await response.json() as { documents?: { name: string; fields?: Record<string, Value> }[]; nextPageToken?: string };
        for (const document of body.documents ?? []) documents.push({ id: decodeURIComponent(document.name.split('/').pop() ?? ''), data: decodeFields(document.fields) });
        if (!body.nextPageToken) return documents;
        pageToken = body.nextPageToken;
      }
      throw new FirestoreAccessError(502, 'The ' + collection + ' collection is too large to read.');
    },
    async commit(writes) {
      // Firestore applies at most 500 writes per atomic commit.
      for (let index = 0; index < writes.length; index += 450) {
        const batch = writes.slice(index, index + 450).map(write => 'delete' in write
          ? { delete: database + '/documents/' + write.delete }
          : { update: { name: database + '/documents/' + write.set, fields: Object.fromEntries(Object.entries(write.fields).map(([key, value]) => [key, encodeField(value)])) },
            ...(write.stamp ? { updateTransforms: [{ fieldPath: write.stamp, setToServerValue: 'REQUEST_TIME' }] } : {}) });
        let response: Response;
        try {
          response = await call(endpoint + '/v1/' + database + '/documents:commit', {
            method: 'POST', headers: { Authorization: 'Bearer ' + await tokens(), 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: batch })
          });
        } catch (error) { throw networkError(error); }
        if (!response.ok) throw await failed(response, 'save website access');
        if (tokens.shared) await applyFirestoreCommit(projectId, batch, await response.json().catch(() => null), endpoint);
      }
    },
    async query(collection, options) {
      const documents: QueryDocument[] = [];
      const order = options.orderBy ? [{ field: { fieldPath: options.orderBy }, direction: 'DESCENDING' }, { field: { fieldPath: '__name__' }, direction: 'DESCENDING' }]
        : [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }];
      const filters = (options.where ?? []).map(item => ({ fieldFilter: { field: { fieldPath: item.field }, op: item.op,
        value: 'timestamp' in item ? { timestampValue: item.timestamp } : { stringValue: item.string } } }));
      let cursor: Value[] | null = null;
      while (documents.length < options.max) {
        const limit = Math.min(1000, options.max - documents.length);
        const structuredQuery = {
          from: [{ collectionId: collection, ...(options.allDescendants ? { allDescendants: true } : {}) }],
          ...(filters.length ? { where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } } } : {}),
          orderBy: order, limit,
          ...(cursor ? { startAt: { values: cursor, before: false } } : {})
        };
        let response: Response;
        try {
          const parent = options.parent ? '/' + options.parent.split('/').map(encodeURIComponent).join('/') : '';
          response = await call(base + parent + ':runQuery', { method: 'POST', headers: { Authorization: 'Bearer ' + await tokens(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ structuredQuery }) });
        } catch (error) { throw networkError(error); }
        if (!response.ok) throw await failed(response, 'read ' + collection);
        const rows = (await response.json() as { document?: { name: string; fields?: Record<string, Value>; updateTime?: string } }[]).filter(row => row.document);
        for (const row of rows) {
          const document = row.document!;
          documents.push({ path: document.name.slice(document.name.indexOf('/documents/') + 11), id: decodeURIComponent(document.name.split('/').pop() ?? ''), data: decodeFields(document.fields),
            ...(document.updateTime ? { token: document.updateTime } : {}) });
        }
        if (rows.length < limit) return { documents, truncated: false };
        const last = rows.at(-1)!.document!;
        cursor = [...(options.orderBy ? [last.fields?.[options.orderBy] ?? { nullValue: null }] : []), { referenceValue: last.name }];
      }
      return { documents, truncated: true };
    }
  };
  const shared = cache && tokens.shared ? cache : undefined;
  if (!shared) return direct;
  const project = cacheProject(endpoint, projectId);
  const scopeOf = (collection: string, parent: string | null) => ({ collectionId: collection.split('/').at(-1)!, parent });
  return {
    commit: writes => direct.commit(writes),
    async list(collection) {
      const parent = collection.split('/').slice(0, -1).join('/');
      const documents = await shared.collection(project, scopeOf(collection, parent), async () => ({ complete: true,
        documents: (await direct.list(collection)).map(document => ({ path: collection + '/' + document.id, data: document.data })) }));
      return (documents ?? []).map(document => ({ id: document.path.split('/').at(-1)!, data: document.data }))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    },
    // The whole collection is read once per session; filters, order and limits are applied to the cached documents.
    async query(collection, options) {
      const documents = await shared.collection(project, scopeOf(collection, options.allDescendants ? null : options.parent ?? ''), async () => {
        const result = await direct.query(collection, { ...(options.parent ? { parent: options.parent } : {}),
          ...(options.allDescendants ? { allDescendants: true } : {}), max: options.max });
        return { complete: !result.truncated, documents: result.documents.map(document => ({ path: document.path, data: document.data, ...(document.token ? { token: document.token } : {}) })) };
      });
      // Larger than one cached collection may hold: ask Firestore for just the matching documents.
      if (!documents) return direct.query(collection, options);
      return evaluateQuery(documents, options);
    }
  };
}
