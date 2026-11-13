import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, webcrypto } from 'node:crypto';
import { V3Client, V3ClientError, type Context, type CryptoCore, type PublishInput, type RecordData, type ReleaseMetadata, type Scope } from '../src/v3-client.js';
import { createV3Server } from '../src/v3-stdio.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const projectId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const keyId = '33333333-3333-4333-8333-333333333333';
const releaseId = '44444444-4444-4444-8444-444444444444';
const nextId = '55555555-5555-4555-8555-555555555555';
const context: Context = { project: 'Test', environment: 'development' };
const scope: Scope = { projectId, environment: 'development', keyId };
const records: RecordData[] = [
  { key: 'foundation', data: { schemaVersion: 2, navigation: ['features/sample'] } },
  { key: 'features/sample', title: 'Sample', page: 'features', data: { body: 'PRIVATE DRAFT searchable wombat' } }
];
const key = randomBytes(32).toString('base64url');
const notes = { version: '1.2.3', tags: ['Changed' as const], summary: 'PRIVATE RELEASE SUMMARY' };
const initialMetadata: ReleaseMetadata = { ...notes, operation: 'apply' };

interface Envelope { iv: string; ciphertext: string; tag: string }
function envelope(value: unknown): Envelope {
  assert.ok(typeof value === 'object' && value !== null && 'iv' in value && 'ciphertext' in value && 'tag' in value);
  assert.equal(typeof value.iv, 'string');
  assert.equal(typeof value.ciphertext, 'string');
  assert.equal(typeof value.tag, 'string');
  return { iv: String(value.iv), ciphertext: String(value.ciphertext), tag: String(value.tag) };
}
function seal(value: unknown, scopeKey: string, boundScope: Scope): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(scopeKey, 'base64url'), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(boundScope)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function open(value: unknown, scopeKey: string, boundScope: Scope): unknown {
  const sealed = envelope(value);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(scopeKey, 'base64url'), Buffer.from(sealed.iv, 'base64url'));
  decipher.setAAD(Buffer.from(JSON.stringify(boundScope)));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString());
}

