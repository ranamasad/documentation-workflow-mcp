import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCiphertextCache } from '../src/ciphertext-cache.js';
import { canonical, DocumentationV3Error, type V3Access, type V3Store } from '../src/documentation-v3.js';
import { createManagedDocumentation, forgetImportedKeys, registerImportedKeys } from '../src/managed-documentation.js';
import { buildTransferFile, reencryptProject, rekeyProjectData, transferFile } from '../src/project-transfer.js';
import { DATA_KEY_LABELS, documentationEncryptionRoot, exportDataKeys, projectDataKey, registerImportedDataKeys } from '../src/managed-documentation.js';
import { issueRecords, type Issue } from '../src/issues.js';
import { exportPKCS8, generateKeyPair } from 'jose';
import { fakeFirestore } from './fake-firestore.js';
import { encode } from './firestore-fixture.js';
import type { RecordData, ReleaseMetadata } from '../src/v3-client.js';

const projectId = '22222222-2222-4222-8222-222222222222';
const metadata: ReleaseMetadata = { version: '1.0.0', tags: ['New'], summary: 'First release.', operation: 'apply' };
const hostedRoot = Buffer.alloc(32, 11).toString('base64url');
const selfRoot = Buffer.alloc(32, 22).toString('base64url');

function memoryStore() {
  const docs = new Map<string, Record<string, unknown>>();
  const store: V3Store = {
    async get(path) { return docs.has(path) ? { data: docs.get(path)! } : null; },
    async getMany(paths) { return Promise.all(paths.map(path => store.get(path))); },
    async immutable(path, data) {
      if (docs.has(path)) assert.equal(canonical(docs.get(path)), canonical(data));
      docs.set(path, data);
    },
    async publish(input) {
      const env = input.release.scope.environment;
      const current = docs.get('documentationV3Environments/' + env);
      if ((current?.releaseId ?? 'empty') !== input.expected) throw new DocumentationV3Error(409, 'CAS conflict');
      const generation = Number(current?.generation ?? 0) + 1;
      docs.set('documentationV3Releases/' + input.releaseId, input.release);
      docs.set('documentationV3Environments/' + env, { format: 3, releaseId: input.releaseId, generation, keyId: input.release.scope.keyId });
      return generation;
    }
  };
  return { docs, store };
}
const access: V3Access = { projectId, userId: null, name: 'Guide', role: 'owner', email: 'owner@example.com', administrator: true,
  environments: ['development', 'production'], firebaseProject: 'guide-docs', serviceAccountKey: 'test-only' };
const records = () => JSON.parse(readFileSync('contract-v3/examples/v2-content.json', 'utf8')) as RecordData[];

test('a project moves between servers with its content keys; the master key never travels and the next release rotates', async () => {
  const { docs, store } = memoryStore();
  const hosted = createManagedDocumentation(access, { masterKey: hostedRoot, store, cache: createCiphertextCache({ warn() {} }) });
  await hosted.publish('development', { records: records(), metadata, expected: 'empty' });
  const keys = await hosted.exportKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!.environment, 'development');
  const file = buildTransferFile('hosted', { id: projectId, name: 'Guide', firebaseProject: 'guide-docs', environments: ['development', 'production'], settings: {} }, keys);
  const serialized = JSON.stringify(file);
  assert.ok(!serialized.includes(hostedRoot), 'The export never carries the master key.');
  assert.deepEqual(transferFile.parse(JSON.parse(serialized)), file);
  await assert.rejects(createManagedDocumentation({ ...access, role: 'author' }, { masterKey: hostedRoot, store }).exportKeys(), /owners and admins/);

  // The new server has a different master key: without the imported keys it cannot read.
  const fresh = () => createManagedDocumentation(access, { masterKey: selfRoot, store, cache: createCiphertextCache({ warn() {} }) });
  await assert.rejects(fresh().read('development'), /does not match this environment/);
  registerImportedKeys(projectId, Object.fromEntries(keys.map(entry => [entry.keyId, entry.key])));
  try {
    const before = (await fresh().read('development'));
    assert.deepEqual(before.records, records());
    // The first publication on the new server rotates to a key derived from its own master key, without being asked.
    await fresh().publish('development', { records: records(), metadata: { ...metadata, version: '1.0.1' }, expected: before.head!.releaseId });
    const after = await fresh().head('development');
    assert.notEqual(after.head!.keyId, keys[0]!.keyId);
    forgetImportedKeys(projectId);
    assert.deepEqual((await fresh().read('development')).records, records(), 'The new release opens with the new server key alone.');
    assert.ok(docs.has('documentationV3ManagedKeys/' + after.head!.keyId));
  } finally { forgetImportedKeys(projectId); }
});

