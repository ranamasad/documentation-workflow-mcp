import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

// Session cache in front of every server-side Firestore read.
// - One Redis hash per Firebase project holds one field per document. Any read or write on the project
//   pushes the hash's expiry an hour out, so the data stays while anyone is active and is deleted
//   after an hour without activity.
// - Reads: Redis first; Firestore only for what is missing. A collection is read from Firestore in full
//   once per session; after that lists and queries are answered from the cached documents.
// - Writes: Firestore first; once the commit succeeds, the written documents replace their cached copies.
//   Nothing is re-read. Data written outside this server is not seen until the session ends (contract-v3
//   sends every write through this server).
// - Values are gzipped and sealed with AES-256-GCM, and key and field names are HMACs, so Redis never sees
//   documentation, reader emails or Firestore paths in plaintext.

export interface CachedDocument { path: string; data: Record<string, unknown>; token?: string }
export type CachedValue = { data: Record<string, unknown>; token?: string } | null;
/** One document change from a successful commit; `value: null` means deleted. */
export interface CacheChange { path: string; value: CachedValue }
/** A collection by ID, either under one parent document ('' for top level) or under any parent. */
export interface CollectionScope { collectionId: string; parent: string | null }
/** Redis health for platform admins; failures count this server instance's cache errors since it started. */
export interface CacheStatus {
  redis: 'not-configured' | 'ok' | 'unreachable';
  latencyMs?: number;
  failures: number;
  lastFailure?: { at: string; message: string };
}

export interface FirestoreCache {
  document(project: string, path: string, options: { fresh?: boolean; immutable?: boolean }, load: () => Promise<CachedValue>): Promise<CachedValue>;
  documents(project: string, paths: string[], load: (missing: string[]) => Promise<CachedValue[]>): Promise<CachedValue[]>;
  /** Every document in the scope, loading the whole scope once per session; null when it is too large to cache. */
  collection(project: string, scope: CollectionScope, load: () => Promise<{ documents: CachedDocument[]; complete: boolean }>): Promise<CachedDocument[] | null>;
  apply(project: string, changes: CacheChange[]): Promise<void>;
  /** Pings Redis. */
  status(): Promise<CacheStatus>;
  readonly bytes: number;
}

export const SESSION_IDLE_SECONDS = 60 * 60;
// Other instances may have written since; a local copy of mutable data is trusted only this long.
const LOCAL_SECONDS = 5;
// Refreshing the hash expiry once a minute is enough for a one-hour idle window.
const TOUCH_EVERY_MS = 60_000;
const MAX_REDIS_VALUE = 1_000_000;
const PIPELINE = 500;

type Stored = { path: string; data?: Record<string, unknown>; token?: string; missing?: true };

