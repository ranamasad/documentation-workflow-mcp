import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { createCiphertextCache } from '../src/ciphertext-cache.js';
import { canonical, DocumentationV3Error, type V3Access, type V3Store } from '../src/documentation-v3.js';
import { DATA_KEY_LABELS, exportDataKeys, forgetImportedKeys, projectDataKey } from '../src/managed-documentation.js';
import { buildTransferFile, reencryptProject, transferFile } from '../src/project-transfer.js';
import { createSelfHosted, readSelfHostedConfig } from '../src/self-hosted.js';
import type { RecordData, ReleaseMetadata } from '../src/v3-client.js';
import { fakeFirestore } from './fake-firestore.js';
import { encode } from './firestore-fixture.js';

const fields = (value: Record<string, unknown>) => (encode(value) as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields;

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

async function selfHostedFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'self-hosted-'));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  writeFileSync(join(dir, 'sa.json'), JSON.stringify({ type: 'service_account', project_id: 'guide-docs',
    client_email: 'mcp@guide-docs.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) }));
  const file = { owner: 'Owner@Example.com', projects: [{ id: projectId, name: 'Guide', firebaseProject: 'guide-docs',
    serviceAccountKeyFile: 'sa.json', environments: ['development', 'production'],
    site: { token: 'dsite_' + 'a'.repeat(43), origins: ['https://guide-docs.web.app'] } }] };
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(file));
  const config = readSelfHostedConfig({ MCP_PROJECTS_FILE: join(dir, 'projects.json') })!;
  const firestore = fakeFirestore('guide-docs');
  const fetchService: typeof fetch = async (input, init) => String(input) === 'https://oauth2.googleapis.com/token'
    ? Response.json({ access_token: 'test-token', expires_in: 3600 }) : firestore.fetchFake(input, init);
  const signer = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(signer.publicKey), kid: 'k1', alg: 'RS256' };
  const firebaseKeys = createLocalJWKSet({ keys: [jwk] });
  const idToken = (email: string, extra: Record<string, unknown> = {}) => new SignJWT({ email, email_verified: true,
    firebase: { sign_in_provider: 'google.com' }, name: 'Reader', ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://securetoken.google.com/guide-docs').setAudience('guide-docs')
    .setSubject('uid-' + email).setIssuedAt().setExpirationTime('1h').sign(signer.privateKey);
  const local = createSelfHosted(config, { fetchService, firebaseKeys, masterKey: selfRoot });
  return { dir, config, local, firestore, idToken };
}
const request = (origin?: string) => ({ headers: origin ? { origin } : {} }) as unknown as IncomingMessage;
const nothing = {} as ServerResponse;

test('projects.json lists the owner\'s projects, saves settings back and checks the service-account key', async () => {
  const { dir, local, config } = await selfHostedFixture();
  const listed = await local.projects.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.workspace.role, 'owner');
  assert.equal(await local.projects.memberEmail(), 'owner@example.com');
  const access = await local.projects.readAccess('guide');
  assert.equal(access.projectId, projectId);
  assert.equal(access.mode, 'service-account');
  await local.projects.save('Guide', { audiences: ['support'] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).projects[0].settings, { audiences: ['support'] });
  await assert.rejects(local.projects.readAccess('Missing'), /no project called "Missing"/);
  config.file.projects[0]!.firebaseProject = 'other-docs';
  await assert.rejects(local.projects.readAccess('Guide'), /belongs to guide-docs, not other-docs/);
  assert.throws(() => readSelfHostedConfig({ MCP_PROJECTS_JSON: '{"owner":"x","projects":[]}' }), /owner/);
  const moved = { owner: 'me@example.com', projects: [{ id: projectId, name: 'Moved', firebaseProject: 'guide-docs', serviceAccountKeyEnv: 'SA',
    importedDataKeys: exportDataKeys(projectId, ['development'], hostedRoot) }] };
  try {
    readSelfHostedConfig({ MCP_PROJECTS_JSON: JSON.stringify(moved) });
    assert.deepEqual(projectDataKey(Buffer.alloc(32, 22), DATA_KEY_LABELS.issues, { projectId }),
      projectDataKey(Buffer.alloc(32, 11), DATA_KEY_LABELS.issues, { projectId }), 'Old issues open with the imported key on the new server.');
  } finally { forgetImportedKeys(projectId); }
  assert.equal(readSelfHostedConfig({ MCP_PROJECTS_FILE: undefined, MCP_PROJECTS_JSON: undefined }), undefined);
});

test('website readers need the site token, a registered origin, verified Google sign-in and access in the project\'s Firestore', async () => {
  const { local, firestore, idToken } = await selfHostedFixture();
  const siteToken = 'dsite_' + 'a'.repeat(43);
  const ask = async (email: string, origin = 'https://guide-docs.web.app', token = siteToken) =>
    local.v3Authenticate(request(origin), nothing, { action: 'head', siteToken: token, idToken: await idToken(email) } as never, false);
  await assert.rejects(ask('reader@example.com', 'https://evil.example'), /Site access denied/);
  await assert.rejects(ask('reader@example.com', undefined, 'dsite_' + 'b'.repeat(43)), /Site access denied/);
  await assert.rejects(ask('reader@example.com'), /Website membership required/);
  firestore.docs.set('teams/qa', { fields: fields({ name: 'QA', environments: ['development'], reader: 'testers' }), updateTime: 't1' });
  firestore.docs.set('feedbackAccess/reader@example.com', { fields: fields({ enabled: true, teamId: 'qa' }), updateTime: 't1' });
  const reader = await ask('Reader@Example.com');
  assert.deepEqual(reader.environments, ['development']);
  assert.equal(reader.administrator, false);
  assert.equal(reader.team, 'QA');
  assert.equal(reader.reader, 'testers');
  firestore.docs.set('adminAccess/boss@example.com', { fields: fields({ enabled: true }), updateTime: 't1' });
  const admin = await ask('boss@example.com');
  assert.deepEqual(admin.environments, ['development', 'production']);
  assert.equal(admin.administrator, true);
  await assert.rejects(local.v3Authenticate(request(), nothing, { action: 'head', project: 'Guide' } as never, false), /bearer token/);
  const owner = await local.v3Authenticate(request(), nothing, { action: 'head', project: 'Guide' } as never, true);
  assert.equal(owner.role, 'owner');
  assert.equal(await local.v3Preflight({ headers: { origin: 'https://guide-docs.web.app', 'access-control-request-method': 'POST' } } as never), 'https://guide-docs.web.app');
  assert.equal(await local.v3Preflight({ headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } } as never), null);
});