async function fixture(options: { empty?: boolean; withoutMetadata?: boolean; plaintextTtlMs?: number; plaintextCacheBytes?: number; encryptedCacheBytes?: number; maxBodyBytes?: number } = {}) {
  const privateKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const calls: { action: string; body: string; value: Record<string, unknown> }[] = [];
  let wrongKey = false, denied = false, denyGrant = false, headId = options.empty ? null : releaseId;
  let role = 'owner';
  let report: unknown = { unmapped: [], droppedNavigation: [] };
  let changeNormalization = false;
  let decryptions = 0;
  let lastPublish: Record<string, unknown> | undefined;
  const metadataByCiphertext = new Map<string, ReleaseMetadata>();
  const core: CryptoCore = {
    normalize(input) {
      assert.ok(input.some(value => typeof value === 'object' && value !== null && 'key' in value && value.key === 'foundation'));
      assert.deepEqual(input, records);
      return { records: changeNormalization ? records.map(record => ({ ...record, normalized: true })) : records, report };
    },
    async unlockVault(_vault, secret) { assert.equal(secret, 'local password'); return privateKey; },
    createScopeKey() { return key; },
    async wrapKey(_scope, scopeKey) { assert.equal(scopeKey, key); return { sealed: 'SELF-WRAPPED-KEY' }; },
    async unwrapKey() { return wrongKey ? randomBytes(32).toString('base64url') : key; },
    async encryptSnapshot(input, boundScope, scopeKey, _previous, metadata = options.withoutMetadata ? undefined : initialMetadata) {
      const data = seal(input, scopeKey, boundScope);
      const id = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      const bundle = { id, data };
      const manifest = seal({ count: input.length, ...(metadata ? { metadata } : {}) }, scopeKey, boundScope);
      if (metadata) metadataByCiphertext.set(manifest.ciphertext, metadata);
      return { release: { format: 3, scope: boundScope, manifest,
        bundles: [id], recordCount: input.length }, bundles: [bundle] };
    },
    async decryptSnapshot(release, bundles, boundScope, scopeKey) {
      decryptions++;
      assert.equal(bundles.length, release.bundles.length);
      const count = open(release.manifest, scopeKey, boundScope);
      assert.ok(typeof count === 'object' && count !== null && 'count' in count);
      assert.equal(count.count, records.length);
      const value = open(bundles[0]!.data, scopeKey, boundScope);
      assert.deepEqual(value, records);
      return records;
    },
    async decryptSnapshotDetails(release, bundles, boundScope, scopeKey) {
      const decrypted = await core.decryptSnapshot(release, bundles, boundScope, scopeKey);
      const metadata = metadataByCiphertext.get(envelope(release.manifest).ciphertext);
      return metadata ? { records: decrypted, metadata } : { records: decrypted };
    }
  };
  let encrypted = await core.encryptSnapshot(records, scope, key);
  const service: typeof fetch = async (_url, init) => {
    assert.equal(_url, 'https://docs.example/api/documentation-v3');
    assert.equal(init?.redirect, 'error');
    const body = String(init?.body);
    const value: unknown = JSON.parse(body);
    assert.ok(typeof value === 'object' && value !== null && 'action' in value && typeof value.action === 'string');
    const parsed: Record<string, unknown> = { ...value };
    const action = value.action;
    calls.push({ action, body, value: parsed });
    if (denied) return Response.json({}, { status: 403 });
    switch (action) {
      case 'access': return Response.json({ access: { projectId, userId, name: 'Test', email: 'test@example.com', role, environments: ['development', 'beta', 'production'] } });
      case 'head': return Response.json(parsed.environment === 'beta' ? { head: null, release: null } : {
        head: headId ? { releaseId: headId, generation: headId === releaseId ? 1 : 2, keyId } : null,
        release: headId ? encrypted.release : null
      });
      case 'vault.get': return Response.json({ vault: { publicKey: { kty: 'RSA' } } });
      case 'release.get': return Response.json({ release: encrypted.release });
      case 'grant.get': return denyGrant ? Response.json({}, { status: 403 }) : Response.json({ grant: { sealed: 'WRAPPED' } });
      case 'grant.put': return Response.json({ ok: true });
      case 'bundle.get': return Response.json({ bundle: encrypted.bundles[0] });
      case 'bundle.put': return Response.json({ ok: true });
      case 'publish': lastPublish = parsed; return Response.json({ releaseId: nextId, generation: 2, warnings: [] });
      default: throw new Error('Unexpected action');
    }
  };
  const client = new V3Client({ endpoint: 'https://docs.example', token: 'dmcp_test', password: 'local password', core, fetch: service, ...options });
  return {
    client, core, calls, get decryptions() { return decryptions; }, get lastPublish() { return lastPublish; },
    setDenied(value: boolean) { denied = value; }, setDenyGrant(value: boolean) { denyGrant = value; },
    setWrongKey() { wrongKey = true; }, setReport(value: unknown) { report = value; },
    setRole(value: string) { role = value; },
    setNormalization() { changeNormalization = true; },
    async advance() { headId = nextId; encrypted = await core.encryptSnapshot(records, scope, key); }
  };
}
const publishInput: PublishInput = {
  ...context, ...notes, records, confirmed: true, expected: releaseId,
  sourceReview: { repositories: [{ name: 'repo', role: 'frontend', sourceFiles: 10, filesRead: 8 }], areas: ['feature'] }
};

test('decrypts locally, full-text searches locally, and never puts plaintext/secrets in remote JSON', async () => {
  const f = await fixture();
  const result = await f.client.read(context, ['features/sample']);
  assert.match(JSON.stringify(result), /PRIVATE DRAFT/);
  const search = await f.client.search(context, 'wombat');
  assert.match(JSON.stringify(search), /features\/sample/);
  for (const call of f.calls) {
    assert.doesNotMatch(call.body, /PRIVATE DRAFT|wombat|local password|privateKey|sourceReview/);
    assert.ok(!call.body.includes(key));
  }
  f.client.close();
});

test('cache hits authenticate live access, head and grant but do not fetch ciphertext again', async () => {
  const f = await fixture();
  await f.client.read(context);
  const before = f.calls.length;
  await f.client.read(context);
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['access', 'head', 'grant.get']);
  assert.equal(f.decryptions, 1);
  assert.equal(f.calls.filter(call => call.action === 'bundle.get').length, 1);
});

