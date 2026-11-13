import { redisRestEnv } from './config.js';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { createCiphertextCache, ciphertextCacheKey } from './ciphertext-cache.js';
import { canonical, createV3FirestoreStore, DocumentationV3Error, v3Audit, v3Scope, type V3Access, type V3Scope, type V3Store, type v3Request } from './documentation-v3.js';
import { createV3Repository } from './v3-repository.js';
import type { Bundle, CryptoCore, Environment, RecordData, ReleaseMetadata } from './v3-client.js';
import { releaseNotesSchema } from './v3-client.js';
import { qualityReport } from './quality.js';
import { mergeSourceBaselines, sourceBaselineRecord, type SourceBaseline, type SourceBaselineRecord } from './source-baselines.js';

const core: CryptoCore & {
  decryptManifest(release: unknown, scope: V3Scope, key: string): Promise<{ metadata?: ReleaseMetadata }>;
} = createRequire(import.meta.url)('../vendor/documentation-v3.js');
const processSigningKey = randomBytes(32).toString('hex');
let sharedCache: ReturnType<typeof createCiphertextCache> | undefined;
function defaultCache() {
  if (!sharedCache) {
    const { url, token } = redisRestEnv();
    sharedCache = createCiphertextCache({ ...(url && token ? { redis: { url, token } } : {}) });
  }
  return sharedCache;
}
export type ManagedAccess = Pick<V3Access, 'projectId' | 'firebaseProject' | 'serviceAccountKey' | 'environments' | 'role'>;
export interface ManagedOptions {
  fetchService?: typeof fetch | undefined;
  masterKey?: string | undefined;
  store?: V3Store | undefined;
  cache?: ReturnType<typeof createCiphertextCache> | undefined;
  releaseCacheSigningKey?: string | undefined;
  /** The email recorded as the author of each release this service publishes. */
  actor?: string | undefined;
}
const headSchema = z.object({ format: z.literal(3), releaseId: z.uuid(), generation: z.number().int().positive(), keyId: z.uuid() });
const markerSchema = z.strictObject({ format: z.literal(3), encryption: z.literal('server-managed'),
  scope: v3Scope, mac: z.string().regex(/^[a-f0-9]{64}$/) });
export function readDocumentationEncryptionKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.MCP_DOCUMENTATION_ENCRYPTION_KEY || undefined;
  if (key !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').length !== 32 ||
      Buffer.from(key, 'base64url').toString('base64url') !== key)) {
    throw new Error('MCP_DOCUMENTATION_ENCRYPTION_KEY must be a private canonical base64url encoding of 32 random bytes.');
  }
  if (key && (key === env.MCP_VALIDATION_SIGNING_KEY || key === env.MCP_BEARER_TOKEN)) {
    throw new Error('Use a separate private documentation encryption key, not a signing key or client bearer token.');
  }
  return key;
}

/**
 * Content keys brought over from another server when a project moves (exported from the hosted dashboard or another
 * self-hosted MCP). Each key opens only its own project and environment scope; the other server's master key never
 * travels. The first publication after a move rotates to a key derived from this server's own master key.
 */
const importedKeys = new Map<string, Map<string, string>>();
const IMPORTED_KEY = /^[A-Za-z0-9_-]{43}$/;
export function registerImportedKeys(projectId: string, keys: Record<string, string>): void {
  const entries = Object.entries(keys);
  for (const [keyId, key] of entries) {
    if (!z.uuid().safeParse(keyId).success || !IMPORTED_KEY.test(key)) throw new Error('Imported keys map a key ID (UUID) to a 43-character base64url content key.');
  }
  const known = importedKeys.get(projectId) ?? new Map<string, string>();
  for (const [keyId, key] of entries) known.set(keyId, key);
  importedKeys.set(projectId, known);
}
export function forgetImportedKeys(projectId: string): void { importedKeys.delete(projectId); importedDataKeys.delete(projectId); }
const importedKey = (scope: V3Scope) => importedKeys.get(scope.projectId)?.get(scope.keyId);

