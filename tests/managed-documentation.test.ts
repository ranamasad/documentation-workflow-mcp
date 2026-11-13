import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCiphertextCache } from '../src/ciphertext-cache.js';
import { canonical, createDocumentationV3, DocumentationV3Error, type V3Access, type V3Store } from '../src/documentation-v3.js';
import { createManagedDocumentation, handleManagedDocumentation, readDocumentationEncryptionKey } from '../src/managed-documentation.js';
import type { RecordData, ReleaseMetadata } from '../src/v3-client.js';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const root = Buffer.alloc(32, 71).toString('base64url');
const access: V3Access = { projectId: '11111111-1111-4111-8111-111111111111', userId: null, name: 'Guide',
  role: 'owner', email: 'reader@example.com', administrator: true, environments: ['development', 'beta'],
  firebaseProject: 'test-project', serviceAccountKey: 'test-only' };
const metadata: ReleaseMetadata = { version: '1.0.0', tags: ['Changed'], summary: 'PRIVATE_RELEASE_NOTES', operation: 'apply' };
function fixture() {
  const records = JSON.parse(readFileSync('contract-v3/examples/v2-content.json', 'utf8')) as RecordData[];
  const foundation = records[0]!.data as { meta: { subtitle: string } };
  foundation.meta.subtitle = 'PRIVATE_DOCUMENTATION_CONTENT';
  const docs = new Map<string, Record<string, unknown>>();
  const reads: string[] = [];
  const cache = createCiphertextCache({ warn() {} });
  const store: V3Store = {
    async get(path) { reads.push(path); return docs.has(path) ? { data: docs.get(path)! } : null; },
    async getMany(paths) { return Promise.all(paths.map(path => store.get(path))); },
    async immutable(path, data) {
      if (docs.has(path)) assert.equal(canonical(docs.get(path)), canonical(data));
      docs.set(path, data);
    },
    async publish(input) {
      const env = input.release.scope.environment;
      const current = docs.get('documentationV3Environments/' + env);
      if ((current?.releaseId ?? 'empty') !== input.expected) throw new DocumentationV3Error(409, 'CAS conflict');
      if (input.expectedLegacy && (current || (docs.get('documentationEnvironments/' + env)?.releaseId ?? 'empty') !== input.expectedLegacy)) {
        throw new DocumentationV3Error(409, 'Legacy CAS conflict');
      }
      const generation = Number(current?.generation ?? 0) + 1;
      docs.set('documentationV3Releases/' + input.releaseId, input.release);
      docs.set('documentationV3Environments/' + env, { format: 3, releaseId: input.releaseId, generation, keyId: input.release.scope.keyId });
      return generation;
    }
  };
  const options = { masterKey: root, store, cache, releaseCacheSigningKey: 'test-validation-key' };
  return { records, docs, reads, options, service: createManagedDocumentation(access, options) };
}

