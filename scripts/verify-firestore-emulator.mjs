// End-to-end check of the published-documentation reader against a real Firestore
// (the local emulator) using the docs-site's own rules and publish engine.
//
// Run from the docs-site checkout so its firebase.json and firestore.rules are loaded:
//   cd ~/Documents/docs-site
//   DOCS_SITE=$PWD npx firebase emulators:exec --only firestore --project demo-mcp-reader \
//     "node /path/to/documentation-mcp/scripts/verify-firestore-emulator.mjs"
// Requires Java (Firestore emulator) and a prior `npm run build` here. Uses only fake
// local data and never contacts Google.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createFirestoreReader, FirestoreAccessError, openRelease, readArticles } from '../dist/src/firestore.js';

const site = resolve(process.env.DOCS_SITE ?? '');
const siteRequire = createRequire(resolve(site, 'package.json'));
const engine = siteRequire('./assets/js/documentation-engine');
const fixtures = siteRequire('./tests/fixtures/dynamic-documentation');

const projectId = 'demo-mcp-reader';
const endpoint = 'http://' + (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8088');
const documents = endpoint + '/v1/projects/' + projectId + '/databases/(default)/documents';
const adminEmail = 'admin@example.invalid';
const betaTeam = '33333333-3333-4333-8333-333333333333';
const owner = { Authorization: 'Bearer owner' }; // emulator-only rules bypass for seeding
const TIMESTAMP = Symbol('server timestamp');

function encode(value) {
  if (value === TIMESTAMP) return { timestampValue: new Date().toISOString() };
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) } };
}
async function write(path, data, mustNotExist = false) {
  const response = await fetch(documents + '/' + path + (mustNotExist ? '?currentDocument.exists=false' : ''), {
    method: 'PATCH', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encode(data).mapValue.fields })
  });
  // Immutable revisions are shared between environments, so an existing one is expected.
  if (mustNotExist && response.status === 409) return;
  if (!response.ok) throw new Error('Seeding ' + path + ' failed: ' + response.status + ' ' + await response.text());
}

// Unsigned Firebase ID token in the emulator's accepted format (never valid against Google).
const emulatorToken = (uid, email) => {
  const encodeJson = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return encodeJson({ alg: 'none', typ: 'JWT' }) + '.' + encodeJson({
    iss: 'https://securetoken.google.com/' + projectId, aud: projectId, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now,
    email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: { email: [email] } }
  }) + '.';
};

const clear = await fetch(endpoint + '/emulator/v1/projects/' + projectId + '/databases/(default)/documents', { method: 'DELETE' });
assert.ok(clear.ok, 'Emulator must be reachable at ' + endpoint);
await write('teams/' + betaTeam, { name: 'Beta testers', environments: ['beta'] });
await write('feedbackAccess/tester@example.invalid', { enabled: true, teamId: betaTeam });
await write('feedbackAccess/' + adminEmail, { enabled: true });
await write('adminAccess/' + adminEmail, { enabled: true });

// Publish exactly as the docs-site CLI/admin UI does, through its own engine.
const admin = createFirestoreReader(projectId, async () => 'owner', fetch, endpoint);
const adapter = {
  get: path => admin.get(path),
  timestamp: () => TIMESTAMP,
  create: (path, data) => write(path, data, true),
  advance: async (target, _source, releaseId) => {
    const current = await admin.get('documentationEnvironments/' + target.environment);
    engine.expected({ head: current }, target.head?.data.releaseId || 'empty');
    await write('documentationEnvironments/' + target.environment, { releaseId, generation: (target.head?.data.generation || 0) + 1, updatedAt: TIMESTAMP });
  }
};
const fields = { actor: adminEmail, tags: ['New'], summary: 'Initial catalog' };
await engine.publish(adapter, { ...fields, version: '1.0.0', environment: 'development', operation: 'apply', expected: 'empty', records: fixtures.catalog() });
const first = await engine.publish(adapter, { ...fields, version: '1.0.0', environment: 'beta', operation: 'apply', expected: 'empty', records: fixtures.catalog() });
const changed = structuredClone(fixtures.catalog()[1]);
changed.data.value.stock = 99;
await engine.publish(adapter, { actor: adminEmail, version: '1.1.0', tags: ['Changed'], summary: 'Stock corrected', environment: 'beta',
  operation: 'apply', expected: first.releaseId, records: [changed] });

// 1. Administrator-level reads (what a read-only service account sees).
const beta = await openRelease(admin, 'beta');
assert.equal(beta.version, '1.1.0');
const changedKey = changed.key;
assert.deepEqual(beta.areaChanges[changedKey].tags, ['Changed']);
const [article] = await readArticles(admin, beta, [changedKey]);
assert.equal(article.data.value.stock, 99, 'Reads return the current published content.');
assert.equal(await openRelease(admin, 'production'), null, 'Unpublished environments are reported as empty.');

// 2. A tester's own Firebase sign-in: the docs-site rules decide (team limited to Beta).
const tester = createFirestoreReader(projectId, async () => emulatorToken('tester', 'tester@example.invalid'), fetch, endpoint);
const testerBeta = await openRelease(tester, 'beta');
assert.equal(testerBeta.releaseId, beta.releaseId);
const all = await readArticles(tester, testerBeta, Object.keys(testerBeta.manifest));
assert.equal(all.length, Object.keys(beta.manifest).length, 'Testers read every published Beta article through the scoped copies.');
await assert.rejects(openRelease(tester, 'development'),
  error => error instanceof FirestoreAccessError && error.status === 403, 'Rules deny environments outside the tester\'s team.');
const stranger = createFirestoreReader(projectId, async () => emulatorToken('stranger', 'stranger@example.invalid'), fetch, endpoint);
await assert.rejects(openRelease(stranger, 'beta'), error => error instanceof FirestoreAccessError && error.status === 403,
  'Signed-in Google users without reader membership are denied.');
console.log('Firestore emulator verification passed: engine-published v2 releases, admin reads, member reads limited by the docs-site rules, change notes and hash verification.');