test('plaintext expiration re-decrypts authenticated cached ciphertext', async () => {
  const f = await fixture({ plaintextTtlMs: 0 });
  await f.client.read(context);
  await f.client.read(context);
  assert.equal(f.decryptions, 2);
  assert.equal(f.calls.filter(call => call.action === 'bundle.get').length, 1);
});

test('byte-bounded caches do not retain oversized entries', async () => {
  const f = await fixture({ plaintextCacheBytes: 1, encryptedCacheBytes: 1 });
  await f.client.read(context);
  await f.client.read(context);
  assert.equal(f.decryptions, 2);
  assert.equal(f.calls.filter(call => call.action === 'bundle.get').length, 2);
});

test('changed authoritative release invalidates decrypted snapshot cache', async () => {
  const f = await fixture();
  await f.client.read(context);
  await f.advance();
  await f.client.read(context);
  assert.equal(f.decryptions, 2);
});

test('denied access or revoked grant clears plaintext, ciphertext and private key state', async () => {
  for (const revoke of ['access', 'grant']) {
    const f = await fixture();
    await f.client.read(context);
    if (revoke === 'access') f.setDenied(true); else f.setDenyGrant(true);
    await assert.rejects(f.client.read(context), { code: 'ACCESS_DENIED' });
    f.setDenied(false); f.setDenyGrant(false);
    await f.client.read(context);
    assert.equal(f.decryptions, 2);
    assert.equal(f.calls.filter(call => call.action === 'vault.get').length, 2);
  }
});

test('wrong key fails authentication explicitly without returning cached plaintext', async () => {
  const f = await fixture();
  await f.client.read(context);
  f.setWrongKey();
  await assert.rejects(f.client.read(context), { code: 'DECRYPT' });
});

test('publication sends ciphertext only and keeps sourceReview/records/approval local', async () => {
  const f = await fixture();
  await f.client.publish(publishInput);
  assert.ok(f.lastPublish);
  assert.equal(f.lastPublish.expected, releaseId);
  const outbound = f.calls.map(call => call.body).join('\n');
  assert.doesNotMatch(outbound, /PRIVATE DRAFT|PRIVATE RELEASE SUMMARY|local password|sourceReview|confirmed|"records"|"version"|"tags"|"summary"/);
  assert.ok(!outbound.includes(key));
  assert.deepEqual(f.calls.filter(call => ['bundle.put', 'publish'].includes(call.action)).map(call => call.action), ['bundle.put', 'publish']);
});

test('first publication stages self-wrapped grant; no scope key is sent', async () => {
  const f = await fixture({ empty: true });
  await f.client.publish({ ...publishInput, expected: 'empty' });
  const writes = f.calls.filter(call => ['grant.put', 'bundle.put', 'publish'].includes(call.action));
  assert.deepEqual(writes.map(call => call.action), ['grant.put', 'bundle.put', 'publish']);
  assert.equal(writes[0]!.value.userId, userId);
  assert.ok(writes.every(call => !call.body.includes(key)));
});

test('author cannot initialize an empty environment and viewers cannot publish', async () => {
  const author = await fixture({ empty: true });
  author.setRole('author');
  await assert.rejects(author.client.publish({ ...publishInput, expected: 'empty' }), { code: 'ACCESS_DENIED' });
  assert.ok(!author.calls.some(call => call.action === 'grant.put' || call.action === 'publish'));
  const viewer = await fixture();
  viewer.setRole('viewer');
  await assert.rejects(viewer.client.publish(publishInput), { code: 'ACCESS_DENIED' });
});

test('promotion re-encrypts under target scope and atomically pins source release', async () => {
  const f = await fixture();
  await f.client.promote({ ...context, target: 'beta', expected: 'empty', expectedSource: releaseId, confirmed: true });
  assert.ok(f.lastPublish);
  assert.deepEqual(f.lastPublish.expectedSource, { environment: 'development', releaseId });
  assert.equal(f.lastPublish.environment, 'beta');
  const release = f.lastPublish.release;
  assert.ok(typeof release === 'object' && release !== null && 'scope' in release);
  const targetScope = release.scope;
  assert.ok(typeof targetScope === 'object' && targetScope !== null && 'environment' in targetScope);
  assert.equal(targetScope.environment, 'beta');
  assert.ok(!f.calls.some(call => /PRIVATE DRAFT|local password/.test(call.body)));
});