export function createFirestoreCache(options: {
  secret: string;
  redis?: { url: string; token: string } | undefined;
  fetch?: typeof fetch;
  maxBytes?: number;
  now?: () => number;
  warn?: (message: string) => void;
}): FirestoreCache {
  const sealKey = createHmac('sha256', options.secret).update('firestore-cache-seal-v2').digest();
  const nameKey = createHmac('sha256', options.secret).update('firestore-cache-name-v2').digest();
  const now = options.now ?? Date.now;
  let failures = 0;
  let lastFailure: CacheStatus['lastFailure'];
  const warn = (message: string) => {
    failures += 1;
    lastFailure = { at: new Date(now()).toISOString(), message };
    (options.warn ?? console.warn)(message);
  };
  const maxBytes = Math.max(1, options.maxBytes ?? 64 * 1024 * 1024);
  const hmac = (value: string) => createHmac('sha256', nameKey).update(value).digest('base64url').slice(0, 32);

  const hashName = (project: string) => 'fsc:v2:' + hmac('project\0' + project);
  const segments = (path: string) => path.split('/');
  const collectionIdOf = (path: string) => segments(path).at(-2) ?? '';
  const parentOf = (path: string) => segments(path).slice(0, -2).join('/');
  const documentField = (path: string) => 'd.' + hmac('collection\0' + collectionIdOf(path)) + '.' + hmac('document\0' + path);
  const collectionPattern = (collectionId: string) => 'd.' + hmac('collection\0' + collectionId) + '.*';
  const scopeKey = (scope: CollectionScope) => scope.parent === null ? '**/' + scope.collectionId : scope.parent + '/' + scope.collectionId;
  const completeField = (scope: CollectionScope) => 'c.' + hmac('complete\0' + scopeKey(scope));

  function seal(id: string, value: Stored) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sealKey, iv);
    cipher.setAAD(Buffer.from(id));
    const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.');
  }
  function open(id: string, sealed: string): Stored {
    const [iv, tag, body] = sealed.split('.').map(part => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid cache envelope');
    const decipher = createDecipheriv('aes-256-gcm', sealKey, iv);
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(tag);
    const value = JSON.parse(gunzipSync(Buffer.concat([decipher.update(body), decipher.final()])).toString('utf8')) as Stored;
    if (typeof value?.path !== 'string') throw new Error('Invalid cache value');
    return value;
  }
  const toValue = (stored: Stored): CachedValue => stored.missing ? null : { data: stored.data ?? {}, ...(stored.token ? { token: stored.token } : {}) };
  const toStored = (path: string, value: CachedValue): Stored => value ? { path, data: value.data, ...(value.token ? { token: value.token } : {}) } : { path, missing: true };

  // ---- Local store: the whole cache without Redis, or a short-lived copy in front of it ----
  interface LocalProject { fields: Map<string, { value: Stored | true; expires: number; size: number }>; scopes: Map<string, { documents: CachedDocument[]; expires: number }>; idle: number; bytes: number }
  const local = new Map<string, LocalProject>();
  let bytes = 0;
  // Without Redis the local copy is the cache itself and lives until the project goes idle.
  const localSeconds = (immutable = false) => options.redis && !immutable ? LOCAL_SECONDS : Infinity;
  function localProject(project: string) {
    for (const [key, entry] of local) if (entry.idle <= now()) { bytes -= entry.bytes; local.delete(key); }
    let entry = local.get(project);
    if (!entry) { entry = { fields: new Map(), scopes: new Map(), idle: 0, bytes: 0 }; local.set(project, entry); }
    entry.idle = now() + SESSION_IDLE_SECONDS * 1000;
    return entry;
  }
  function remember(project: string, field: string, value: Stored | true, seconds: number) {
    const entry = localProject(project);
    const size = typeof value === 'object' ? JSON.stringify(value).length : 1;
    const previous = entry.fields.get(field)?.size ?? 0;
    entry.fields.set(field, { value, expires: now() + seconds * 1000, size });
    entry.bytes += size - previous; bytes += size - previous;
    // Over budget: drop whole projects, least recently used first (Map order follows insertion).
    while (bytes > maxBytes && local.size > 1) {
      const [oldest, dropped] = local.entries().next().value!;
      if (oldest === project) { local.delete(oldest); local.set(oldest, dropped); continue; }
      bytes -= dropped.bytes; local.delete(oldest);
    }
  }
  function recall(project: string, field: string): Stored | true | undefined {
    const item = local.get(project)?.fields.get(field);
    if (!item) return undefined;
    if (item.expires <= now()) {
      const entry = local.get(project)!;
      entry.fields.delete(field); entry.bytes -= item.size; bytes -= item.size;
      return undefined;
    }
    return item.value;
  }

  // ---- Redis ----
  // When Redis fails, skip it for a minute so Firestore reads do not each wait up to 5 s for a cache that is down.
  let redisDownUntil = 0;
  async function pipeline(commands: (string | number)[][]): Promise<unknown[]> {
    const config = options.redis;
    if (!config || !commands.length) return [];
    if (now() < redisDownUntil) throw new Error('cache unavailable');
    const results: unknown[] = [];
    for (let index = 0; index < commands.length; index += PIPELINE) {
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(config.url + '/pipeline', {
          method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(commands.slice(index, index + PIPELINE).map(command => command.map(String))),
          redirect: 'error', signal: AbortSignal.timeout(5000)
        });
      } catch (error) { redisDownUntil = now() + 60_000; throw error; }
      if (!response.ok) {
        redisDownUntil = now() + 60_000;
        const reason = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        console.warn('Firestore cache answered HTTP ' + response.status + ' (' + reason + '); skipping it for 60 s.');
        throw new Error('cache unavailable');
      }
      const body = await response.json() as { result?: unknown; error?: unknown }[];
      if (!Array.isArray(body) || body.some(item => item?.error)) {
        console.warn('Firestore cache error: ' + String((Array.isArray(body) ? body.find(item => item?.error)?.error : 'invalid reply') ?? '').slice(0, 200));
        throw new Error('cache unavailable');
      }
      results.push(...body.map(item => item.result));
    }
    return results;
  }
  const touched = new Map<string, number>();
  const expire = (project: string) => ['EXPIRE', hashName(project), SESSION_IDLE_SECONDS];
  async function touch(project: string) {
    localProject(project);
    if (!options.redis || (touched.get(project) ?? 0) > now() - TOUCH_EVERY_MS) return;
    touched.set(project, now());
    try { await pipeline([expire(project)]); } catch { warn('Firestore cache expiry refresh failed.'); }
  }
  function decode(project: string, field: string, sealed: unknown): Stored | undefined {
    if (typeof sealed !== 'string') return undefined;
    try { return open(project + '\0' + field, sealed); }
    catch {
      warn('Corrupt Firestore cache entry discarded.');
      void pipeline([['HDEL', hashName(project), field]]).catch(() => warn('Firestore cache delete failed.'));
      return undefined;
    }
  }
  async function saveFields(project: string, entries: [string, Stored][], onlyNew: boolean) {
    if (!options.redis || !entries.length) return;
    const commands: (string | number)[][] = [];
    for (const [field, value] of entries) {
      const sealed = seal(project + '\0' + field, value);
      // Too large for one Redis value: this instance keeps it in memory only.
      if (sealed.length <= MAX_REDIS_VALUE) commands.push([onlyNew ? 'HSETNX' : 'HSET', hashName(project), field, sealed]);
    }
    commands.push(expire(project));
    touched.set(project, now());
    try { await pipeline(commands); } catch { warn('Firestore cache write failed; Firestore stays authoritative.'); }
  }

  async function lookup(project: string, paths: string[], immutable: boolean[]): Promise<(Stored | undefined)[]> {
    await touch(project);
    const fields = paths.map(documentField);
    const found = fields.map(field => { const value = recall(project, field); return typeof value === 'object' ? value : undefined; });
    const missing = found.map((value, index) => value ? -1 : index).filter(index => index >= 0);
    if (!options.redis || !missing.length) return found;
    try {
      const [values] = await pipeline([['HMGET', hashName(project), ...missing.map(index => fields[index]!)]]);
      missing.forEach((index, position) => {
        const value = decode(project, fields[index]!, (values as unknown[] | null)?.[position]);
        if (value && value.path === paths[index]) { found[index] = value; remember(project, fields[index]!, value, localSeconds(immutable[index])); }
      });
    } catch { warn('Firestore cache read failed; reading Firestore.'); }
    return found;
  }

  return {
    async document(project, path, entry, load) {
      if (!entry.fresh) {
        const [hit] = await lookup(project, [path], [entry.immutable ?? false]);
        if (hit) return toValue(hit);
      } else await touch(project);
      const value = await load();
      // A missing content-addressed document may still be created, so only found ones are kept.
      if (value || !entry.immutable) {
        const field = documentField(path), stored = toStored(path, value);
        remember(project, field, stored, localSeconds(entry.immutable));
        // A fresh read replaces the cached copy; a first read never overwrites a newer write that won the race.
        await saveFields(project, [[field, stored]], !entry.fresh);
      }
      return value;
    },
    async documents(project, paths, load) {
      const hits = await lookup(project, paths, paths.map(() => false));
      const missing = paths.filter((_, index) => !hits[index]);
      const loaded = missing.length ? await load(missing) : [];
      const fresh = new Map(missing.map((path, index) => [path, loaded[index] ?? null]));
      const entries = missing.map(path => [documentField(path), toStored(path, fresh.get(path)!)] as [string, Stored]);
      entries.forEach(([field, stored]) => remember(project, field, stored, localSeconds()));
      await saveFields(project, entries, true);
      return paths.map((path, index) => hits[index] ? toValue(hits[index]!) : fresh.get(path)!);
    },
    async collection(project, scope, load) {
      await touch(project);
      const entry = localProject(project);
      const key = scopeKey(scope);
      const cached = entry.scopes.get(key);
      if (cached && cached.expires > now()) return cached.documents;
      const inScope = (path: string) => collectionIdOf(path) === scope.collectionId && (scope.parent === null || parentOf(path) === scope.parent);
      let complete = !options.redis && recall(project, completeField(scope)) === true;
      if (options.redis) {
        try {
          const [marker] = await pipeline([['HGET', hashName(project), completeField(scope)]]);
          complete = marker === '1';
          if (complete) {
            const documents: CachedDocument[] = [];
            let cursor = '0';
            do {
              const [page] = await pipeline([['HSCAN', hashName(project), cursor, 'MATCH', collectionPattern(scope.collectionId), 'COUNT', 1000]]);
              const [next, flat] = page as [string, string[]];
              for (let index = 0; index < flat.length; index += 2) {
                const value = decode(project, flat[index]!, flat[index + 1]);
                if (value && !value.missing && inScope(value.path)) documents.push({ path: value.path, data: value.data ?? {}, ...(value.token ? { token: value.token } : {}) });
              }
              cursor = String(next);
            } while (cursor !== '0');
            entry.scopes.set(key, { documents, expires: now() + LOCAL_SECONDS * 1000 });
            return documents;
          }
        } catch { warn('Firestore cache read failed; reading Firestore.'); }
      } else if (complete) {
        const documents = [...entry.fields.values()].map(item => item.value)
          .filter((value): value is Stored => typeof value === 'object' && !value.missing && inScope(value.path))
          .map(value => ({ path: value.path, data: value.data ?? {}, ...(value.token ? { token: value.token } : {}) }));
        entry.scopes.set(key, { documents, expires: Infinity });
        return documents;
      }
      const loaded = await load();
      if (!loaded.complete) return null;
      const result = { documents: loaded.documents.filter(document => inScope(document.path)) };
      const entries = result.documents.map(document => [documentField(document.path), toStored(document.path, document)] as [string, Stored]);
      entries.forEach(([field, stored]) => remember(project, field, stored, localSeconds()));
      remember(project, completeField(scope), true, Infinity);
      // HSETNX: a write that landed while the collection loaded is newer than the loaded copy.
      await saveFields(project, entries, true);
      if (options.redis) {
        try { await pipeline([['HSET', hashName(project), completeField(scope), '1'], expire(project)]); }
        catch { warn('Firestore cache write failed; Firestore stays authoritative.'); }
      }
      entry.scopes.set(key, { documents: result.documents, expires: now() + localSeconds() * 1000 });
      return result.documents;
    },
    async apply(project, changes) {
      if (!changes.length) return;
      const entry = localProject(project);
      const entries = changes.map(change => [documentField(change.path), toStored(change.path, change.value)] as [string, Stored]);
      entries.forEach(([field, stored]) => remember(project, field, stored, localSeconds()));
      // Answers for the written collections are rebuilt from the updated documents on the next read.
      const written = new Set(changes.map(change => collectionIdOf(change.path)));
      for (const key of entry.scopes.keys()) if (written.has(key.split('/').at(-1)!)) entry.scopes.delete(key);
      await saveFields(project, entries, false);
    },
    async status() {
      const recent = { failures, ...(lastFailure ? { lastFailure } : {}) };
      if (!options.redis) return { redis: 'not-configured', ...recent };
      const started = Date.now();
      try {
        const [reply] = await pipeline([['PING']]);
        if (reply !== 'PONG') throw new Error('cache unavailable');
        return { redis: 'ok', latencyMs: Date.now() - started, ...recent };
      } catch { return { redis: 'unreachable', ...recent }; }
    },
    get bytes() { return bytes; }
  };
}
