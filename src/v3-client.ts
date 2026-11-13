import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export type Environment = 'development' | 'beta' | 'production';
export interface Context { project: string; workspace?: string | undefined; environment: Environment }
export interface Scope { projectId: string; environment: Environment; keyId: string }
export type JsonObject = Record<string, unknown>;
export interface RecordData extends JsonObject { key: string; data: unknown }
export interface Bundle { id: string; data: unknown }
export interface Release { format: 3; scope: Scope; manifest: unknown; bundles: string[]; recordCount: number }
export const releaseNotesSchema = z.strictObject({
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  tags: z.array(z.enum(['New', 'Changed', 'Hotfix'])).min(1).max(3).refine(tags => new Set(tags).size === tags.length),
  summary: z.string().trim().min(1).max(4000)
});
export type ReleaseNotes = z.infer<typeof releaseNotesSchema>;
export interface ReleaseMetadata extends ReleaseNotes {
  operation: 'apply' | 'promote' | 'rollback' | 'import';
  sourceRelease?: string;
  rollbackRelease?: string;
}
export interface SnapshotDetails { records: RecordData[]; metadata?: ReleaseMetadata }
export interface CryptoCore {
  validateRelease?(release: unknown, scope?: Scope): Release;
  validateEnvelope?(envelope: unknown, scope?: Scope): unknown;
  validateVault?(vault: unknown): unknown;
  validateGrant?(grant: unknown, scope?: Scope): unknown;
  normalize(records: unknown[]): { records: RecordData[]; report: unknown };
  unlockVault(vault: unknown, secret: string, recovery?: boolean): Promise<CryptoKey>;
  createScopeKey(): string | Promise<string>;
  wrapKey(scope: Scope, key: string, publicKey: unknown): Promise<unknown>;
  unwrapKey(scope: Scope, grant: unknown, privateKey: CryptoKey): Promise<string>;
  encryptSnapshot(records: RecordData[], scope: Scope, key: string,
    previous?: { release: Release; bundles: Bundle[] }, metadata?: ReleaseMetadata): Promise<{ release: Release; bundles: Bundle[] }>;
  decryptSnapshot(release: Release, bundles: Bundle[], scope: Scope, key: string): Promise<RecordData[]>;
  decryptSnapshotDetails(release: Release, bundles: Bundle[], scope: Scope, key: string): Promise<SnapshotDetails>;
}

const envSchema = z.enum(['development', 'beta', 'production']);
const scopeSchema = z.object({ projectId: z.uuid(), environment: envSchema, keyId: z.uuid() });
const releaseSchema = z.object({
  format: z.literal(3), scope: scopeSchema, manifest: z.unknown(),
  bundles: z.array(z.string().min(1).max(200)).max(2000), recordCount: z.number().int().min(1).max(2000)
});
const accessSchema = z.object({
  projectId: z.uuid(), name: z.string(), role: z.enum(['owner', 'admin', 'author', 'viewer']),
  environments: z.array(envSchema), userId: z.uuid(), email: z.string()
});
type Access = z.infer<typeof accessSchema>;
const headSchema = z.object({
  head: z.object({ releaseId: z.uuid(), generation: z.number().int().nonnegative(), keyId: z.uuid() }).nullable(),
  release: releaseSchema.nullable()
});
type Head = z.infer<typeof headSchema>;

export class V3ClientError extends Error {
  constructor(message: string, readonly code = 'V3_ERROR') { super(message); this.name = 'V3ClientError'; }
}

/** Memory-only, byte-bounded LRU. Encrypted and decrypted entries never touch disk. */
class MemoryCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number; expires: number }>();
  private bytes = 0;
  constructor(private readonly limit: number, private readonly ttl: number) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires <= Date.now()) { this.bytes -= entry.bytes; return undefined; }
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const old = this.entries.get(key);
    if (old) { this.entries.delete(key); this.bytes -= old.bytes; }
    if (bytes > this.limit) return;
    while (this.bytes + bytes > this.limit) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.bytes -= this.entries.get(first)!.bytes;
      this.entries.delete(first);
    }
    this.entries.set(key, { value, bytes, expires: Date.now() + this.ttl });
    this.bytes += bytes;
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}

