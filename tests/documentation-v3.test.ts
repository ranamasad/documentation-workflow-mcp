import { gzipSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { generateKeyPair, exportPKCS8, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHttpHandler } from '../src/http.js';
import { createCiphertextCache, ciphertextCacheKey } from '../src/ciphertext-cache.js';
import {
  assertNotMigrated, canonical, createDocumentationV3, createV3FirestoreStore, DocumentationV3Error, hash, readV3Body,
  v3Bundle, v3Envelope, v3Grant, v3Release, v3Vault, V3_REQUEST_BYTES, type V3Access, type V3Store
} from '../src/documentation-v3.js';
import { fakeFirestore } from './fake-firestore.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const keyId = '33333333-3333-4333-8333-333333333333';
const releaseId = '44444444-4444-4444-8444-444444444444';
const nextRelease = '55555555-5555-4555-8555-555555555555';
const scope = { projectId, keyId, environment: 'development' as const };
const envelope = { format: 3 as const, scope, iv: Buffer.alloc(12).toString('base64url'),
  ciphertext: Buffer.alloc(32).toString('base64url'), encoding: 'gzip' as const, plainBytes: 123 };
const bundle = { id: hash(canonical(envelope)), data: envelope };
const release = { format: 3 as const, scope, manifest: envelope, bundles: [bundle.id], recordCount: 1 };
const access: V3Access = { projectId, userId, name: 'Docs', role: 'owner', email: 'owner@example.com',
  environments: ['development', 'beta'], administrator: true, reader: null, firebaseProject: 'test-project', serviceAccountKey: 'server only' };
const config = { url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', secretKey: 'sb_secret_test', siteUrl: 'https://mcp.example.com' };
const publicKey = { kty: 'RSA' as const, e: 'AQAB' as const, n: Buffer.alloc(256, 128).toString('base64url') };
const sealed = { iv: Buffer.alloc(12).toString('base64url'), ciphertext: Buffer.alloc(32).toString('base64url') };
const vault = { format: 3 as const, publicKey, fingerprint: hash(canonical(publicKey)),
  password: { ...sealed, kdf: { name: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: 600000, salt: Buffer.alloc(16).toString('base64url') } }, recovery: sealed };
const grant = { format: 3 as const, scope, recipient: vault.fingerprint, wrappedKey: Buffer.alloc(256).toString('base64url') };

function request(body: unknown, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([]), { method: 'POST', url: '/api/documentation-v3',
    headers: { 'content-type': 'application/json', ...headers }, body }) as unknown as IncomingMessage & { body: unknown };
}
function response() {
  const headers = new Map<string, unknown>();
  return {
    headers, status: 0, body: null as any,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    writeHead(status: number, values: Record<string, string>) { this.status = status; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); },
    end(text: string) { this.body = text ? JSON.parse(text) : null; }
  };
}
function memoryStore() {
  const docs = new Map<string, Record<string, unknown>>();
  const reads: string[] = [];
  const store: V3Store = {
    async get(path) { reads.push(path); return docs.has(path) ? { data: docs.get(path)! } : null; },
    async getMany(paths) { return Promise.all(paths.map(path => store.get(path))); },
    async immutable(path, data) {
      if (docs.has(path) && canonical(docs.get(path)) !== canonical(data)) throw new DocumentationV3Error(409, 'Immutable conflict.');
      docs.set(path, data);
    },
    async publish(input) {
      const old = docs.get('documentationV3Environments/' + input.release.scope.environment);
      if ((old?.releaseId ?? 'empty') !== input.expected) throw new DocumentationV3Error(409, 'CAS conflict.');
      for (const id of input.release.bundles) assert(docs.has('documentationV3Bundles/' + id));
      docs.set('documentationV3Releases/' + input.releaseId, input.release);
      const generation = Number(old?.generation ?? 0) + 1;
      docs.set('documentationV3Environments/' + input.release.scope.environment, { format: 3, releaseId: input.releaseId, generation, keyId });
      return generation;
    }
  };
  return { docs, reads, store };
}
function fixture(identity: V3Access = access) {
  const memory = memoryStore();
  const calls: { name: string; body: unknown }[] = [];
  const warnings: string[] = [];
  let authorizations = 0;
  const cache = createCiphertextCache({ warn: message => warnings.push(message) });
  const handler = createDocumentationV3({ allowedOrigins: new Set(['https://mcp.example.com']), authenticate: async () => { authorizations++; return identity; },
    rpc: async (name, body) => { calls.push({ name, body }); return null; }, store: () => memory.store, cache });
  async function call(body: unknown, headers?: Record<string, string>) {
    const res = response(); await handler(request(body, headers), res as unknown as ServerResponse); return res;
  }
  return { ...memory, calls, cache, call, warnings, get authorizations() { return authorizations; } };
}