/**
 * Per-project keys for the project's other encrypted data: issues, issue attachments, reader telemetry (per environment
 * and kind) and the profile cache. Each is derived from the master key with its own label, so each must travel on its own
 * when a project moves. An imported key replaces the derived one for that project only.
 */
export const DATA_KEY_LABELS = {
  issues: 'documentation-v3-issues-key',
  'issue-attachments': 'documentation-v3-issue-attachments-key',
  telemetry: 'documentation-v3-telemetry-key',
  profile: 'documentation-v3-profile-key'
} as const;
export type DataKeyPurpose = keyof typeof DATA_KEY_LABELS;
export interface DataKey { purpose: DataKeyPurpose; environment?: Environment | undefined; kind?: 'visit' | 'vote' | undefined; key: string }
const importedDataKeys = new Map<string, Map<string, Buffer>>();
const dataScope = (projectId: string, purpose: DataKeyPurpose, environment?: string, kind?: string) =>
  purpose === 'telemetry' ? { projectId, environment, kind } : { projectId };
const dataKeyId = (label: string, scope: Record<string, unknown>) => label + '\0' + canonical(scope);
/** The key for one kind of project data: imported for a moved project, otherwise derived from this server's master key. */
export function projectDataKey(root: Buffer, label: string, scope: Record<string, unknown> & { projectId: string }): Buffer {
  return importedDataKeys.get(scope.projectId)?.get(dataKeyId(label, scope))
    ?? createHmac('sha256', root).update(label + '\0' + canonical(scope)).digest();
}
export function registerImportedDataKeys(projectId: string, keys: DataKey[]): void {
  const known = importedDataKeys.get(projectId) ?? new Map<string, Buffer>();
  for (const entry of keys) {
    if (!IMPORTED_KEY.test(entry.key) || !(entry.purpose in DATA_KEY_LABELS)) throw new Error('Imported data keys need a known purpose and a 43-character base64url key.');
    if (entry.purpose === 'telemetry' && (!entry.environment || !entry.kind)) throw new Error('Telemetry keys need an environment and a kind.');
    known.set(dataKeyId(DATA_KEY_LABELS[entry.purpose], dataScope(projectId, entry.purpose, entry.environment, entry.kind)), Buffer.from(entry.key, 'base64url'));
  }
  importedDataKeys.set(projectId, known);
}
export function forgetImportedDataKeys(projectId: string): void { importedDataKeys.delete(projectId); }
/** Every data key of one project, for moving it to another server. The master key itself never leaves. */
export function exportDataKeys(projectId: string, environments: readonly Environment[], masterKey?: string): DataKey[] {
  const root = documentationEncryptionRoot(masterKey);
  const one = (purpose: DataKeyPurpose, environment?: Environment, kind?: 'visit' | 'vote'): DataKey => ({
    purpose, ...(environment ? { environment } : {}), ...(kind ? { kind } : {}),
    key: projectDataKey(root, DATA_KEY_LABELS[purpose], dataScope(projectId, purpose, environment, kind)).toString('base64url')
  });
  return [one('issues'), one('issue-attachments'), one('profile'),
    ...environments.flatMap(environment => (['visit', 'vote'] as const).map(kind => one('telemetry', environment, kind)))];
}

export function documentationEncryptionRoot(masterKey?: string) {
  const text = masterKey ?? readDocumentationEncryptionKey();
  if (!text || !/^[A-Za-z0-9_-]{43}$/.test(text) || Buffer.from(text, 'base64url').toString('base64url') !== text) {
    throw new DocumentationV3Error(503, 'Server-managed documentation encryption is not configured. An operator must configure MCP_DOCUMENTATION_ENCRYPTION_KEY.');
  }
  return Buffer.from(text, 'base64url');
}