export interface ClientOptions {
  endpoint: string;
  token: string;
  password?: string | undefined;
  recoveryCode?: string | undefined;
  core?: CryptoCore;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  encryptedCacheBytes?: number;
  plaintextCacheBytes?: number;
  plaintextTtlMs?: number;
}
export interface PublishInput extends Context, ReleaseNotes {
  confirmed: true;
  expected: string;
  records: unknown[];
  approveConversion?: boolean | undefined;
  sourceReview: {
    repositories: { name: string; role: string; sourceFiles: number; filesRead: number }[];
    areas: string[];
    unread?: string[] | undefined;
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(value: unknown): JsonObject {
  if (!isObject(value)) throw new V3ClientError('Invalid encrypted backend response.', 'PROTOCOL');
  return value;
}
function containsLoss(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsLoss);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    (/drop|unmapped|loss|broken|error/i.test(key) && item !== false && item !== null && item !== undefined
      && item !== 0 && item !== '' && !(Array.isArray(item) && item.length === 0)
      && !(isObject(item) && Object.keys(item).length === 0)) || containsLoss(item));
}

export class V3Client {
  private readonly endpoint: string;
  private readonly token: string;
  private secret: string | undefined;
  private readonly recovery: boolean;
  private privateKey: CryptoKey | undefined;
  private vaultPublicKey: unknown;
  private readonly core: CryptoCore;
  private readonly fetchService: typeof fetch;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private readonly encrypted: MemoryCache<Bundle>;
  private readonly plaintext: MemoryCache<SnapshotDetails>;