test('authenticated metadata appears in reads/status, while per-article changes remain unavailable', async () => {
  const f = await fixture();
  for (const result of [await f.client.read(context), await f.client.status(context), await f.client.changes(context)]) {
    assert.deepEqual(result.release, { releaseId, generation: 1, keyId, ...initialMetadata });
  }
  assert.equal((await f.client.changes(context)).changes, null);
  assert.ok(f.calls.every(call => !/PRIVATE RELEASE SUMMARY|"version"|"tags"|"summary"/.test(call.body)));
});

test('promote defaults source notes and permits overrides; older sources require explicit notes', async () => {
  const f = await fixture();
  const promoted = await f.client.promote({ ...context, target: 'beta', expected: 'empty', expectedSource: releaseId, confirmed: true });
  assert.deepEqual(promoted.metadata, { ...initialMetadata, operation: 'promote', sourceRelease: releaseId });
  const overridden = await f.client.promote({
    ...context, target: 'beta', expected: 'empty', expectedSource: releaseId, confirmed: true, version: '2.0', summary: 'PROMOTION PRIVATE SUMMARY'
  });
  assert.deepEqual(overridden.metadata, { ...initialMetadata, operation: 'promote', sourceRelease: releaseId, version: '2.0', summary: 'PROMOTION PRIVATE SUMMARY' });
  assert.ok(f.calls.every(call => !call.body.includes('PROMOTION PRIVATE SUMMARY')));
  const old = await fixture({ withoutMetadata: true });
  const status = await old.client.status(context);
  assert.deepEqual(status.release, { releaseId, generation: 1, keyId });
  await assert.rejects(old.client.promote({ ...context, target: 'beta', expected: 'empty', expectedSource: releaseId, confirmed: true }), { code: 'METADATA' });
  await old.client.promote({ ...context, ...notes, target: 'beta', expected: 'empty', expectedSource: releaseId, confirmed: true });
});

test('publish/import/rollback require valid notes and set encrypted operation provenance', async () => {
  const f = await fixture();
  await assert.rejects(f.client.publish({ ...publishInput, summary: '' }), { code: 'METADATA' });
  await assert.rejects(f.client.publish({ ...publishInput, tags: ['New', 'New'] }), { code: 'METADATA' });
  assert.equal(f.calls.length, 0);
  const imported = await f.client.publish(publishInput, 'import');
  assert.deepEqual(imported.metadata, { ...notes, operation: 'import' });
  const rolledBack = await f.client.rollback({
    ...context, ...notes, version: '1.2.4', summary: 'ROLLBACK PRIVATE SUMMARY', rollbackRelease: nextId, expected: releaseId, confirmed: true
  });
  assert.deepEqual(rolledBack.metadata, { ...notes, version: '1.2.4', summary: 'ROLLBACK PRIVATE SUMMARY', operation: 'rollback', rollbackRelease: nextId });
  assert.ok(f.calls.every(call => !/PRIVATE RELEASE SUMMARY|ROLLBACK PRIVATE SUMMARY|"version"|"tags"|"summary"/.test(call.body)));
});

test('normalization/conversion reports require approval before any network write', async () => {
  const f = await fixture();
  f.setReport({ droppedNavigation: ['orphan'] });
  const result = await f.client.publish(publishInput);
  assert.equal(result.requiresConversionApproval, true);
  assert.equal(f.calls.length, 0);
  await f.client.publish({ ...publishInput, approveConversion: true });
  assert.ok(f.lastPublish);
});

test('rollback authenticates immutable history and publishes a new ciphertext snapshot under current CAS', async () => {
  const f = await fixture();
  await f.client.rollback({ ...context, ...notes, rollbackRelease: nextId, expected: releaseId, confirmed: true });
  assert.ok(f.calls.some(call => call.action === 'release.get' && call.value.releaseId === nextId));
  assert.equal(f.lastPublish?.expected, releaseId);
  assert.ok(!f.calls.some(call => /PRIVATE DRAFT|local password/.test(call.body)));
});