export function createManagedDocumentation(access: ManagedAccess, options: ManagedOptions = {}) {
  const store = options.store ?? createV3FirestoreStore({ ...access, name: '', userId: '', email: '', administrator: false }, options.fetchService);
  const cache = options.cache ?? defaultCache();
  const signingKey = options.releaseCacheSigningKey ?? process.env.MCP_VALIDATION_SIGNING_KEY ?? processSigningKey;
  const repository = (environment: Environment) => createV3Repository(access, environment, store, cache, signingKey);
  const allowed = (environment: Environment) => {
    if (!access.environments.includes(environment)) throw new DocumentationV3Error(403, 'Environment access denied.');
  };
  const root = () => documentationEncryptionRoot(options.masterKey);
  const markerMac = (scope: V3Scope) => createHmac('sha256', root()).update('documentation-v3-managed-key-marker\0' + canonical(scope)).digest('hex');
  const derive = (scope: V3Scope) => createHmac('sha256', root()).update('documentation-v3-content-key\0' + canonical(scope)).digest('base64url');
  const markerKey = (scope: V3Scope) => ciphertextCacheKey(access.firebaseProject, access.projectId, scope.environment, 'managed-key:' + scope.keyId);
  async function contentKey(scope: V3Scope) {
    allowed(scope.environment);
    if (scope.projectId !== access.projectId) throw new DocumentationV3Error(403, 'Key scope does not match the authorized project.');
    const imported = importedKey(scope);
    if (imported) {
      // Signed by the previous server's master key, so only the scope can be checked here; decryption verifies the key.
      const marker = await store.get('documentationV3ManagedKeys/' + scope.keyId);
      if (!marker || canonical(markerSchema.parse(marker.data).scope) !== canonical(scope)) {
        throw new DocumentationV3Error(409, 'The imported key does not match this environment. Export the project again.');
      }
      return imported;
    }
    const expected = markerMac(scope);
    await cache.get(markerKey(scope), value => {
      const marker = markerSchema.parse(value);
      if (canonical(marker.scope) !== canonical(scope) ||
          !timingSafeEqual(Buffer.from(marker.mac, 'hex'), Buffer.from(expected, 'hex'))) {
        throw new DocumentationV3Error(503, 'The managed encryption key does not match this environment. Restore the correct server key.');
      }
      return marker;
    }, async () => {
      const marker = await store.get('documentationV3ManagedKeys/' + scope.keyId);
      if (!marker) throw new DocumentationV3Error(409, 'This release uses a personal E2EE key, not server-managed encryption. It must be explicitly decrypted and migrated before hosted access is possible.');
      return markerSchema.parse(marker.data);
    });
    return derive(scope);
  }
  async function head(environment: Environment) {
    allowed(environment);
    const pointer = await store.get('documentationV3Environments/' + environment);
    if (!pointer) return { head: null, release: null };
    const { format: _format, ...current } = headSchema.parse(pointer.data);
    const release = await repository(environment).readRelease(current.releaseId);
    if (current.keyId !== release.scope.keyId) throw new DocumentationV3Error(502, 'Encrypted pointer key does not match its release.');
    return { head: current, release };
  }
  async function read(environment: Environment, releaseId?: string) {
    const current = await head(environment);
    const id = releaseId ?? current.head?.releaseId;
    if (!id) throw new DocumentationV3Error(404, 'No encrypted documentation is published in this environment.');
    const release = releaseId ? await repository(environment).readRelease(releaseId) : current.release!;
    const key = await contentKey(release.scope);
    const bundles: Bundle[] = [];
    for (let offset = 0; offset < release.bundles.length; offset += 4) {
      bundles.push(...await Promise.all(release.bundles.slice(offset, offset + 4).map(bundle => repository(environment).readBundle(bundle, id))));
    }
    const details = await core.decryptSnapshotDetails(release, bundles, release.scope, key);
    return { head: current.head, release, bundles, ...details, sourceBaselines: await readBaselines(environment, id) };
  }
  async function readBaselines(environment: Environment, releaseId: string): Promise<SourceBaselineRecord | null> {
    allowed(environment);
    const stored = await store.get('documentationV3SourceBaselines/' + releaseId);
    if (!stored) return null;
    const record = sourceBaselineRecord.parse(stored.data);
    if (record.projectId !== access.projectId || record.environment !== environment || record.releaseId !== releaseId) {
      throw new DocumentationV3Error(403, 'Source baseline does not match the authorized release.');
    }
    return record;
  }
  /** The author and time of a release, when it was published with an actor. */
  async function audit(releaseId: string): Promise<{ author?: string; publishedAt?: string }> {
    const stored = await store.get('documentationV3Audit/' + releaseId);
    const parsed = v3Audit.safeParse(stored?.data);
    return parsed.success && parsed.data.releaseId === releaseId ? { author: parsed.data.actor, publishedAt: parsed.data.createdAt } : {};
  }
  return {
    head, read, audit,
    async sourceBaselines(environment: Environment, releaseId?: string) {
      const current = await head(environment);
      const id = releaseId ?? current.head?.releaseId;
      if (!id) throw new DocumentationV3Error(404, 'No published release is available for source-baseline lookup.');
      if (releaseId) await repository(environment).readRelease(releaseId);
      return readBaselines(environment, id);
    },
    async registerSourceBaselines(environment: Environment, releaseId: string, repositories: SourceBaseline[]) {
      allowed(environment);
      if (!['owner', 'admin'].includes(access.role) && !(access.role === 'author' && environment === 'development')) {
        throw new DocumentationV3Error(403, 'Only owners/admins, or authors in Development, can record source baselines.');
      }
      const current = await head(environment);
      if (current.head?.releaseId !== releaseId) throw new DocumentationV3Error(409, 'The current release changed. Reload before recording its source baseline.');
      if (!store.registerSourceBaselines) throw new DocumentationV3Error(503, 'Source-baseline registration is unavailable for this store.');
      return store.registerSourceBaselines(sourceBaselineRecord.parse({version: 1, projectId: access.projectId, environment,
        releaseId, repositories, recordedAt: new Date().toISOString(), recordedBy: options.actor ?? 'mcp'}));
    },
    async authorizeRelease(environment: Environment, releaseId: string) {
      allowed(environment);
      const release = await repository(environment).readRelease(releaseId);
      await contentKey(release.scope);
      return release;
    },
    async history(environment: Environment) {
      const current = await head(environment);
      if (!current.head) return [];
      const stored = await store.get('documentationV3History/' + environment);
      const history = stored ? z.object({
        projectId: z.uuid(), environment: z.enum(['development', 'beta', 'production']), releases: z.array(z.uuid()).max(100)
      }).parse(stored.data) : null;
      if (history && (history.projectId !== access.projectId || history.environment !== environment)) {
        throw new DocumentationV3Error(403, 'History does not match the authorized scope.');
      }
      const ids = [...new Set([current.head.releaseId, ...(history?.releases ?? [])])].slice(0, 20);
      const releases: ({ releaseId: string; articles: number; author?: string; publishedAt?: string } & Partial<ReleaseMetadata>)[] = [];
      for (const releaseId of ids) {
        const release = await repository(environment).readRelease(releaseId);
        const manifest = await core.decryptManifest(release, release.scope, await contentKey(release.scope));
        releases.push({ releaseId, articles: release.recordCount - 1, ...manifest.metadata, ...await audit(releaseId) });
      }
      return releases;
    },
    /**
     * The content keys of every encrypted release this project still lists (current release and history), for moving
     * the project to another server. Only owners and admins may export; the master key never leaves this server.
     */
    async exportKeys() {
      if (!['owner', 'admin'].includes(access.role)) throw new DocumentationV3Error(403, 'Only owners and admins can export encryption keys.');
      const keys: { environment: Environment; keyId: string; key: string }[] = [];
      const seen = new Set<string>();
      for (const environment of access.environments) {
        const current = await head(environment);
        if (!current.head) continue;
        const stored = await store.get('documentationV3History/' + environment);
        const listed = stored ? z.object({ releases: z.array(z.uuid()).max(100) }).safeParse(stored.data).data?.releases ?? [] : [];
        for (const releaseId of new Set([current.head.releaseId, ...listed])) {
          const release = await repository(environment).readRelease(releaseId).catch(() => null);
          if (!release || seen.has(release.scope.keyId)) continue;
          seen.add(release.scope.keyId);
          keys.push({ environment, keyId: release.scope.keyId, key: await contentKey(release.scope) });
        }
      }
      return keys;
    },
    async key(scope: V3Scope) {
      v3Scope.parse(scope);
      if (scope.projectId !== access.projectId) throw new DocumentationV3Error(403, 'Key scope does not match the authorized project.');
      const current = await head(scope.environment);
      if (!current.release || canonical(current.release.scope) !== canonical(scope)) {
        throw new DocumentationV3Error(409, 'The current release changed. Reload before requesting its key.');
      }
      return contentKey(scope);
    },
    async publish(environment: Environment, input: {
      records: RecordData[]; expected: string; metadata: ReleaseMetadata;
      expectedSource?: { environment: Environment; releaseId: string; legacy?: boolean } | undefined;
      expectedLegacy?: string | undefined; rotate?: boolean | undefined;
      sourceBaselines?: SourceBaseline[] | undefined;
    }) {
      allowed(environment);
      if (!['owner', 'admin'].includes(access.role) && !(access.role === 'author' && environment === 'development')) {
        throw new DocumentationV3Error(403, 'Publishing is not allowed in this environment.');
      }
      if (input.expectedSource) allowed(input.expectedSource.environment);
      const foundation = input.records.find(record => record.key === 'foundation');
      if (!foundation || !foundation.data || typeof foundation.data !== 'object' ||
          !('schemaVersion' in foundation.data) || foundation.data.schemaVersion !== 2) {
        throw new DocumentationV3Error(400, 'V3 publication requires an approved complete snapshot using the dynamic content schema (schemaVersion:2). Use migrate_documentation_to_v3 for published legacy documentation.');
      }
      const current = await head(environment);
      if ((current.head?.releaseId ?? 'empty') !== input.expected) throw new DocumentationV3Error(409, 'The current release changed. Reload before publishing.');
      if ((!current.head || input.rotate) && !['owner', 'admin'].includes(access.role)) {
        throw new DocumentationV3Error(403, 'Only owners and admins initialize or rotate an encrypted environment.');
      }
      if (!current.head && !input.expectedLegacy && await store.get('documentationEnvironments/' + environment)) {
        throw new DocumentationV3Error(409, 'This environment has a legacy release. Use migrate_documentation_to_v3 to export and pin its complete current snapshot.');
      }
      const previous = current.head ? await read(environment) : undefined;
      // A key imported from another server is never reused: the next release moves to this server's own key.
      const rotate = input.rotate || Boolean(previous && importedKey(previous.release.scope));
      const scope = previous && !rotate ? previous.release.scope : { projectId: access.projectId, environment, keyId: randomUUID() };
      const key = previous && !rotate ? await contentKey(scope) : derive(scope);
      const encrypted = await core.encryptSnapshot(input.records, scope, key,
        previous && !rotate ? { release: previous.release, bundles: previous.bundles } : undefined, input.metadata);
      const marker = { format: 3, encryption: 'server-managed', scope, mac: markerMac(scope) };
      await store.immutable('documentationV3ManagedKeys/' + scope.keyId, marker);
      const warnings = await cache.set(markerKey(scope), marker);
      const existing = new Set(previous?.release.bundles ?? []);
      // A first publication of a large project writes up to 256 bundles: write 8 at a time so it fits the function time limit.
      const fresh = encrypted.bundles.filter(bundle => !existing.has(bundle.id));
      for (let offset = 0; offset < fresh.length; offset += 8) {
        const results = await Promise.all(fresh.slice(offset, offset + 8).map(async bundle => {
          await store.immutable('documentationV3Bundles/' + bundle.id, bundle.data as Record<string, unknown>);
          return cache.set(ciphertextCacheKey(access.firebaseProject, access.projectId, environment, bundle.id), bundle);
        }));
        for (const result of results) warnings.push(...result);
      }
      const releaseId = randomUUID();
      const release = (await import('./documentation-v3.js')).v3Release.parse(encrypted.release);
      const previousBaselines = previous?.sourceBaselines?.repositories ?? [];
      const baselines = input.metadata.operation === 'promote' || input.metadata.operation === 'rollback' ? input.sourceBaselines ?? [] :
        input.sourceBaselines ? mergeSourceBaselines(previousBaselines, input.sourceBaselines) : previousBaselines;
      const generation = await store.publish({ releaseId, expected: input.expected, release,
        expectedSource: input.expectedSource, expectedLegacy: current.head ? undefined : input.expectedLegacy ?? 'empty', actor: options.actor,
        ...(baselines.length ? {sourceBaselines: baselines} : {}) });
      warnings.push(...await repository(environment).saveRelease(releaseId, release));
      return { releaseId, generation, articles: input.records.length - 1, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
    }
  };
}

export async function handleManagedDocumentation(access: V3Access, input: z.infer<typeof v3Request>, options: ManagedOptions = {}) {
  const service = createManagedDocumentation(access, options);
  const environment = input.environment ?? ('scope' in input ? input.scope?.environment : undefined) ?? access.environments[0];
  if (!environment || !access.environments.includes(environment)) throw new DocumentationV3Error(403, 'Environment access denied.');
  if (input.action === 'key.get') {
    if (input.scope.environment !== environment) throw new DocumentationV3Error(403, 'Key scope does not match the requested environment.');
    return { key: await service.key(input.scope) };
  }
  if (input.action === 'snapshot.get') {
    const snapshot = await service.read(environment);
    const result = { head: snapshot.head, records: snapshot.records, ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}) };
    if (Buffer.byteLength(JSON.stringify(result)) > 3 * 1024 * 1024) {
      throw new DocumentationV3Error(413, 'Snapshot exceeds the single-response limit. Read it through head, key.get and bounded bundle.get requests.');
    }
    return result;
  }
  if (input.action !== 'snapshot.publish') throw new DocumentationV3Error(400, 'Unknown managed documentation action.');
  if (!['owner', 'admin'].includes(access.role) && !(access.role === 'author' && environment === 'development')) {
    throw new DocumentationV3Error(403, 'Publishing is not allowed in this environment.');
  }
  const notes = releaseNotesSchema.parse({ version: input.version, tags: input.tags, summary: input.summary });
  let normalized: ReturnType<CryptoCore['normalize']>;
  try { normalized = core.normalize(input.records); }
  catch (error) {
    if (error instanceof Error && /^(Invalid|Documentation)/.test(error.message)) throw new DocumentationV3Error(400, error.message);
    throw error;
  }
  const report = z.object({
    unmapped: z.array(z.unknown()), brokenLinks: z.array(z.unknown()), droppedNavigation: z.array(z.unknown()), warnings: z.array(z.unknown())
  }).parse(normalized.report);
  if (!input.approveConversion && (canonical(input.records) !== canonical(normalized.records) ||
      report.unmapped.length + report.brokenLinks.length + report.droppedNavigation.length + report.warnings.length > 0)) {
    return { published: false, requiresApproval: true, conversion: normalized.report };
  }
  const quality = qualityReport(normalized.records, undefined, undefined, { requireAudienceCoverage: true, complete: true, publicationVersion: notes.version });
  if (!quality.ok) throw new DocumentationV3Error(400, 'Snapshot has quality issues: ' +
    quality.issues.slice(0, 5).map(issue => issue.key + ' ' + issue.code + ': ' + issue.message).join(' | '));
  const result = await service.publish(environment, { records: normalized.records, expected: input.expected,
    metadata: { ...notes, operation: 'apply' }, rotate: input.rotate });
  return { ...result, published: true };
}