  constructor(options: ClientOptions) {
    const url = new URL(options.endpoint);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      throw new V3ClientError('MCP_V3_ENDPOINT must be an exact HTTPS origin (HTTP only on loopback).', 'CONFIG');
    }
    if (!/^dmcp_[A-Za-z0-9_-]+$/.test(options.token)) throw new V3ClientError('A personal dmcp_ token is required.', 'CONFIG');
    this.endpoint = url.origin + '/api/documentation-v3';
    this.token = options.token;
    this.secret = options.recoveryCode || options.password;
    this.recovery = !!options.recoveryCode;
    if (!this.secret) throw new V3ClientError('Set MCP_V3_UNLOCK_PASSWORD or MCP_V3_RECOVERY_CODE in the local process environment.', 'CONFIG');
    // The vendor is shared with the browser; Node 20.19+ supports its CommonJS boundary.
    this.core = options.core ?? createRequire(import.meta.url)('../vendor/documentation-v3.js');
    this.fetchService = options.fetch ?? fetch;
    this.timeout = options.requestTimeoutMs ?? 20_000;
    this.maxBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
    this.encrypted = new MemoryCache(options.encryptedCacheBytes ?? 32 * 1024 * 1024, 2 * 60 * 60 * 1000);
    this.plaintext = new MemoryCache(options.plaintextCacheBytes ?? 16 * 1024 * 1024, options.plaintextTtlMs ?? 5 * 60 * 1000);
  }

  close(): void { this.clear(); this.secret = undefined; }
  private clear(): void {
    this.plaintext.clear(); this.encrypted.clear(); this.privateKey = undefined; this.vaultPublicKey = undefined;
  }

  private async request(action: string, context: Context, fields: JsonObject = {}): Promise<JsonObject> {
    // Never spread caller inputs: publish/search inputs contain local-only plaintext.
    const body = JSON.stringify({ action, project: context.project, environment: context.environment,
      ...(context.workspace ? { workspace: context.workspace } : {}), ...fields });
    if (Buffer.byteLength(body) > this.maxBytes) throw new V3ClientError('Encrypted request exceeds the body limit.', 'BODY_LIMIT');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchService(this.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body, redirect: 'error', signal: controller.signal
      });
      if (!response.ok) {
        // Never echo remote errors: they can include reflected credentials or ciphertext.
        if (response.status === 401 || response.status === 403) this.clear();
        await response.body?.cancel();
        throw new V3ClientError(`Encrypted backend refused ${action} (HTTP ${response.status}).`,
          response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'REMOTE');
      }
      const advertised = Number(response.headers.get('content-length'));
      if (advertised > this.maxBytes) {
        await response.body?.cancel();
        throw new V3ClientError('Encrypted response exceeds the body limit.', 'BODY_LIMIT');
      }
      if (!response.body) throw new V3ClientError('Empty encrypted backend response.', 'PROTOCOL');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > this.maxBytes) {
            await reader.cancel();
            throw new V3ClientError('Encrypted response exceeds the body limit.', 'BODY_LIMIT');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      if (error instanceof V3ClientError) throw error;
      if (controller.signal.aborted) throw new V3ClientError('Encrypted backend request timed out.', 'TIMEOUT');
      throw new V3ClientError('Encrypted backend request or response failed.', 'PROTOCOL');
    } finally { clearTimeout(timer); }
  }

  private async current(context: Context): Promise<{ access: Access; state: Head }> {
    try {
      const access = accessSchema.parse((await this.request('access', context)).access);
      if (!access.environments.includes(context.environment)) throw new V3ClientError('Environment access denied.', 'ACCESS_DENIED');
      const state = headSchema.parse(await this.request('head', context));
      if ((state.head === null) !== (state.release === null)) throw new V3ClientError('Incomplete encrypted release pointer.', 'PROTOCOL');
      if (state.head && state.release && (state.release.scope.projectId !== access.projectId
        || state.release.scope.environment !== context.environment || state.release.scope.keyId !== state.head.keyId)) {
        throw new V3ClientError('Encrypted release scope does not match its authoritative head.', 'PROTOCOL');
      }
      if (state.release) this.core.validateRelease?.(state.release, state.release.scope);
      return { access, state };
    } catch (error) {
      // Fail closed even for malformed/failed authorization responses.
      this.clear();
      if (error instanceof V3ClientError) throw error;
      throw new V3ClientError('Invalid encrypted access or head response.', 'PROTOCOL');
    }
  }

  private async unlock(context: Context): Promise<CryptoKey> {
    if (this.privateKey) return this.privateKey;
    const { vault } = await this.request('vault.get', context);
    if (!isObject(vault) || !('publicKey' in vault)) throw new V3ClientError('Enroll an encryption vault in the dashboard first.', 'VAULT');
    if (!this.secret) throw new V3ClientError('Connector is closed.', 'CLOSED');
    try {
      this.core.validateVault?.(vault);
      this.privateKey = await this.core.unlockVault(vault, this.secret, this.recovery);
      this.vaultPublicKey = vault.publicKey;
      return this.privateKey;
    } catch {
      throw new V3ClientError('Cannot unlock the local encryption vault; check your password or recovery code.', 'UNLOCK');
    }
  }

  private async scopeKey(context: Context, scope: Scope): Promise<string> {
    try {
      const privateKey = await this.unlock(context);
      const { grant } = await this.request('grant.get', context, { scope });
      if (!grant) {
        throw new V3ClientError('No encryption grant for this environment. Ask an owner/admin to enroll you.', 'GRANT');
      }
      this.core.validateGrant?.(grant, scope);
      return await this.core.unwrapKey(scope, grant, privateKey);
    } catch (error) {
      this.clear();
      if (error instanceof V3ClientError) throw error;
      throw new V3ClientError('Cannot unwrap this environment key; the grant or vault does not match.', 'GRANT');
    }
  }

  private cacheKey(context: Context, access: Access, state: Head): string {
    return JSON.stringify([context.workspace ?? '', access.projectId, context.environment, access.userId,
      state.head?.keyId, state.head?.releaseId, state.head?.generation, state.release?.manifest, state.release?.bundles]);
  }

  private async snapshot(context: Context, access: Access, state: Head): Promise<SnapshotDetails> {
    if (!state.head || !state.release) throw new V3ClientError('No encrypted documentation has been published.', 'EMPTY');
    // Grants are live too: a revoked grant must not leave readable plaintext in this session.
    const key = await this.scopeKey(context, state.release.scope);
    const cacheKey = this.cacheKey(context, access, state) + createHash('sha256').update(key).digest('hex');
    const cached = this.plaintext.get(cacheKey);
    if (cached) return cached;
    const bundles = await this.bundles(context, state);
    try {
      const details = await this.core.decryptSnapshotDetails(state.release, bundles, state.release.scope, key);
      this.plaintext.set(cacheKey, details);
      return details;
    } catch {
      this.plaintext.clear();
      throw new V3ClientError('Encrypted snapshot authentication or completeness verification failed.', 'DECRYPT');
    }
  }

  private async bundles(context: Context, state: Head): Promise<Bundle[]> {
    if (!state.head || !state.release) throw new V3ClientError('No encrypted release is available.', 'EMPTY');
    const bundles: Bundle[] = [];
    for (const id of state.release.bundles) {
      const bundleKey = JSON.stringify([state.release.scope, id]);
      let bundle = this.encrypted.get(bundleKey);
      if (!bundle) {
        const response = await this.request('bundle.get', context, { releaseId: state.head.releaseId, id });
        const parsed = z.object({ id: z.literal(id), data: z.unknown() }).parse(response.bundle);
        try { this.core.validateEnvelope?.(parsed.data, state.release.scope); }
        catch {
          this.clear();
          throw new V3ClientError('Invalid encrypted bundle envelope.', 'PROTOCOL');
        }
        bundle = parsed;
        this.encrypted.set(bundleKey, bundle);
      }
      bundles.push(bundle);
    }
    return bundles;
  }

  async read(context: Context, keys?: string[]): Promise<JsonObject> {
    const { access, state } = await this.current(context);
    const { records, metadata } = await this.snapshot(context, access, state);
    if (keys && keys.some(key => !records.some(record => record.key === key))) throw new V3ClientError('One or more requested articles do not exist.', 'NOT_FOUND');
    return { release: { ...state.head, ...metadata }, articles: records.filter(record => !keys || keys.includes(record.key)) };
  }

  async list(context: Context, offset = 0, limit = 200): Promise<JsonObject> {
    const { access, state } = await this.current(context);
    if (!state.head) return { release: null, articles: [], totalArticles: 0 };
    const { records, metadata } = await this.snapshot(context, access, state);
    const articles = records.filter(record => record.key !== 'foundation');
    return { release: { ...state.head, ...metadata }, foundation: records.find(record => record.key === 'foundation'),
      articles: articles.slice(offset, offset + limit).map(({ key, title, page }) => ({ key, title, page })),
      totalArticles: articles.length, ...(offset + limit < articles.length ? { nextOffset: offset + limit } : {}) };
  }

  async search(context: Context, query: string, limit = 20): Promise<JsonObject> {
    const { access, state } = await this.current(context);
    const { records, metadata } = await this.snapshot(context, access, state);
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const results = records.filter(record => record.key !== 'foundation')
      .map(record => ({ record, text: JSON.stringify(record).toLocaleLowerCase() }))
      .filter(({ text }) => terms.every(term => text.includes(term))).slice(0, limit)
      .map(({ record }) => ({ key: record.key, title: record.title, page: record.page }));
    return { release: { ...state.head, ...metadata }, results, note: 'Full article text searched locally; use read_published_documentation for content.' };
  }

  async changes(context: Context): Promise<JsonObject> {
    const { access, state } = await this.current(context);
    const metadata = state.head ? (await this.snapshot(context, access, state)).metadata : undefined;
    return { release: state.head ? { ...state.head, ...metadata } : null, changes: null,
      note: 'Release notes, when present, are authenticated encrypted manifest metadata. Per-article change details are unavailable and are not inferred.' };
  }

  async status(context: Context): Promise<JsonObject> {
    const { access, state } = await this.current(context);
    const metadata = state.head ? (await this.snapshot(context, access, state)).metadata : undefined;
    return { project: access.name, environment: context.environment,
      release: state.head ? { ...state.head, ...metadata } : null, expected: state.head?.releaseId ?? 'empty',
      ...(!metadata && state.head ? { note: 'This older encrypted release has no encrypted release notes; none are inferred.' } : {}) };
  }

  async publish(input: PublishInput, operation: 'apply' | 'import' = 'apply'): Promise<JsonObject> {
    if (input.confirmed !== true) throw new V3ClientError('Explicit user confirmation is required.', 'APPROVAL');
    const metadata = this.metadata(input, operation);
    if (input.expected !== 'empty' && !z.uuid().safeParse(input.expected).success) throw new V3ClientError('Expected must be a release UUID or empty.', 'CAS');
    const review = input.sourceReview;
    if (!review?.repositories.length || !review.areas.length || review.repositories.some(repo =>
      !Number.isInteger(repo.sourceFiles) || !Number.isInteger(repo.filesRead) || repo.sourceFiles < 1
      || repo.filesRead < repo.sourceFiles * 0.8 || repo.filesRead > repo.sourceFiles)) {
      throw new V3ClientError('Source review must cover at least 80% of each repository and identify the reviewed product areas.', 'SOURCE_REVIEW');
    }
    let normalized: ReturnType<CryptoCore['normalize']>;
    try { normalized = this.core.normalize(input.records); }
    catch { throw new V3ClientError('Complete local snapshot validation failed; include foundation and all navigated articles.', 'VALIDATION'); }
    if (containsLoss(normalized.report) && input.approveConversion !== true) {
      return { published: false, requiresConversionApproval: true, report: normalized.report };
    }
    if (JSON.stringify(normalized.records) !== JSON.stringify(input.records) && input.approveConversion !== true) {
      return { published: false, requiresConversionApproval: true, report: normalized.report };
    }
    return this.publishSnapshot(input, normalized.records, normalized.report, metadata);
  }

  private metadata(notes: unknown, operation: ReleaseMetadata['operation']): ReleaseMetadata {
    const parsed = releaseNotesSchema.safeParse(isObject(notes)
      ? { version: notes.version, tags: notes.tags, summary: notes.summary } : notes);
    if (!parsed.success) throw new V3ClientError('Valid release version, unique New/Changed/Hotfix tags and a nonempty summary are required.', 'METADATA');
    return { ...parsed.data, operation };
  }

  private async publishSnapshot(context: Context & { expected: string }, records: RecordData[], report: unknown,
    metadata: ReleaseMetadata, expectedSource?: { environment: Environment; releaseId: string }): Promise<JsonObject> {
    const { access, state } = await this.current(context);
    if (access.role === 'viewer' || (context.environment !== 'development' && access.role === 'author')) {
      throw new V3ClientError('Your role cannot publish to this environment.', 'ACCESS_DENIED');
    }
    if ((state.head?.releaseId ?? 'empty') !== context.expected) throw new V3ClientError('The release changed; review the current head before publishing.', 'CAS');
    let scope: Scope;
    let key: string;
    if (state.release) {
      scope = state.release.scope;
      key = await this.scopeKey(context, scope);
    } else {
      if (access.role !== 'owner' && access.role !== 'admin') throw new V3ClientError('An owner/admin must initialize this encrypted environment.', 'ACCESS_DENIED');
      scope = { projectId: access.projectId, environment: context.environment, keyId: randomUUID() };
      key = await this.core.createScopeKey();
      await this.unlock(context);
      const grant = await this.core.wrapKey(scope, key, this.vaultPublicKey);
      await this.request('grant.put', context, { scope, userId: access.userId, grant });
    }
    const previous = state.release ? { release: state.release, bundles: await this.bundles(context, state) } : undefined;
    const encrypted = await this.core.encryptSnapshot(records, scope, key, previous, metadata);
    this.core.validateRelease?.(encrypted.release, scope);
    const previousIds = new Set(previous?.release.bundles);
    // The crypto core authenticates reuse. Hash-identical bundles already exist remotely.
    for (const bundle of encrypted.bundles) {
      this.core.validateEnvelope?.(bundle.data, scope);
      if (!previousIds.has(bundle.id)) await this.request('bundle.put', context, { bundle });
    }
    const result = await this.request('publish', context, {
      releaseId: randomUUID(), expected: context.expected, release: encrypted.release,
      ...(expectedSource ? { expectedSource } : {})
    });
    this.plaintext.clear();
    return { ...result, metadata, report, note: 'Only encrypted snapshot data was uploaded. Owners/admins must grant enrolled readers access to newly initialized environments in the dashboard.' };
  }

  async promote(input: Context & { [K in keyof ReleaseNotes]?: ReleaseNotes[K] | undefined }
    & { target: Environment; expected: string; expectedSource: string; confirmed: true }): Promise<JsonObject> {
    if (input.confirmed !== true || input.target === input.environment) throw new V3ClientError('Confirm distinct source and target environments.', 'APPROVAL');
    if (!['development:beta', 'development:production', 'beta:production'].includes(`${input.environment}:${input.target}`)) {
      throw new V3ClientError('Unsupported promotion direction.', 'VALIDATION');
    }
    const { access, state } = await this.current(input);
    if (access.role !== 'owner' && access.role !== 'admin') throw new V3ClientError('Promotion requires owner/admin.', 'ACCESS_DENIED');
    if (!state.head || state.head.releaseId !== input.expectedSource) throw new V3ClientError('Source release changed.', 'CAS');
    const { records, metadata: sourceMetadata } = await this.snapshot(input, access, state);
    const metadata = { ...this.metadata({
      version: input.version ?? sourceMetadata?.version,
      tags: input.tags ?? sourceMetadata?.tags,
      summary: input.summary ?? sourceMetadata?.summary
    }, 'promote'), sourceRelease: input.expectedSource };
    // Scope-bound AAD forbids copying source ciphertext into a different environment.
    return this.publishSnapshot({ project: input.project, workspace: input.workspace, environment: input.target, expected: input.expected },
      records, null, metadata, { environment: input.environment, releaseId: input.expectedSource });
  }

  async rollback(input: Context & ReleaseNotes & { rollbackRelease: string; expected: string; confirmed: true }): Promise<JsonObject> {
    if (input.confirmed !== true || !z.uuid().safeParse(input.rollbackRelease).success) {
      throw new V3ClientError('Confirm a historical release UUID for rollback.', 'APPROVAL');
    }
    const metadata = { ...this.metadata(input, 'rollback'), rollbackRelease: input.rollbackRelease };
    const { access, state } = await this.current(input);
    if (access.role !== 'owner' && access.role !== 'admin') throw new V3ClientError('Rollback requires owner/admin.', 'ACCESS_DENIED');
    if (!state.head || state.head.releaseId !== input.expected) throw new V3ClientError('Target release changed.', 'CAS');
    const response = await this.request('release.get', input, { releaseId: input.rollbackRelease });
    const historical = releaseSchema.parse(response.release);
    if (historical.scope.projectId !== access.projectId || historical.scope.environment !== input.environment) {
      throw new V3ClientError('Historical release is outside the authorized environment.', 'PROTOCOL');
    }
    this.core.validateRelease?.(historical, historical.scope);
    const historicalState: Head = {
      head: { releaseId: input.rollbackRelease, generation: 0, keyId: historical.scope.keyId }, release: historical
    };
    const { records } = await this.snapshot(input, access, historicalState);
    // Historical release descriptors are immutable; target CAS protects the only mutable pointer.
    return this.publishSnapshot(input, records, null, metadata);
  }
}