test('strict wire schema, canonical hashing, bounded opaque vaults and grants', () => {
  assert.equal(canonical({ z: [3, { b: 1, a: 2 }], a: 1 }), '{"a":1,"z":[3,{"a":2,"b":1}]}');
  assert.deepEqual(v3Bundle.parse(bundle), bundle);
  assert(v3Envelope.safeParse({ ...envelope, iv: 'bad' }).success === false);
  assert(v3Envelope.safeParse({ ...envelope, plainBytes: 32 * 1024 * 1024 + 1 }).success === false);
  assert(v3Envelope.safeParse({ ...envelope, ciphertext: Buffer.alloc(712500).toString('base64url') }).success === false);
  assert(v3Bundle.safeParse({ ...bundle, id: 'a'.repeat(64) }).success === false);
  assert(v3Release.safeParse({ ...release, manifest: { ...envelope, scope: { ...scope, environment: 'beta' } } }).success === false);
  assert(v3Release.safeParse({ ...release, bundles: [bundle.id, bundle.id] }).success === false);
  assert(v3Vault.safeParse(vault).success);
  assert(v3Vault.safeParse({ ...vault, publicKey: { ...publicKey, d: 'private' } }).success === false);
  assert(v3Vault.safeParse({ ...vault, recovery: { ...sealed, privateKey: 'private' } }).success === false);
  assert(v3Vault.safeParse({ ...vault, fingerprint: 'a'.repeat(64) }).success === false);
  assert(v3Grant.safeParse(grant).success);
  assert(v3Grant.safeParse({ ...grant, wrappedKey: 'short' }).success === false);
});

test('request limits cover streaming, pre-parsed strings and objects', async () => {
  await assert.rejects(readV3Body(request({ value: 'a'.repeat(V3_REQUEST_BYTES + 1) })), /too large/);
  await assert.rejects(readV3Body(request('a'.repeat(V3_REQUEST_BYTES + 1))), /too large/);
  const stream = Object.assign(Readable.from([Buffer.alloc(V3_REQUEST_BYTES), Buffer.alloc(1)]), {
    headers: { 'content-type': 'application/json' }
  });
  await assert.rejects(readV3Body(stream as IncomingMessage), /too large/);
  await assert.rejects(readV3Body(request({}, { 'content-length': 'NaN' })), /too large/);
  await assert.rejects(readV3Body(request({}, { 'content-type': 'text/plain' })), /application\/json/);
  const circular: any = {}; circular.self = circular;
  await assert.rejects(readV3Body(request(circular)), /Invalid JSON/);
});