test('partial snapshots, stale CAS, insufficient review and missing confirmation fail closed', async () => {
  const f = await fixture();
  await assert.rejects(f.client.publish({ ...publishInput, records: [records[1]!] }), { code: 'VALIDATION' });
  await assert.rejects(f.client.publish({ ...publishInput, expected: nextId }), { code: 'CAS' });
  await assert.rejects(f.client.publish({ ...publishInput, sourceReview: { repositories: [], areas: [] } }), { code: 'SOURCE_REVIEW' });
  assert.ok(!f.calls.some(call => call.action === 'publish'));
});

test('body limits bound both outbound requests and streamed backend responses', async () => {
  const f = await fixture({ maxBodyBytes: 50 });
  await assert.rejects(f.client.status(context), { code: 'BODY_LIMIT' });
  const largeResponse: typeof fetch = async () => new Response('x'.repeat(1025));
  const client = new V3Client({ endpoint: 'https://docs.example', token: 'dmcp_test', password: 'local password',
    core: f.core, fetch: largeResponse, maxBodyBytes: 1024 });
  await assert.rejects(client.status(context), { code: 'BODY_LIMIT' });
});

test('deadline aborts backend request explicitly and disallows insecure or redirected origins', async () => {
  const f = await fixture();
  const slow: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const client = new V3Client({ endpoint: 'https://docs.example', token: 'dmcp_test', password: 'local password',
    core: f.core, fetch: slow, requestTimeoutMs: 5 });
  await assert.rejects(client.status(context), { code: 'TIMEOUT' });
  for (const endpoint of ['http://docs.example', 'https://docs.example/path', 'https://u:p@docs.example', 'https://docs.example?x=1']) {
    assert.throws(() => new V3Client({ endpoint, token: 'dmcp_test', password: 'local password', core: f.core }), V3ClientError);
  }
});

test('MCP server registers real local tools without starting stdio on import', async () => {
  const f = await fixture();
  const server = createV3Server(f.client);
  assert.ok(server);
  await server.close();
});

test('real stdio process negotiates MCP and advertises strict secret-free local tools', async t => {
  // Startup uses an injected core only in the parent process tests. The actual
  // transport requires the vendor artifact supplied by the shared crypto build.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  try { require.resolve('../vendor/documentation-v3.js'); }
  catch { t.skip('Shared crypto vendor must be synced before the real stdio integration check.'); return; }
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/v3-stdio.js', import.meta.url))], {
    env: { ...process.env, MCP_V3_ENDPOINT: 'https://docs.example', MCP_V3_TOKEN: 'dmcp_test',
      MCP_V3_UNLOCK_PASSWORD: 'local password', MCP_V3_RECOVERY_CODE: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
  const response = (id: number): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('stdio handshake timed out')), 5000);
    const onExit = () => finish(new Error(`stdio exited: ${stderr}`));
    const onLine = (line: string) => {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === 'object' && value !== null && 'id' in value && value.id === id) finish(undefined, { ...value });
      } catch { finish(new Error('Non-JSON stdout')); }
    };
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer); lines.off('line', onLine); child.off('exit', onExit);
      if (error) reject(error); else resolve(value!);
    }
    lines.on('line', onLine); child.once('exit', onExit);
  });
  try {
    const initialized = response(1);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'local-connector-test', version: '1' }
    } });
    assert.ok((await initialized).result);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = response(2);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const message = await listed;
    assert.ok(message.result);
    const json = JSON.stringify(message);
    for (const name of ['publish_documentation', 'read_published_documentation', 'convert_documentation_to_v3', 'promote_documentation', 'rollback_documentation']) {
      assert.ok(json.includes(name), name);
    }
    assert.doesNotMatch(json, /"password"|"privateKey"|"recoveryCode"/);
    assert.doesNotMatch(stderr, /local password|dmcp_test/);
  } finally {
    lines.close();
    child.stdin.end();
    child.kill('SIGTERM');
  }
});

