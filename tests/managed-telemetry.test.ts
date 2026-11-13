import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { createCiphertextCache } from '../src/ciphertext-cache.js';
import { createDocumentationV3, DocumentationV3Error, v3Request, type V3Access, type V3Store } from '../src/documentation-v3.js';
import { createFirestoreWriter, type FirestoreWriter } from '../src/firestore.js';
import { createManagedDocumentation } from '../src/managed-documentation.js';
import { createManagedTelemetry, createTelemetryStore, readManagedTelemetry, type TelemetryStore, type TelemetryStored } from '../src/managed-telemetry.js';
import type { RecordData } from '../src/v3-client.js';
import { fakeFirestore } from './fake-firestore.js';
import { WebsiteAccessError } from '../src/website-access.js';

const masterKey = Buffer.alloc(32, 61).toString('base64url');
const now = Date.now() - 60000;
const access: V3Access = {
  projectId: '11111111-1111-4111-8111-111111111111', userId: null, name: 'Docs',
  role: 'owner', email: 'private@example.com', readerUid: 'reader-private-uid', displayName: 'Private Reader',
  administrator: true, environments: ['development'], firebaseProject: 'test-project', serviceAccountKey: 'test-only'
};

async function fixture() {
  const documents = new Map<string, Record<string, unknown>>();
  let documentReads = 0, metricReads = 0, writes = 0, clock = 0;
  const store: V3Store = {
    async get(path) { documentReads++; return documents.has(path) ? { data: documents.get(path)! } : null; },
    async getMany(paths) { return Promise.all(paths.map(path => store.get(path))); },
    async immutable(path, data) { documents.set(path, data); },
    async publish(input) {
      documents.set('documentationV3Releases/' + input.releaseId, input.release);
      documents.set('documentationV3Environments/' + input.release.scope.environment,
        { format: 3, releaseId: input.releaseId, generation: 1, keyId: input.release.scope.keyId });
      return 1;
    }
  };
  const metrics = new Map<string, TelemetryStored>();
  const telemetryStore: TelemetryStore = {
    async get(path) { metricReads++; return metrics.get(path) ?? null; },
    async write(entries) {
      for (const entry of entries) {
        if ((metrics.get(entry.path)?.version ?? null) !== entry.version) throw new DocumentationV3Error(409, 'CAS conflict');
      }
      writes += entries.length;
      return entries.map(entry => {
        const version = 'v' + ++clock;
        metrics.set(entry.path, { data: entry.data, version });
        return version;
      });
    }
  };
  const redis = new Map<string, string>();
  const cache = createCiphertextCache({
    redis: { url: 'https://cache.example.com', token: 'test' },
    fetch: async (_url, init) => {
      const [command, key, value] = JSON.parse(String(init?.body)) as string[];
      if (command === 'SET') redis.set(key!, value!);
      return Response.json({ result: command === 'GET' ? redis.get(key!) ?? null : 'OK' });
    }
  });
  const options = { masterKey, store, cache, telemetryStore, now: () => now, releaseCacheSigningKey: 'test-signing-key' };
  const docs = createManagedDocumentation(access, options);
  const published = await docs.publish('development', {
    records: JSON.parse(readFileSync('contract-v3/examples/v2-content.json', 'utf8')) as RecordData[],
    metadata: { version: '1.0.0', summary: 'Private release', tags: ['Changed'], operation: 'apply' }, expected: 'empty'
  });
  await docs.authorizeRelease('development', published.releaseId);
  const target = { environment: 'development', releaseId: published.releaseId, route: 'guides/setup', key: 'guides%2Fsetup',
    title: 'PRIVATE ARTICLE TITLE', revisionId: 'a'.repeat(64) };
  const visit = { id: randomUUID(), uid: access.readerUid!, sessionId: randomUUID(), route: target.route, title: target.title,
    openedAt: now - 30000, elapsedMs: 20000, activeMs: 10000, ended: false, endReason: '', nextRoute: '',
    environment: target.environment, releaseId: published.releaseId, documentationVersion: '1.0.0' };
  const action = createManagedTelemetry(options);
  const call = (body: Record<string, unknown>, who = access) => action(who, v3Request.parse({
    siteToken: 'dsite_' + 'a'.repeat(43), ...body
  }));
  const writer: FirestoreWriter = {
    async list() { return []; }, async commit() {},
    async query(collection, scope) {
      assert.equal(scope.parent, 'documentationV3Telemetry/' + access.projectId);
      return { documents: [...metrics].filter(([path]) => path.includes('/' + collection + '/'))
        .map(([path, value]) => ({ path, id: path.split('/').at(-1)!, data: value.data })), truncated: false };
    }
  };
  return { options, metrics, redis, target, visit, call, writer,
    counts: () => ({ documentReads, metricReads, writes }) };
}