test('managed publication stores only ciphertext, serves authorized content and reuses immutable bundles', async () => {
  const f = fixture();
  const first = await f.service.publish('development', { records: f.records, metadata, expected: 'empty' });
  const serialized = JSON.stringify([...f.docs]);
  assert.doesNotMatch(serialized, /PRIVATE_DOCUMENTATION_CONTENT|PRIVATE_RELEASE_NOTES/);
  assert.ok(!serialized.includes(root));
  const snapshot = await f.service.read('development');
  assert.deepEqual(snapshot.records, f.records);
  assert.deepEqual(snapshot.metadata, metadata);
  assert.match(await f.service.key(snapshot.release.scope), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(await f.service.key(snapshot.release.scope), root);
  const before = f.reads.length;
  await createManagedDocumentation(access, f.options).read('development');
  assert.deepEqual(f.reads.slice(before), ['documentationV3Environments/development', 'documentationV3SourceBaselines/' + first.releaseId]);
  const second = await f.service.publish('development', {
    records: f.records, metadata: { ...metadata, version: '1.0.1' }, expected: first.releaseId
  });
  const latest = await f.service.read('development');
  assert.equal(latest.head?.releaseId, second.releaseId);
  assert.deepEqual(latest.release.bundles, snapshot.release.bundles);
  await assert.rejects(f.service.publish('development', { records: f.records, metadata, expected: first.releaseId }), /current release changed/);
});

test('managed keys require current scope and access, and root key mismatch fails closed', async () => {
  const f = fixture();
  await f.service.publish('development', { records: f.records, metadata, expected: 'empty' });
  const first = await f.service.read('development');
  await assert.rejects(f.service.key({ ...first.release.scope, projectId: '22222222-2222-4222-8222-222222222222' }), /authorized project/);
  const denied = createManagedDocumentation({ ...access, environments: [] }, f.options);
  const before = f.reads.length;
  await assert.rejects(denied.read('development'), /access denied/);
  assert.equal(f.reads.length, before);
  const wrongRoot = createManagedDocumentation(access, { ...f.options, masterKey: Buffer.alloc(32, 72).toString('base64url') });
  await assert.rejects(wrongRoot.read('development'), /Restore the correct server key/);
  await f.service.publish('development', { records: f.records, metadata, expected: first.head!.releaseId, rotate: true });
  await assert.rejects(f.service.key(first.release.scope), /current release changed/);
});

test('managed publication cannot silently replace legacy content or allow viewer/author key initialization', async () => {
  const f = fixture();
  f.docs.set('documentationEnvironments/development', { releaseId: '22222222-2222-4222-8222-222222222222' });
  await assert.rejects(f.service.publish('development', { records: f.records, metadata, expected: 'empty' }), /migrate_documentation_to_v3/);
  await assert.rejects(f.service.publish('development', {
    records: f.records, metadata, expected: 'empty', expectedLegacy: '33333333-3333-4333-8333-333333333333'
  }), /Legacy CAS conflict/);
  await assert.rejects(createManagedDocumentation({ ...access, role: 'author' }, f.options).publish('development', {
    records: f.records, metadata, expected: 'empty'
  }), /Only owners and admins/);
  await assert.rejects(createManagedDocumentation({ ...access, role: 'viewer' }, f.options).publish('development', {
    records: f.records, metadata, expected: 'empty'
  }), /Publishing is not allowed/);
});

test('managed configuration is explicit, private and canonical', () => {
  assert.equal(readDocumentationEncryptionKey({}), undefined);
  assert.equal(readDocumentationEncryptionKey({ MCP_DOCUMENTATION_ENCRYPTION_KEY: root }), root);
  assert.throws(() => readDocumentationEncryptionKey({ MCP_DOCUMENTATION_ENCRYPTION_KEY: 'password' }), /32 random bytes/);
});

test('public managed snapshot publication enforces editorial and audience quality before writes', async () => {
  const f = fixture();
  await assert.rejects(handleManagedDocumentation(access, { action: 'snapshot.publish', project: access.projectId,
    environment: 'development', records: f.records, expected: 'empty', confirmed: true, approveConversion: true,
    version: '1.0.0', tags: ['New'], summary: 'Unreviewed snapshot.' }, f.options), /quality issues/);
  assert.equal(f.docs.size, 0);
});

test('managed API supports website-only Firebase identities without vault calls and denies site writes', async () => {
  const f = fixture();
  await f.service.publish('development', { records: f.records, metadata, expected: 'empty' });
  const snapshot = await f.service.read('development');
  const handler = createDocumentationV3({
    allowedOrigins: new Set(), authenticate: async () => access,
    rpc: async () => { throw new Error('Managed reads must not access vault RPCs'); },
    store: () => f.options.store, cache: f.options.cache,
    managed: (identity, input) => handleManagedDocumentation(identity, input, f.options)
  });
  async function call(body: unknown) {
    const req = Object.assign(Readable.from([]), { method: 'POST', headers: { 'content-type': 'application/json' }, body }) as IncomingMessage & { body: unknown };
    let status = 0, output: unknown;
    const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(text: string) { output = JSON.parse(text); } };
    await handler(req, res as unknown as ServerResponse);
    return { status, output };
  }
  const siteToken = 'dsite_' + 'a'.repeat(43);
  const key = await call({ action: 'key.get', scope: snapshot.release.scope, siteToken });
  assert.equal(key.status, 200);
  assert.match((key.output as { key: string }).key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call({ action: 'snapshot.get', siteToken })).status, 200);
  assert.equal((await call({ action: 'snapshot.publish', siteToken, records: f.records, expected: snapshot.head!.releaseId,
    ...metadata, operation: undefined, confirmed: true })).status, 403);
});