test('re-encrypting a moved project republishes each environment under the new key and skips empty ones', async () => {
  const { store } = memoryStore();
  const old = createManagedDocumentation(access, { masterKey: hostedRoot, store, cache: createCiphertextCache({ warn() {} }) });
  await old.publish('development', { records: records(), metadata, expected: 'empty' });
  const keys = await old.exportKeys();
  try {
    const result = await reencryptProject(access, keys, { masterKey: selfRoot, store, cache: createCiphertextCache({ warn() {} }) });
    assert.equal(result.moved.length, 1);
    assert.deepEqual(result.skipped.map(item => item.environment), ['production']);
    forgetImportedKeys(projectId);
    const snapshot = await createManagedDocumentation(access, { masterKey: selfRoot, store, cache: createCiphertextCache({ warn() {} }) }).read('development');
    assert.deepEqual(snapshot.records, records());
    assert.equal(snapshot.metadata?.operation, 'import');
    await assert.rejects(reencryptProject({ ...access, role: 'author' }, keys, { masterKey: selfRoot, store }), /owners and admins/);
  } finally { forgetImportedKeys(projectId); }
});

test('issues, attachments and feedback keys travel per project and the new server re-keys the stored data', async () => {
  const issueId = '33333333-3333-4333-8333-333333333333';
  const now = '2026-11-01T10:00:00.000Z';
  const issue = { id: issueId, environment: 'development', type: 'issue', status: 'open', title: 'Export button fails', description: 'It fails.',
    original: 'It fails.', ai: false, page: null, reporter: { uid: 'u1', email: 'reader@example.com', displayName: 'Reader' },
    assignee: null, assignedBy: null, assignedAt: null, answer: null, createdAt: now, updatedAt: now } as unknown as Issue;
  const oldRoot = documentationEncryptionRoot(hostedRoot);
  const newRoot = documentationEncryptionRoot(selfRoot);
  const dataKeys = exportDataKeys(projectId, ['development', 'production'], hostedRoot);
  assert.deepEqual(dataKeys.map(entry => entry.purpose + (entry.environment ? ':' + entry.environment + ':' + entry.kind : '')),
    ['issues', 'issue-attachments', 'profile', 'telemetry:development:visit', 'telemetry:development:vote', 'telemetry:production:visit', 'telemetry:production:vote']);
  assert.ok(!JSON.stringify(dataKeys).includes(hostedRoot), 'Only derived keys travel.');
  assert.deepEqual(transferFile.parse(JSON.parse(JSON.stringify(buildTransferFile('hosted',
    { id: projectId, name: 'Guide', firebaseProject: 'guide-docs', environments: ['development'], settings: {} }, [], dataKeys)))).dataKeys, dataKeys);

  // A self-hosted server keeps the imported keys: old issues open with its own master key in place.
  const path = issueRecords.collection(projectId) + '/' + issueId;
  const sealed = issueRecords.seal(oldRoot, projectId, path, issue);
  assert.throws(() => issueRecords.open(newRoot, projectId, path, sealed), /failed authentication|authentication/i);
  registerImportedDataKeys(projectId, dataKeys);
  try {
    assert.equal(issueRecords.open(newRoot, projectId, path, sealed).title, 'Export button fails');
    assert.deepEqual(projectDataKey(newRoot, DATA_KEY_LABELS.telemetry, { projectId, environment: 'production', kind: 'vote' }),
      projectDataKey(oldRoot, DATA_KEY_LABELS.telemetry, { projectId, environment: 'production', kind: 'vote' }));
  } finally { forgetImportedKeys(projectId); }

  // The hosted import re-keys the stored records instead, and running it twice is safe.
  const firestore = fakeFirestore('guide-docs');
  const partPath = issueRecords.parts(projectId, issueId) + '/a1.0';
  const fields = (value: object) => (encode(value) as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields;
  firestore.docs.set(path, { fields: fields(sealed), updateTime: 't1' });
  firestore.docs.set(partPath, { fields: fields(issueRecords.sealPart(oldRoot, projectId, partPath, Buffer.from('screenshot'))), updateTime: 't1' });
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const serviceAccountKey = JSON.stringify({ type: 'service_account', project_id: 'guide-docs', client_email: 'mcp@guide-docs.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey) });
  const fetchService: typeof fetch = async (input, init) => String(input) === 'https://oauth2.googleapis.com/token'
    ? Response.json({ access_token: 'test-token', expires_in: 3600 }) : firestore.fetchFake(input, init);
  const target = { ...access, serviceAccountKey };
  assert.deepEqual(await rekeyProjectData(target, dataKeys, { fetchService, masterKey: selfRoot }), { issues: 1, attachments: 1, telemetry: 0 });
  const read = async (key: string) => (await (await fetchService('https://firestore.googleapis.com/v1/projects/guide-docs/databases/(default)/documents/' + key)).json()) as { fields: Record<string, { stringValue: string }> };
  const plain = (doc: { fields: Record<string, { stringValue: string }> }) => Object.fromEntries(Object.entries(doc.fields).map(([key, value]) => [key, value.stringValue]));
  assert.equal(issueRecords.open(newRoot, projectId, path, plain(await read(path))).title, 'Export button fails');
  assert.equal(issueRecords.openPart(newRoot, projectId, partPath, plain(await read(partPath))).toString(), 'screenshot');
  assert.deepEqual(await rekeyProjectData(target, dataKeys, { fetchService, masterKey: selfRoot }), { issues: 0, attachments: 0, telemetry: 0 });
  await assert.rejects(rekeyProjectData({ ...target, role: 'author' }, dataKeys, { fetchService, masterKey: selfRoot }), /owners and admins/);
});
