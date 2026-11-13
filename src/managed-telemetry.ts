import { redisRestEnv } from './config.js';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonical, DocumentationV3Error, type V3Access, type v3Request } from './documentation-v3.js';
import { applyFirestoreCommit, createFirestoreReader, serviceAccountTokens, type FirestoreWriter, type QueryDocument } from './firestore.js';
import { createCiphertextCache } from './ciphertext-cache.js';
import { createManagedDocumentation, DATA_KEY_LABELS, documentationEncryptionRoot, projectDataKey, type ManagedOptions } from './managed-documentation.js';
import { feedbackTarget, visitEntry } from './telemetry-schema.js';

const identity = { email: z.string().min(1).max(320), displayName: z.string().max(256), updatedAt: z.iso.datetime() };
const visitPayload = visitEntry.safeExtend({ ...identity, kind: z.literal('visit') });
const votePayload = z.strictObject({ ...identity, ...feedbackTarget, uid: z.string().min(1).max(128),
  kind: z.literal('vote'), helpful: z.boolean(), changeId: z.uuid(), changedAt: z.number().int().nonnegative() });
const payloadSchema = z.union([visitPayload, votePayload]);
type Payload = z.infer<typeof payloadSchema>;
const encryptedSchema = z.strictObject({ format: z.literal('3'), projectId: z.uuid(),
  environment: z.enum(['development', 'beta', 'production']), kind: z.enum(['visit', 'vote']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sealed: z.string().min(1).max(32000) });
type Encrypted = z.infer<typeof encryptedSchema>;
export interface TelemetryStored { data: Encrypted; version: string }
export interface TelemetryStore {
  get(path: string): Promise<TelemetryStored | null>;
  write(entries: { path: string; data: Encrypted; version: string | null }[]): Promise<string[]>;
}
export interface TelemetryOptions extends ManagedOptions {
  telemetryStore?: TelemetryStore;
  now?: () => number;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const parentPath = (projectId: string) => 'documentationV3Telemetry/' + projectId;
function locator(projectId: string, value: Pick<Payload, 'kind' | 'uid' | 'environment' | 'releaseId'> & { id?: string; key?: string }) {
  const id = digest(canonical({ projectId, uid: value.uid, environment: value.environment, releaseId: value.releaseId,
    id: value.kind === 'visit' ? value.id : value.key }));
  return parentPath(projectId) + '/' + (value.kind === 'visit' ? 'visits' : 'votes') + '/' + id;
}
function key(root: Buffer, envelope: Pick<Encrypted, 'projectId' | 'environment' | 'kind'>) {
  return projectDataKey(root, DATA_KEY_LABELS.telemetry, { projectId: envelope.projectId, environment: envelope.environment, kind: envelope.kind });
}
function encrypt(root: Buffer, projectId: string, path: string, value: Payload): Encrypted {
  const header = { format: '3' as const, projectId, environment: value.environment, kind: value.kind,
    date: (value.kind === 'visit' ? new Date(value.openedAt).toISOString() : value.updatedAt).slice(0, 10) };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(root, header), iv);
  cipher.setAAD(Buffer.from(canonical({ path, ...header })));
  const ciphertext = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
  return { ...header, sealed: canonical({ iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }) };
}
function decrypt(root: Buffer, projectId: string, path: string, input: unknown): Payload {
  try {
    const envelope = encryptedSchema.parse(input);
    if (envelope.projectId !== projectId) throw new Error('Scope mismatch');
    const { sealed, ...header } = envelope;
    const value = z.strictObject({ iv: z.string(), tag: z.string(), ciphertext: z.string() }).parse(JSON.parse(sealed));
    const iv = Buffer.from(value.iv, 'base64url'), tag = Buffer.from(value.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid authentication header');
    const cipher = createDecipheriv('aes-256-gcm', key(root, header), iv);
    cipher.setAAD(Buffer.from(canonical({ path, ...header })));
    cipher.setAuthTag(tag);
    const plaintext = Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64url')), cipher.final()]);
    const result = payloadSchema.parse(JSON.parse(plaintext.toString('utf8')));
    if (result.environment !== header.environment || result.kind !== header.kind || locator(projectId, result) !== path ||
        header.date !== (result.kind === 'visit' ? new Date(result.openedAt).toISOString() : result.updatedAt).slice(0, 10)) {
      throw new Error('Record binding mismatch');
    }
    return result;
  } catch {
    throw new DocumentationV3Error(502, 'Encrypted analytics failed authentication. Restore the correct server key or repair the damaged record.');
  }
}

export function createTelemetryStore(access: V3Access, fetcher: typeof fetch = fetch): TelemetryStore {
  const tokens = serviceAccountTokens(access.serviceAccountKey, fetcher);
  const reader = createFirestoreReader(access.firebaseProject, tokens, fetcher);
  const database = 'projects/' + access.firebaseProject + '/databases/(default)';
  return {
    async get(path) {
      // Conflict handling needs Firestore's current version, never a cached one.
      const stored = await reader.get(path, { fresh: true });
      if (!stored) return null;
      if (!stored.token) throw new DocumentationV3Error(502, 'Analytics storage returned no document version.');
      const parsed = encryptedSchema.safeParse(stored.data);
      if (!parsed.success) throw new DocumentationV3Error(502, 'Analytics storage returned an invalid encrypted record.');
      return { data: parsed.data, version: stored.token };
    },
    async write(entries) {
      const writes = entries.map(entry => ({
        update: { name: database + '/documents/' + entry.path,
          fields: Object.fromEntries(Object.entries(entry.data).map(([field, value]) => [field, { stringValue: value }])) },
        currentDocument: entry.version ? { updateTime: entry.version } : { exists: false }
      }));
      let response: Response;
      try {
        response = await fetcher('https://firestore.googleapis.com/v1/' + database + '/documents:commit', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { Authorization: 'Bearer ' + await tokens(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ writes })
        });
      } catch (error) {
        if (error instanceof TypeError || error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) {
          throw new DocumentationV3Error(503, 'Analytics storage is temporarily unreachable. Please retry.');
        }
        throw error;
      }
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: { status?: string } } | null;
        if (response.status === 409 || response.status === 412 ||
            response.status === 400 && ['ABORTED', 'ALREADY_EXISTS', 'FAILED_PRECONDITION'].includes(error?.error?.status ?? '')) {
          throw new DocumentationV3Error(409, 'Analytics update raced another request.');
        }
      }
      if (!response.ok) throw new DocumentationV3Error(503, 'Encrypted analytics could not be saved. Check backend Firestore write access.');
      const body = await response.json() as unknown;
      const result = z.object({ writeResults: z.array(z.object({ updateTime: z.string().min(1) })) }).safeParse(body);
      if (!result.success || result.data.writeResults.length !== entries.length) throw new DocumentationV3Error(502, 'Analytics write acknowledgement is incomplete.');
      // The saved visits and votes go into the cached analytics collections; the dashboard never re-reads them.
      await applyFirestoreCommit(access.firebaseProject, writes, body);
      return result.data.writeResults.map(entry => entry.updateTime);
    }
  };
}