test('gzip request bodies unpack up to the request limit', async () => {
  const gz = (value: string, headers: Record<string, string> = {}) => Object.assign(Readable.from([gzipSync(value)]), {
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', ...headers }
  }) as IncomingMessage;
  const big = JSON.stringify({ action: 'head', data: 'a'.repeat(5 * 1024 * 1024) });
  assert.deepEqual(Object.keys(await readV3Body(gz(big)) as object), ['action', 'data'], 'A 5 MiB snapshot fits once compressed.');
  await assert.rejects(readV3Body(gz('"' + 'a'.repeat(V3_REQUEST_BYTES) + '"')), /too large/);
  await assert.rejects(readV3Body(gz('{}', { 'content-encoding': 'br' })), /gzip/);
  const broken = Object.assign(Readable.from([Buffer.from('not gzip')]), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  await assert.rejects(readV3Body(broken as IncomingMessage), /Invalid gzip/);
});

test('authorized stage, publish, head and immutable ciphertext cache round trip', async () => {
  const f = fixture();
  assert.equal((await f.call({ action: 'bundle.put', bundle })).status, 200);
  assert.equal((await f.call({ action: 'publish', releaseId, expected: 'empty', release })).status, 200);
  const head = await f.call({ action: 'head' });
  assert.deepEqual(head.body.head, { releaseId, generation: 1, keyId });
  assert.equal(head.headers.get('cache-control'), 'private, no-store');
  const before = f.reads.length;
  assert.deepEqual((await f.call({ action: 'bundle.get', releaseId, id: bundle.id })).body.bundle, bundle);
  assert.deepEqual(f.reads.slice(before), [], 'fully cached bundle reads do not fetch release descriptors or ciphertext from Firestore');
  assert.equal((await f.call({ action: 'publish', releaseId: nextRelease, expected: 'empty', release })).status, 409);
  assert.deepEqual((await f.call({ action: 'release.get', releaseId })).body, { release });
  await assert.rejects(assertNotMigrated(f.store, 'development'), /encrypted v3/);
  await assertNotMigrated(f.store, 'production');
});

test('cached release descriptors are server-authenticated, immutable and never cache authorization or mutable heads', async () => {
  const f = fixture();
  f.docs.set('documentationV3Environments/development', { format: 3, releaseId, keyId, generation: 1 });
  f.docs.set('documentationV3Releases/' + releaseId, release);
  const cacheKey = ciphertextCacheKey(access.firebaseProject, projectId, 'development', 'release:' + releaseId);
  await f.cache.set(cacheKey, { releaseId, release, contentHash: hash(canonical(release)), mac: '0'.repeat(64) });
  assert.equal((await f.call({ action: 'release.get', releaseId })).status, 200);
  assert(f.warnings.some(message => message.includes('Corrupt')));
  assert.deepEqual(f.reads, ['documentationV3Releases/' + releaseId]);
  const authorizations = f.authorizations;
  await f.call({ action: 'release.get', releaseId });
  assert.equal(f.reads.length, 1);
  assert.equal(f.authorizations, authorizations + 1);
  await f.call({ action: 'head' });
  f.docs.set('documentationV3Environments/development', { format: 3, releaseId, keyId, generation: 2 });
  assert.equal((await f.call({ action: 'head' })).body.head.generation, 2);
  assert.deepEqual(f.reads.slice(1), ['documentationV3Environments/development', 'documentationV3Environments/development']);
});

test('every cached read first proves project, environment and release membership', async () => {
  const f = fixture({ ...access, role: 'viewer', administrator: false, environments: ['development'] });
  f.docs.set('documentationV3Environments/development', { format: 3, releaseId, keyId, generation: 1 });
  f.docs.set('documentationV3Releases/' + releaseId, release);
  await f.cache.set(ciphertextCacheKey(access.firebaseProject, projectId, 'development', bundle.id), bundle);
  assert.equal((await f.call({ action: 'bundle.get', releaseId, id: bundle.id, environment: 'beta' })).status, 403);
  const wrongScope = { ...scope, projectId: nextRelease };
  f.docs.set('documentationV3Releases/' + nextRelease, { ...release, scope: wrongScope, manifest: { ...envelope, scope: wrongScope } });
  assert.equal((await f.call({ action: 'bundle.get', releaseId: nextRelease, id: bundle.id })).status, 403);
  const foreign = 'f'.repeat(64);
  await f.cache.set(ciphertextCacheKey(access.firebaseProject, projectId, 'development', foreign), bundle);
  assert.equal((await f.call({ action: 'bundle.get', releaseId, id: foreign })).status, 403);
  assert.equal((await f.call({ action: 'bundle.put', bundle })).status, 403);
  assert.equal((await f.call({ action: 'recipients' })).status, 403);
  assert.equal((await f.call({ action: 'grant.put', scope, userId, grant })).status, 403);
});

test('author writes development only; owner can bootstrap grants before a head', async () => {
  const author = fixture({ ...access, role: 'author', administrator: false });
  const betaScope = { ...scope, environment: 'beta' as const };
  const beta = { ...envelope, scope: betaScope };
  assert.equal((await author.call({ action: 'bundle.put', bundle: { id: hash(canonical(beta)), data: beta } })).status, 403);
  assert.equal((await author.call({ action: 'bundle.put', bundle })).status, 200);
  const owner = fixture();
  assert.equal((await owner.call({ action: 'grant.put', scope, userId, grant })).status, 200);
  assert.equal(owner.calls.at(-1)?.name, 'mcp_v3_grant_save');
  const revoked = await owner.call({ action: 'grant.delete', scope, userId });
  assert.equal(revoked.status, 200); assert.match(revoked.body.warnings[0], /Rotate/);
  assert.equal((await owner.call({ action: 'grant.put', scope: { ...scope, keyId: releaseId }, userId, grant })).status, 400);
});

test('personal vault actions work without any project and expose no server credentials', async () => {
  const calls: string[] = [];
  const handler = createDocumentationV3({ allowedOrigins: new Set(), authenticate: async () => ({ userId }),
    rpc: async name => { calls.push(name); return name.endsWith('_get') ? vault : null; } });
  for (const action of ['vault.get', 'vault.create', 'vault.update']) {
    const res = response();
    await handler(request({ action, ...(action !== 'vault.get' ? { vault } : {}) }), res as unknown as ServerResponse);
    assert.equal(res.status, 200);
  }
  assert.deepEqual(calls, ['mcp_v3_vault_get', 'mcp_v3_vault_save', 'mcp_v3_vault_save']);
  const res = await fixture().call({ action: 'access' });
  assert.equal(res.body.access.serviceAccountKey, undefined);
  assert.equal(res.body.access.userId, userId);
  assert.equal((await fixture().call({ action: 'head' }, { origin: 'https://evil.example' })).status, 403);
});

test('registered-origin-only preflight is private, exact and supports JSON', async () => {
  const handler = createDocumentationV3({ allowedOrigins: new Set(), authenticate: async () => access, rpc: async () => null,
    preflight: async req => req.headers.origin === 'https://docs.web.app' ? req.headers.origin : null });
  for (const [origin, status] of [['https://docs.web.app', 204], ['https://evil.example', 403]] as const) {
    const req = request({}, { origin }); req.method = 'OPTIONS';
    const res = response(); await handler(req, res as unknown as ServerResponse);
    assert.equal(res.status, status);
    assert.equal(res.headers.get('access-control-allow-origin'), status === 204 ? origin : undefined);
  }
});

test('HTTP routing and Vercel rewrite remain fail-closed and private without account configuration', async () => {
  const handler = createHttpHandler({ allowedHosts: new Set(['localhost']), allowedOrigins: new Set(), validationSigningKey: 's'.repeat(64) });
  try {
    for (const url of ['/api/documentation-v3', '/api/mcp?documentationV3=1']) {
      const req = request({ action: 'head' }, { host: 'localhost' }); req.url = url;
      const res = response(); await handler.handle(req, res as unknown as ServerResponse);
      assert.equal(res.status, 503); assert.equal(res.headers.get('cache-control'), 'private, no-store');
    }
    const res = response();
    await handler.handle(request({ action: 'head' }, { host: 'evil.example' }), res as unknown as ServerResponse);
    assert.equal(res.status, 403); assert.equal(res.headers.get('cache-control'), 'private, no-store');
    for (const asset of ['/v3/documentation-v3.js']) {
      const assetRequest = request({}, { host: 'localhost' }); assetRequest.method = 'GET';
      assetRequest.url = '/api/mcp?websiteAsset=' + encodeURIComponent(asset);
      const assetResponse = response();
      assetResponse.end = text => { assetResponse.body = text.toString(); };
      await handler.handle(assetRequest, assetResponse as unknown as ServerResponse);
      assert.equal(assetResponse.status, 200);
      assert.equal(assetResponse.headers.get('cache-control'), 'private, no-store');
      assert.match(String(assetResponse.headers.get('content-security-policy')), /default-src 'self'/);
    }
  } finally { await handler.close(); }
});

test('durable Firestore immutable documents, scope verification, CAS and source pinning', async () => {
  const rsa = await generateKeyPair('RS256', { extractable: true });
  const key = JSON.stringify({ type: 'service_account', project_id: 'test-project', client_email: 'test@test-project.iam.gserviceaccount.com',
    private_key: await exportPKCS8(rsa.privateKey) });
  const fake = fakeFirestore('test-project');
  const fetcher: typeof fetch = async (url, init) => String(url).includes('oauth2.googleapis.com') ?
    Response.json({ access_token: 'iam', expires_in: 3600 }) : fake.fetchFake(url, init);
  const store = createV3FirestoreStore({ ...access, serviceAccountKey: key }, fetcher);
  await store.immutable('documentationV3Bundles/' + bundle.id, envelope);
  await store.immutable('documentationV3Bundles/' + bundle.id, envelope);
  await assert.rejects(store.immutable('documentationV3Bundles/' + bundle.id, { ...envelope, plainBytes: 999 }), /different data/);
  await store.immutable('documentationEnvironments/development', { releaseId });
  await assert.rejects(store.publish({ releaseId, expected: 'empty', expectedLegacy: nextRelease, release }), /legacy release changed/);
  assert.equal(await store.publish({ releaseId, expected: 'empty', expectedLegacy: releaseId, release }), 1);
  await assert.rejects(store.publish({ releaseId: nextRelease, expected: 'empty', release }), /current release changed/);
  await assert.rejects(store.publish({ releaseId: nextRelease, expected: releaseId, release,
    expectedSource: { environment: 'beta', releaseId } }), /source release changed/);
  assert.equal(await store.publish({ releaseId: nextRelease, expected: releaseId, release,
    expectedSource: { environment: 'development', releaseId } }), 2);
  await assert.rejects(store.publish({ releaseId: projectId, expected: nextRelease,
    release: { ...release, scope: { ...scope, projectId: userId }, manifest: { ...envelope, scope: { ...scope, projectId: userId } } } }),
  /another project scope/);
  await assert.rejects(store.publish({ releaseId: projectId, expected: nextRelease,
    release: { ...release, bundles: ['f'.repeat(64)] } }), /missing/);
});