test('shared production crypto interoperates with constructor-loaded vendor and reuses unchanged bundles', async t => {
  const require = createRequire(import.meta.url);
  try { require.resolve('../vendor/documentation-v3.js'); }
  catch { t.skip('Shared crypto vendor must be synced before interoperability check.'); return; }
  const core: CryptoCore & { createVault(password: string): Promise<{ vault: unknown; privateKey: CryptoKey; recoveryCode: string }> } =
    require('../vendor/documentation-v3.js');
  const input: unknown = JSON.parse(readFileSync(new URL('../contract/examples/v2-handbook.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(input));
  const normalized = core.normalize(input);
  const enrolled = await core.createVault('real local secret');
  assert.ok(typeof enrolled.vault === 'object' && enrolled.vault !== null && 'publicKey' in enrolled.vault);
  const scopeKey = await core.createScopeKey();
  const wrapped = await core.wrapKey(scope, scopeKey, enrolled.vault.publicKey);
  const encrypted = await core.encryptSnapshot(normalized.records, scope, scopeKey, undefined, initialMetadata);
  const calls: string[] = [];
  const outbound: string[] = [];
  const service: typeof fetch = async (_url, init) => {
    const body = String(init?.body);
    outbound.push(body);
    const value: unknown = JSON.parse(body);
    assert.ok(typeof value === 'object' && value !== null && 'action' in value);
    calls.push(String(value.action));
    switch (value.action) {
      case 'access': return Response.json({ access: { projectId, userId, name: 'Test', email: 'test@example.com', role: 'owner', environments: ['development'] } });
      case 'head': return Response.json({ head: { releaseId, generation: 1, keyId }, release: encrypted.release });
      case 'vault.get': return Response.json({ vault: enrolled.vault });
      case 'grant.get': return Response.json({ grant: wrapped });
      case 'bundle.get': {
        assert.ok('id' in value);
        const bundle = encrypted.bundles.find(bundle => bundle.id === value.id);
        assert.ok(bundle);
        return Response.json({ bundle });
      }
      case 'publish': return Response.json({ releaseId: nextId, generation: 2, warnings: [] });
      default: throw new Error(`Unexpected production crypto request ${String(value.action)}`);
    }
  };
  const client = new V3Client({
    endpoint: 'https://docs.example', token: 'dmcp_test', password: 'real local secret', fetch: service
  });
  const read = await client.read(context);
  assert.deepEqual(read.articles, normalized.records);
  assert.deepEqual(read.release, { releaseId, generation: 1, keyId, ...initialMetadata });
  let publishedRelease: unknown;
  const publishedService: typeof fetch = async (url, init) => {
    const value: unknown = JSON.parse(String(init?.body));
    if (typeof value === 'object' && value !== null && 'action' in value && value.action === 'publish' && 'release' in value) {
      publishedRelease = value.release;
    }
    return service(url, init);
  };
  const writer = new V3Client({ endpoint: 'https://docs.example', token: 'dmcp_test', password: 'real local secret', fetch: publishedService });
  await writer.publish({ ...publishInput, version: '9.9', summary: 'PRIVATE NEW RELEASE NOTE', records: normalized.records, approveConversion: true });
  assert.ok(calls.includes('publish'));
  assert.ok(!calls.includes('bundle.put'), 'Unchanged authenticated content must not be restaged');
  assert.ok(publishedRelease);
  assert.ok(core.validateRelease);
  const validated = core.validateRelease(publishedRelease, scope);
  const decrypted = await core.decryptSnapshotDetails(validated, encrypted.bundles, scope, scopeKey);
  assert.deepEqual(decrypted.metadata, { ...notes, version: '9.9', summary: 'PRIVATE NEW RELEASE NOTE', operation: 'apply' });
  assert.notDeepEqual(validated.manifest, encrypted.release.manifest, 'Metadata changes require fresh encrypted manifest');
  for (const body of outbound) {
    assert.ok(!body.includes(scopeKey));
    assert.ok(!body.includes('real local secret'));
    assert.ok(!body.includes(enrolled.recoveryCode));
    assert.ok(!body.includes('Northstar handbook'));
    assert.ok(!body.includes('PRIVATE NEW RELEASE NOTE'));
    assert.ok(!body.includes('PRIVATE RELEASE SUMMARY'));
    assert.doesNotMatch(body, /"privateKey"|"sourceReview"|"records"/);
  }
  client.close();
  writer.close();
});