function merge(previous: Payload | null, next: Payload): Payload {
  if (!previous) return next;
  if (previous.kind !== next.kind || previous.uid !== next.uid || previous.environment !== next.environment || previous.releaseId !== next.releaseId) {
    throw new DocumentationV3Error(409, 'Analytics record identity changed.');
  }
  if (previous.kind === 'visit' && next.kind === 'visit') {
    for (const field of ['id', 'sessionId', 'route', 'title', 'openedAt', 'documentationVersion'] as const) {
      if (previous[field] !== next[field]) throw new DocumentationV3Error(409, 'Visit identifiers cannot be reused for another page or session.');
    }
    const ended = next.ended && (!previous.ended || next.elapsedMs >= previous.elapsedMs) ? next : previous;
    return { ...next, activeMs: Math.max(previous.activeMs, next.activeMs), elapsedMs: Math.max(previous.elapsedMs, next.elapsedMs),
      ended: previous.ended || next.ended, endReason: ended.endReason, nextRoute: ended.nextRoute };
  }
  if (previous.kind === 'vote' && next.kind === 'vote') {
    if (previous.changeId === next.changeId) {
      if (previous.helpful !== next.helpful || previous.changedAt !== next.changedAt) throw new DocumentationV3Error(409, 'Feedback change identifiers cannot be reused.');
      return previous;
    }
    if (next.changedAt < previous.changedAt || next.changedAt === previous.changedAt && next.changeId < previous.changeId) return previous;
  }
  return next;
}

