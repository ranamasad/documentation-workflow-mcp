import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import {
  createFirestoreReader, decodeFields, FirestoreAccessError, openRelease, personalTokens, readArticles, serviceAccountTokens
} from '../src/firestore.js';
import { createPublishedDocumentation, type ReadAccess } from '../src/published.js';
import type { ProjectStore } from '../src/project-store.js';
import { fakeFirestore, projectId, records } from './firestore-fixture.js';

const tokens = async () => 'test-access-token';

test('Firestore values decode, including nested maps, arrays and timestamps', () => {
  assert.deepEqual(decodeFields({
    a: { stringValue: 'x' }, b: { integerValue: '7' }, c: { doubleValue: 1.5 }, d: { booleanValue: true }, e: { nullValue: null },
    f: { timestampValue: '2026-01-01T00:00:00Z' }, g: { arrayValue: { values: [{ stringValue: 'y' }] } }, h: { arrayValue: {} },
    i: { mapValue: { fields: { j: { integerValue: '1' } } } }
  }), { a: 'x', b: 7, c: 1.5, d: true, e: null, f: '2026-01-01T00:00:00Z', g: ['y'], h: [], i: { j: 1 } });
});

test('the reader opens the published release and verifies scoped revisions', async () => {
  const firestore = fakeFirestore();
  const reader = createFirestoreReader(projectId, tokens, firestore.fetchFirestore);
  assert.equal(await openRelease(reader, 'development'), null, 'Unpublished environments return nothing.');
  const release = (await openRelease(reader, 'beta'))!;
  assert.equal(release.version, '1.2.0');
  assert.deepEqual(release.manifest, firestore.manifest);
  const articles = await readArticles(reader, release, ['foundation', firestore.changed]);
  assert.deepEqual(articles.map(item => item.key), ['foundation', firestore.changed]);
  assert.ok(firestore.calls.every(url => !url.includes('/documentationRevisions/')), 'Reads use the reader-visible environment copies, not admin-only canonical revisions.');
  await assert.rejects(readArticles(reader, release, ['catalog2/missing']), /Not published/);

  const corrupt = fakeFirestore({ corrupt: true });
  const corruptReader = createFirestoreReader(projectId, tokens, corrupt.fetchFirestore);
  await assert.rejects(readArticles(corruptReader, (await openRelease(corruptReader, 'beta'))!, [corrupt.changed]), /failed verification/);
  const denied = createFirestoreReader(projectId, tokens, fakeFirestore({ deny: true }).fetchFirestore);
  await assert.rejects(openRelease(denied, 'beta'), (error: unknown) => error instanceof FirestoreAccessError && error.status === 403);
});

test('service-account tokens are signed with the key, scoped to Firestore and cached', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const key = JSON.stringify({ type: 'service_account', project_id: projectId, client_email: 'reader@acme-docs.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey) });
  let exchanges = 0;
  const fetchGoogle: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    exchanges++;
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { payload } = await jwtVerify(form.get('assertion')!, publicKey, { issuer: 'reader@acme-docs.iam.gserviceaccount.com', audience: 'https://oauth2.googleapis.com/token' });
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/datastore', 'Only the Firestore scope is requested.');
    return Response.json({ access_token: 'sa-token', expires_in: 3600 });
  };
  const source = serviceAccountTokens(key, fetchGoogle);
  assert.equal(await source(), 'sa-token');
  assert.equal(await source(), 'sa-token');
  assert.equal(exchanges, 1, 'Tokens are reused until they near expiry.');
  assert.throws(() => serviceAccountTokens(JSON.stringify({ type: 'authorized_user' })), /service_account|invalid/i);
  const rejected = serviceAccountTokens(key, async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  await assert.rejects(rejected(), /rejected by Google/);
});

test('personal tokens refresh the member\'s own Firebase sign-in', async () => {
  const fetchSecure: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://securetoken.googleapis.com/v1/token?key=AIzaTestOnlyPublicKey');
    assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'refresh-1');
    return Response.json({ id_token: 'firebase-id-token', expires_in: '3600' });
  };
  assert.equal(await personalTokens('AIzaTestOnlyPublicKey', 'refresh-1', fetchSecure)(), 'firebase-id-token');
  await assert.rejects(personalTokens('k', 'revoked', async () => Response.json({ error: { message: 'TOKEN_EXPIRED' } }, { status: 400 }))(), /Reconnect it/);
});