test('v3 telemetry encrypts identities and article metadata; warm visits need no Firebase reads', async () => {
  const f = await fixture();
  const before = f.counts();
  await f.call({ action: 'usage.put', visits: [f.visit] });
  await f.call({ action: 'usage.put', visits: [{ ...f.visit, elapsedMs: 25000, activeMs: 15000 }] });
  assert.deepEqual(f.counts(), { ...before, writes: before.writes + 2 });
  const serialized = JSON.stringify({ stored: [...f.metrics], cache: [...f.redis] });
  for (const secret of ['PRIVATE ARTICLE TITLE', access.email, access.readerUid!, access.displayName!, masterKey]) assert.ok(!serialized.includes(secret));
  const report = await readManagedTelemetry(access.projectId, f.writer, now - 86400000, masterKey);
  assert.equal(report.visits[0]!.data.activeMs, 15000);
  assert.equal(report.visits[0]!.data.title, f.target.title);
  assert.equal(report.profiles.get(access.readerUid!)!.data.email, access.email);
  assert.equal(report.truncated, false);
});

test('out-of-order and duplicate visits preserve terminal progress; cold caches recover through CAS', async () => {
  const f = await fixture();
  await f.call({ action: 'usage.put', visits: [{ ...f.visit, ended: true, endReason: 'pagehide' }] });
  const writes = f.counts().writes;
  await f.call({ action: 'usage.put', visits: [f.visit] });
  assert.equal(f.counts().writes, writes);
  const cold = createManagedTelemetry({ ...f.options, cache: createCiphertextCache() });
  await cold(access, v3Request.parse({ action: 'usage.put', siteToken: 'dsite_' + 'a'.repeat(43),
    visits: [{ ...f.visit, elapsedMs: 25000, activeMs: 15000 }] }));
  assert.equal(f.counts().metricReads, 1);
  const report = await readManagedTelemetry(access.projectId, f.writer, null, masterKey);
  assert.equal(report.visits[0]!.data.ended, true);
  assert.equal(report.visits[0]!.data.endReason, 'pagehide');
  assert.equal(report.visits[0]!.data.activeMs, 15000);
  await assert.rejects(f.call({ action: 'usage.put', visits: [{ ...f.visit, route: 'another' }] }), /identifiers cannot be reused/);
});

test('feedback is private, scoped to the reader and returns durable authoritative votes after stale-cache races', async () => {
  const f = await fixture();
  assert.deepEqual(await f.call({ action: 'feedback.get', ...f.target }), { helpful: null });
  const first = { action: 'feedback.put', ...f.target, helpful: true, changeId: randomUUID(), changedAt: now - 1000 };
  assert.equal((await f.call(first)).helpful, true);
  const other = createManagedTelemetry({ ...f.options, cache: createCiphertextCache() });
  await other(access, v3Request.parse({ ...first, helpful: false, changeId: randomUUID(), changedAt: now,
    siteToken: 'dsite_' + 'a'.repeat(43) }));
  const replay = await f.call(first);
  assert.equal(replay.helpful, false);
  assert.equal(replay.superseded, true);
  assert.equal((await f.call({ action: 'feedback.get', ...f.target })).helpful, false);
  assert.deepEqual(await f.call({ action: 'feedback.get', ...f.target }, { ...access, readerUid: 'another-reader' }), { helpful: null });
  const report = await readManagedTelemetry(access.projectId, f.writer, null, masterKey);
  assert.equal(report.votes[0]!.id, access.readerUid);
  assert.equal(report.votes[0]!.data.helpful, false);
});

test('telemetry rejects UID spoofing, unauthorized environments, invalid article keys and old timestamps', async () => {
  const f = await fixture();
  await assert.rejects(f.call({ action: 'usage.put', visits: [{ ...f.visit, uid: 'forged' }] }), /verified reader/);
  await assert.rejects(f.call({ action: 'usage.put', visits: [{ ...f.visit, environment: 'production' }] }), /access denied/);
  await assert.rejects(f.call({ action: 'usage.put', visits: [f.visit] }, { ...access, readerUid: undefined }), /verified website reader/);
  await assert.rejects(f.call({ action: 'feedback.get', ...f.target, key: 'wrong' }), /does not match/);
  await assert.rejects(f.call({ action: 'feedback.put', ...f.target, helpful: true, changeId: randomUUID(), changedAt: now - 600000 }), /time is invalid/);
  assert.equal(f.metrics.size, 0);
});