export function createManagedTelemetry(options: TelemetryOptions = {}) {
  const cache = options.cache ?? createCiphertextCache({
    ...(redisRestEnv().url && redisRestEnv().token ? { redis: { url: redisRestEnv().url!, token: redisRestEnv().token! } } : {})
  });
  return async (access: V3Access, input: z.infer<typeof v3Request>) => {
    if (!input.siteToken || !access.readerUid) throw new DocumentationV3Error(403, 'A verified website reader is required for analytics and feedback.');
    const root = documentationEncryptionRoot(options.masterKey);
    const store = options.telemetryStore ?? createTelemetryStore(access, options.fetchService);
    const docs = createManagedDocumentation(access, options);
    const now = (options.now ?? Date.now)();
    const identityFields = { uid: access.readerUid, email: access.email.toLowerCase(), displayName: access.displayName ?? '', updatedAt: new Date(now).toISOString() };
    const cacheKey = (path: string) => ['documentation-v3-telemetry', access.firebaseProject, path].join(':');
    const validate = (path: string, value: unknown) => {
      if (value === null) return null;
      const entry = z.object({ data: encryptedSchema, version: z.string().min(1).max(80) }).parse(value);
      decrypt(root, access.projectId, path, entry.data);
      return entry;
    };
    if (input.action === 'feedback.get' || input.action === 'feedback.put') {
      if (input.key !== encodeURIComponent(input.route)) throw new DocumentationV3Error(400, 'Feedback key does not match its article route.');
      await docs.authorizeRelease(input.environment, input.releaseId);
      const path = locator(access.projectId, { ...input, kind: 'vote', uid: access.readerUid });
      if (input.action === 'feedback.get') {
        // Every vote this server saves also replaces the cached copy, so the cache holds the latest vote.
        const current = await cache.get(cacheKey(path), value => validate(path, value), () => store.get(path));
        if (!current) return { helpful: null };
        const vote = decrypt(root, access.projectId, path, current.data);
        if (vote.kind !== 'vote') throw new DocumentationV3Error(502, 'Invalid feedback record.');
        return { helpful: vote.helpful, updatedAt: vote.updatedAt };
      }
      if (Math.abs(input.changedAt - now) > 5 * 60 * 1000) throw new DocumentationV3Error(400, 'Feedback time is invalid. Check your device clock and retry.');
    } else if (input.action === 'usage.put') {
      for (const visit of input.visits) {
        if (visit.uid !== access.readerUid) throw new DocumentationV3Error(403, 'Visits must belong to the verified reader.');
        if (visit.openedAt > now + 300000 || visit.openedAt < now - 604800000 || visit.elapsedMs > now - visit.openedAt + 300000) {
          throw new DocumentationV3Error(400, 'Visit time is invalid. Check your device clock.');
        }
      }
      await Promise.all([...new Map(input.visits.map(visit => [visit.environment + '/' + visit.releaseId, visit])).values()]
        .map(visit => docs.authorizeRelease(visit.environment, visit.releaseId)));
    } else throw new DocumentationV3Error(400, 'Unknown telemetry action.');
    const values: Payload[] = input.action === 'usage.put' ? input.visits.map(visit => visitPayload.parse({ ...visit, ...identityFields, kind: 'visit' })) :
      [votePayload.parse({ ...identityFields, kind: 'vote', environment: input.environment, releaseId: input.releaseId,
        key: input.key, route: input.route, title: input.title, revisionId: input.revisionId, helpful: input.helpful,
        changeId: input.changeId, changedAt: input.changedAt })];
    const candidates = new Map<string, Payload>();
    for (const value of values) {
      const path = locator(access.projectId, value);
      candidates.set(path, merge(candidates.get(path) ?? null, value));
    }
    const current = new Map(await Promise.all([...candidates.keys()].map(async path => [
      path, await cache.get(cacheKey(path), value => validate(path, value), async () => null)
    ] as const)));
    for (let attempt = 0; attempt < 4; attempt++) {
      const writes: { path: string; data: Encrypted; version: string | null }[] = [];
      const results = new Map<string, Payload>();
      for (const [path, value] of candidates) {
        const before = current.get(path);
        const previous = before ? decrypt(root, access.projectId, path, before.data) : null;
        const combined = merge(previous, value);
        if (input.action === 'usage.put' && previous && canonical({ ...combined, updatedAt: previous.updatedAt }) === canonical(previous)) {
          results.set(path, previous);
          continue;
        }
        results.set(path, combined);
        writes.push({ path, data: encrypt(root, access.projectId, path, combined), version: before?.version ?? null });
      }
      try {
        if (writes.length) {
          const versions = await store.write(writes);
          await Promise.all(writes.map((write, index) => cache.set(cacheKey(write.path), { data: write.data, version: versions[index]! })));
        }
        if (input.action === 'usage.put') return { ok: true };
        const vote = [...results.values()][0];
        if (!vote || vote.kind !== 'vote') throw new DocumentationV3Error(502, 'Feedback acknowledgement is missing.');
        return { helpful: vote.helpful, updatedAt: vote.updatedAt, ...(vote.changeId !== input.changeId ? { superseded: true } : {}) };
      } catch (error) {
        if (!(error instanceof DocumentationV3Error && error.status === 409) || attempt === 3) throw error;
        await Promise.all([...candidates.keys()].map(async path => {
          const stored = await store.get(path);
          current.set(path, stored);
          await cache.set(cacheKey(path), stored);
        }));
      }
    }
    throw new DocumentationV3Error(409, 'Telemetry is being updated concurrently. Please retry.');
  };
}