function store(access: Partial<ReadAccess>): ProjectStore {
  const full: ReadAccess = { projectId: 'a0000000-0000-4000-8000-000000000001', name: 'Acme', role: 'viewer', firebaseProject: projectId,
    firebaseApiKey: null, environments: ['beta'], mode: 'personal', serviceAccountKey: null, personalRefreshToken: 'refresh-1', ...access };
  return {
    list: async () => [], save: async () => { throw new Error('read-only'); }, forget: async () => false,
    readAccess: async () => full, memberEmail: async () => 'reader@example.com'
  };
}

test('published documentation tools give viewers overview, search, articles and changes', async () => {
  const firestore = fakeFirestore();
  const fetchAll: typeof fetch = async (input, init) => String(input).startsWith('https://securetoken')
    ? Response.json({ id_token: 'firebase-id-token', expires_in: '3600' }) : firestore.fetchFirestore(input, init);
  const docs = createPublishedDocumentation(store({ firebaseApiKey: 'AIzaTestOnlyPublicKey' }), fetchAll);
  const overview = await docs.overview({ project: 'Acme' });
  assert.equal(overview.release.version, '1.2.0');
  assert.equal(overview.release.environment, 'beta');
  assert.equal(overview.totalArticles, records.length - 1);
  assert.equal(overview.format, 2);
  assert.equal(overview.migration?.targetFormat, 3);
  assert.equal(overview.migration?.requiresApproval, true);
  assert.match(overview.formatNotice ?? '', /migrate_documentation_to_v3/);
  assert.equal(overview.site.name, records[0]!.data.meta && (records[0]!.data.meta as { appName: string }).appName);
  const found = await docs.search({ project: 'Acme', query: 'alpha' });
  assert.equal(found.results[0]?.label, 'Alpha title');
  const read = await docs.read({ project: 'Acme', keys: [firestore.changed] });
  assert.equal(read.articles[0]?.lastChange?.tags[0], 'New');
  assert.ok(read.articles[0]?.content.value);
  const changes = await docs.changes({ project: 'Acme' });
  assert.deepEqual(changes.changes.map(change => [change.key, change.kind]), [[firestore.changed, 'added']]);

  await assert.rejects(docs.overview({ project: 'Acme', environment: 'production' }), /You can read: beta/);
  await assert.rejects(createPublishedDocumentation(store({ mode: null }), fetchAll).overview({ project: 'Acme' }), /not set up/);
  await assert.rejects(createPublishedDocumentation(store({ firebaseApiKey: 'k', personalRefreshToken: null }), fetchAll).overview({ project: 'Acme' }), /Connect your Firebase sign-in/);
  await assert.rejects(createPublishedDocumentation(store({ mode: 'service-account' }), fetchAll).overview({ project: 'Acme' }), /upload the project's read-only service-account key/);
  await assert.rejects(createPublishedDocumentation(store({ firebaseProject: null }), fetchAll).overview({ project: 'Acme' }), /no Firebase project ID/);
});

test('hosted plaintext tools refuse environments migrated to contract-v3', async () => {
  const firestore = fakeFirestore();
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const key = JSON.stringify({ type: 'service_account', project_id: projectId, client_email: 'reader@acme-docs.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey) });
  const fetchAll: typeof fetch = async (input, init) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (String(input).endsWith('/documentationV3Environments/beta')) return Response.json({ fields: { releaseId: { stringValue: 'encrypted-release' } } });
    return firestore.fetchFirestore(input, init);
  };
  const docs = createPublishedDocumentation(store({ mode: 'service-account', serviceAccountKey: key }), fetchAll);
  await assert.rejects(docs.read({ project: 'Acme', keys: ['foundation'] }), /Server-managed encryption is not configured/);
  assert.equal(firestore.calls.some(url => url.includes('/documentationEnvironments/')), false);
});