test('analytics fails explicitly for ciphertext tampering, foreign paths and key loss', async () => {
  const f = await fixture();
  await f.call({ action: 'usage.put', visits: [f.visit] });
  await assert.rejects(readManagedTelemetry(access.projectId, f.writer, null, Buffer.alloc(32, 62).toString('base64url')), /failed authentication/);
  const [path, stored] = [...f.metrics][0]!;
  f.metrics.delete(path);
  f.metrics.set(path.slice(0, -1) + (path.endsWith('a') ? 'b' : 'a'), stored);
  await assert.rejects(readManagedTelemetry(access.projectId, f.writer, null, masterKey), /failed authentication/);
  f.metrics.clear();
  f.metrics.set(path, { ...stored, data: { ...stored.data, date: '2026-10-24' } });
  await assert.rejects(readManagedTelemetry(access.projectId, f.writer, null, masterKey), /failed authentication/);
});

test('Firestore telemetry versions and HTTP-400 precondition conflicts preserve encrypted updates', async () => {
  const f = await fixture();
  await f.call({ action: 'usage.put', visits: [f.visit] });
  const data = [...f.metrics.values()][0]!.data;
  const fake = fakeFirestore(access.firebaseProject);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccess = { ...access, serviceAccountKey: JSON.stringify({ type: 'service_account', project_id: access.firebaseProject,
    client_email: 'test@example.com', private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
  const fetcher: typeof fetch = async (url, init) => String(url).includes('oauth2.googleapis.com')
    ? Response.json({ access_token: 'test-token', expires_in: 3600 }) : fake.fetchFake(url, init);
  const store = createTelemetryStore(serviceAccess, fetcher);
  const path = 'documentationV3Telemetry/' + access.projectId + '/visits/test';
  const [version] = await store.write([{ path, data, version: null }]);
  assert.deepEqual(await store.get(path), { data, version });
  await store.write([{ path, data, version: version! }]);
  await assert.rejects(store.write([{ path, data, version: version! }]), (error: unknown) =>
    error instanceof DocumentationV3Error && error.status === 409);
});

test('Firestore encrypted analytics queries bind the project parent and use a date string filter', async () => {
  let calls = 0;
  const writer = createFirestoreWriter('test-project', async () => 'test-token', async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/documents/documentationV3Telemetry/' + access.projectId + ':runQuery');
    const query = JSON.parse(String(init?.body)).structuredQuery;
    assert.deepEqual(query.where.fieldFilter, { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL',
      value: { stringValue: new Date(now - 86400000).toISOString().slice(0, 10) } });
    assert.ok(['visits', 'votes'].includes(query.from[0].collectionId));
    return Response.json([]);
  });
  const report = await readManagedTelemetry(access.projectId, writer, now - 86400000);
  assert.equal(calls, 2);
  assert.equal(report.visits.length, 0);
});

test('gateway telemetry dispatch preserves verified identity and rejects non-site credentials and oversized batches', async () => {
  const f = await fixture();
  let calls = 0;
  const handler = createDocumentationV3({
    allowedOrigins: new Set(), rpc: async () => { throw new Error('Unexpected RPC'); },
    authenticate: async () => access,
    telemetry: async (identity, input) => { calls++; assert.equal(identity.readerUid, access.readerUid); return createManagedTelemetry(f.options)(identity, input); }
  });
  const call = async (body: unknown) => {
    const req = Object.assign(Readable.from([]), { method: 'POST', headers: { 'content-type': 'application/json' }, body }) as IncomingMessage & { body: unknown };
    let status = 0, output: unknown;
    const res = { setHeader() {}, writeHead(value: number) { status = value; }, end(text: string) { output = JSON.parse(text); } };
    await handler(req, res as unknown as ServerResponse);
    return { status, output };
  };
  const body = { action: 'usage.put', visits: [f.visit], siteToken: 'dsite_' + 'a'.repeat(43) };
  assert.deepEqual(await call(body), { status: 200, output: { ok: true } });
  assert.equal((await call({ ...body, siteToken: undefined })).status, 403);
  assert.equal((await call({ ...body, visits: Array.from({ length: 21 }, () => f.visit) })).status, 400);
  assert.equal(calls, 1);
});