export async function readManagedTelemetry(projectId: string, writer: FirestoreWriter, since: number | null, masterKey?: string) {
  const where = since === null ? [] : [{ field: 'date', op: 'GREATER_THAN_OR_EQUAL' as const, string: new Date(since).toISOString().slice(0, 10) }];
  const [visits, votes] = await Promise.all(['visits', 'votes'].map(collection =>
    writer.query(collection, { parent: parentPath(projectId), where, orderBy: 'date', max: 50000 })));
  const profiles = new Map<string, { id: string; data: Record<string, unknown> }>();
  const decode = (document: QueryDocument) => {
    const value = decrypt(documentationEncryptionRoot(masterKey), projectId, document.path, document.data);
    profiles.set(value.uid, { id: value.uid, data: { email: value.email, displayName: value.displayName } });
    return value;
  };
  return {
    visits: visits!.documents.map(document => {
      const value = decode(document);
      if (value.kind !== 'visit') throw new DocumentationV3Error(502, 'Invalid encrypted visit collection.');
      return { ...document, data: { ...value, openedAt: new Date(value.openedAt).toISOString() } };
    }),
    votes: votes!.documents.map(document => {
      const value = decode(document);
      if (value.kind !== 'vote') throw new DocumentationV3Error(502, 'Invalid encrypted feedback collection.');
      return { ...document, id: value.uid, data: value };
    }),
    profiles, truncated: visits!.truncated || votes!.truncated
  };
}

/** Re-key stored reader telemetry when a project moves (see issueRecords in issues.ts). */
export const telemetryRecords = {
  collections: (projectId: string) => [parentPath(projectId) + '/visits', parentPath(projectId) + '/votes'],
  open: (root: Buffer, projectId: string, path: string, data: unknown) => decrypt(root, projectId, path, data),
  seal: (root: Buffer, projectId: string, path: string, value: ReturnType<typeof decrypt>) => encrypt(root, projectId, path, value)
};
