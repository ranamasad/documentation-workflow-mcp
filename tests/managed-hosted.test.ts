import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { exportPKCS8, generateKeyPair } from 'jose';
import type { ProjectStore } from '../src/project-store.js';
import type { ReadAccess } from '../src/published.js';
import { createPublishedDocumentation } from '../src/published.js';
import { createDocumentationPublisher, migrateInput, publishInput, recordSourceBaselinesInput } from '../src/publish.js';
import { fakeFirestore } from './fake-firestore.js';
import { reviewedCatalog, sentence as paragraph } from './reviewed-catalog.js';
import { releaseAdapter } from '../src/website-releases.js';
import { encode } from './firestore-fixture.js';
import { MAX_TOOL_RESULT_BYTES, text } from '../src/server.js';
import { createManagedDocumentation } from '../src/managed-documentation.js';

test('hosted tool responses enforce the complete UTF-8 serialized result limit without truncation', () => {
  const overhead = Buffer.byteLength(JSON.stringify(text('')), 'utf8');
  const atLimit = text('x'.repeat(MAX_TOOL_RESULT_BYTES - overhead));
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit), 'utf8'), MAX_TOOL_RESULT_BYTES);
  assert.equal(atLimit.isError, undefined);
  const oversized = text('x'.repeat(MAX_TOOL_RESULT_BYTES - overhead + 1));
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0]!.text, /fewer article keys or a smaller page/);
  assert.match(oversized.content[0]!.text, /Nothing was truncated/);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') < MAX_TOOL_RESULT_BYTES);
  assert.equal(text('é'.repeat(MAX_TOOL_RESULT_BYTES / 2)).isError, true, 'The limit counts UTF-8 bytes, not characters.');
  const payload = { content: 'x'.repeat(MAX_TOOL_RESULT_BYTES / 2) };
  const structured = text(payload, { structuredContent: payload, isError: false });
  assert.equal(structured.isError, true, 'Structured content is included and cannot overwrite the size error.');
  assert.equal('structuredContent' in structured, false, 'The oversized structured payload is not retained.');
  assert.deepEqual(text({ ok: true }), { content: [{ type: 'text', text: '{\n  "ok": true\n}' }] });
});

const records = reviewedCatalog() as unknown as { key: string; data: Record<string, unknown> }[];
// The same documentation without a reader coverage plan.
const { audienceCoverage: _plan, ...unplannedFoundation } = records[0]!.data;
const source = [{ ...records[0]!, data: unplannedFoundation }];

async function setup(beforeRequest?: (input: string, init?: RequestInit) => Promise<void>) {
  const firestore = fakeFirestore('managed-docs');
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const key = JSON.stringify({ type: 'service_account', project_id: 'managed-docs', client_email: 'mcp@managed-docs.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey) });
  const access: ReadAccess = { projectId: 'a0000000-0000-4000-8000-000000000001', name: 'Managed', role: 'owner',
    firebaseProject: 'managed-docs', firebaseApiKey: null, environments: ['development', 'beta', 'production'],
    mode: 'service-account', serviceAccountKey: key, personalRefreshToken: null };
  const store: ProjectStore = { list: async () => [], save: async () => { throw new Error('unused'); },
    forget: async () => false, readAccess: async () => access, memberEmail: async () => 'owner@example.com' };
  const fetchService: typeof fetch = async (input, init) => {
    await beforeRequest?.(String(input), init);
    return String(input) === 'https://oauth2.googleapis.com/token'
      ? Response.json({ access_token: 'test-token', expires_in: 3600 }) : firestore.fetchFake(input, init);
  };
  return { ...firestore, access, fetchService, publisher: createDocumentationPublisher(store, fetchService),
    reader: createPublishedDocumentation(store, fetchService),
    adapter: releaseAdapter('managed-docs', async () => 'token', 'owner@example.com', fetchService) };
}

const codeReview = (filesRead = 9) => ({ repositories: [{ name: 'app', role: 'frontend', sourceFiles: 10, filesRead }], areas: ['Settings'] });
type Publisher = ReturnType<typeof createDocumentationPublisher>;
/** convert mode end to end: the first call lists every page, the second reports each one as checked against the code and accurate. */
async function migrateChecked(publisher: Publisher, environment: 'development' | 'beta', expected: string) {
  const request = { project: 'Managed', environment, expected, mode: 'convert' as const, confirmed: true as const };
  const first = await publisher.migrate(request);
  assert.equal(first.migrated, false);
  assert.ok('requiresVerification' in first && first.requiresVerification);
  const features = (first as { features: { key: string }[] }).features;
  return publisher.migrate({ ...request, sourceReview: codeReview(),
    verification: features.map(feature => ({ key: feature.key, verdict: 'accurate' as const, checked: ['Settings screen'] })) });
}
const draft = (expected: string, values: {key: string; data: Record<string, unknown>; title?: string}[] = records) => publishInput.parse({ project: 'Managed', environment: 'development',
  expected, records: values, version: '1.0.0', tags: ['New'], summary: 'Published managed catalog.', confirmed: true,
  sourceReview: { repositories: [{ name: 'web', role: 'frontend', sourceFiles: 100, filesRead: 80 }], areas: ['Catalog'] } });

const startingBaselines = [
  {name: 'web', repository: 'github.com/example/web', commit: 'a'.repeat(40), branch: 'develop', tag: 'documentation-v1.0.0'},
  {name: 'backend', repository: 'github.com/example/backend', commit: 'd'.repeat(40), branch: 'develop', tag: 'documentation-v1.0.0'}
];

test('reviewed commits are isolated by environment and travel with promotion and historical rollback', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 52).toString('base64url');
  try {
    const f = await setup();
    const first = await f.publisher.publish(publishInput.parse({...draft('empty'), format: 3, sourceBaselines: startingBaselines}));
    const prod = await f.publisher.promote({project: 'Managed', source: 'development', target: 'production', expected: 'empty', expectedSource: first.releaseId, confirmed: true});
    const initial = await f.publisher.sourceBaselines({project: 'Managed', environment: 'production'});
    assert.deepEqual(initial.sourceBaselines?.repositories, startingBaselines);
    assert.equal(initial.sourceBaselines?.environment, 'production');
    assert.equal(initial.sourceBaselines?.releaseId, prod.releaseId);
    const webB = {name: 'web', repository: 'github.com/example/web', commit: 'b'.repeat(40), branch: 'develop'};
    const development = await f.publisher.publish(publishInput.parse({...draft(first.releaseId, [{...records[1]!, title: 'Develop membership'}]), sourceBaselines: [webB]}));
    const webC = {...webB, commit: 'c'.repeat(40), branch: 'release/prod'};
    const production = await f.publisher.publish(publishInput.parse({...draft(prod.releaseId, [{...records[1]!, title: 'Production membership'}]),
      environment: 'production', sourceBaselines: [webC]}));
    assert.deepEqual((await f.publisher.sourceBaselines({project: 'Managed', environment: 'development'})).sourceBaselines?.repositories, [webB, startingBaselines[1]]);
    assert.deepEqual((await f.publisher.sourceBaselines({project: 'Managed', environment: 'production'})).sourceBaselines?.repositories, [webC, startingBaselines[1]]);
    const count = [...f.docs.keys()].filter(key => key.startsWith('documentationV3SourceBaselines/')).length;
    await assert.rejects(f.publisher.publish(publishInput.parse({...draft(first.releaseId), sourceBaselines: [{...webB, commit: 'e'.repeat(40)}]})), /current release changed|conflict/i);
    assert.equal([...f.docs.keys()].filter(key => key.startsWith('documentationV3SourceBaselines/')).length, count);
    const restored = await f.publisher.rollback({project: 'Managed', environment: 'production', expected: production.releaseId,
      rollbackRelease: prod.releaseId, version: '1.0.1', tags: ['Hotfix'], summary: 'Restore the reviewed A snapshot.', confirmed: true});
    const rollback = await f.publisher.sourceBaselines({project: 'Managed', environment: 'production'});
    assert.equal(rollback.sourceBaselines?.releaseId, restored.releaseId);
    assert.deepEqual(rollback.sourceBaselines?.repositories, startingBaselines);
    assert.equal((await f.publisher.status({project: 'Managed', environment: 'development'})).environments[0]!.expected, development.releaseId);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('existing-release baseline registration needs verification, approval and an unchanged release', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 53).toString('base64url');
  try {
    const f = await setup();
    const first = await f.publisher.publish(publishInput.parse({...draft('empty'), format: 3}));
    assert.equal((await f.publisher.sourceBaselines({project: 'Managed', environment: 'development'})).baselineMissing, true);
    const request = {project: 'Managed', environment: 'development' as const, expected: first.releaseId,
      repositories: startingBaselines.map(({tag: _tag, ...baseline}) => baseline), verified: true as const, confirmed: true as const};
    assert.equal(recordSourceBaselinesInput.safeParse({...request, verified: false}).success, false);
    assert.equal(recordSourceBaselinesInput.safeParse({...request, confirmed: false}).success, false);
    const stored = await f.publisher.recordSourceBaselines(request);
    assert.equal(stored.recorded, true);
    assert.equal(stored.sourceBaselines.recordedBy, 'owner@example.com');
    assert.deepEqual((await f.publisher.recordSourceBaselines(request)).sourceBaselines, stored.sourceBaselines, 'Identical retries preserve the original registration.');
    const tagged = await f.publisher.recordSourceBaselines({...request, repositories: startingBaselines});
    assert.deepEqual(tagged.sourceBaselines.repositories, startingBaselines);
    assert.equal(tagged.sourceBaselines.recordedAt, stored.sourceBaselines.recordedAt);
    assert.equal(tagged.sourceBaselines.updatedBy, 'owner@example.com');
    assert.ok(tagged.sourceBaselines.updatedAt);
    assert.deepEqual((await f.publisher.recordSourceBaselines({...request, repositories: startingBaselines})).sourceBaselines, tagged.sourceBaselines);
    await assert.rejects(f.publisher.recordSourceBaselines({...request, repositories: startingBaselines.map(item => ({...item, tag: 'moved-tag'}))}), /different source baseline/);
    const overview = await f.reader.overview({project: 'Managed', environment: 'development'});
    assert.deepEqual((overview.sourceBaselines as typeof tagged.sourceBaselines).repositories, startingBaselines);
    await assert.rejects(f.publisher.recordSourceBaselines({...request, repositories: [{...startingBaselines[0]!, commit: 'f'.repeat(40)}]}), /different source baseline/);
    const next = await f.publisher.publish(publishInput.parse({...draft(first.releaseId, [{...records[1]!, title: 'Editorial wording only'}])}));
    assert.deepEqual((await f.publisher.sourceBaselines({project: 'Managed', environment: 'development'})).sourceBaselines?.repositories, startingBaselines);
    await assert.rejects(f.publisher.recordSourceBaselines(request), /current release changed/);
    f.access.role = 'viewer';
    await assert.rejects(f.publisher.recordSourceBaselines({...request, expected: next.releaseId}), /Viewers/);
    f.access.environments = ['development'];
    await assert.rejects(f.publisher.sourceBaselines({project: 'Managed', environment: 'production'}), /cannot read/);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('a failed atomic commit cannot advance either the release or its source baseline', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 54).toString('base64url');
  try {
    let fail = false;
    const f = await setup(async (url, init) => {
      if (fail && url.endsWith('/documents:commit') && String(init?.body).includes('documentationV3SourceBaselines/')) throw new Error('Simulated atomic commit failure');
    });
    const first = await f.publisher.publish(publishInput.parse({...draft('empty'), format: 3, sourceBaselines: startingBaselines}));
    fail = true;
    await assert.rejects(f.publisher.publish(publishInput.parse({...draft(first.releaseId, [{...records[1]!, title: 'Candidate change'}]),
      sourceBaselines: [{...startingBaselines[0]!, commit: 'b'.repeat(40), tag: 'documentation-v1.0.1'}]})), /Simulated atomic commit failure/);
    const status = await f.publisher.status({project: 'Managed', environment: 'development'});
    assert.equal(status.environments[0]!.expected, first.releaseId);
    assert.deepEqual((await f.publisher.sourceBaselines({project: 'Managed', environment: 'development'})).sourceBaselines?.repositories, startingBaselines);
    assert.equal([...f.docs.keys()].filter(key => key.startsWith('documentationV3SourceBaselines/')).length, 1);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('v3 publication requires coverage, merged patches cannot hide it, and historical promotion is gated', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 49).toString('base64url');
  try {
    const f = await setup();
    const unplanned = records.map(record => record.key === 'foundation' ? source[0]! : record);
    await assert.rejects(f.publisher.publish(publishInput.parse({ ...draft('empty', unplanned), format: 3 })), /AUDIENCE_PLAN_REQUIRED/);
    assert.equal(f.docs.has('documentationV3Environments/development'), false);
    const first = await f.publisher.publish(publishInput.parse({ ...draft('empty'), format: 3 }));
    const foundation = records[0]!;
    const navigation = foundation.data.navigation as { tabs: Record<string, unknown>[] };
    const hidden = { ...foundation, data: { ...foundation.data,
      navigation: { ...navigation, tabs: navigation.tabs.map(tab => ({ ...tab, audiences: ['developers'] })) } } };
    await assert.rejects(f.publisher.publish(draft(first.releaseId, [hidden])), /AUDIENCE_TOPIC_MISSING/);
    assert.equal((await f.publisher.status({ project: 'Managed', environment: 'development' })).environments[0]!.expected, first.releaseId);
    const historical = await setup();
    assert.ok(historical.access.firebaseProject);
    assert.ok(historical.access.serviceAccountKey);
    const imported = await createManagedDocumentation({ ...historical.access, firebaseProject: historical.access.firebaseProject,
      serviceAccountKey: historical.access.serviceAccountKey },
      { fetchService: historical.fetchService }).publish('development',
      { records: unplanned, expected: 'empty', metadata: { operation: 'import', version: '0.9.0', tags: ['New'], summary: 'Historical source without an audience plan.' } });
    await assert.rejects(historical.publisher.promote({ project: 'Managed', source: 'development', target: 'beta',
      expected: 'empty', expectedSource: imported.releaseId, confirmed: true }), /AUDIENCE_PLAN_REQUIRED/);
    assert.equal(historical.docs.has('documentationV3Environments/beta'), false);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('guided first publication explicitly creates v3 and never falls back to plaintext without its key', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  try {
    const { publisher, reader, docs } = await setup();
    const input = publishInput.parse({ ...draft('empty'), format: 3 });
    await assert.rejects(publisher.publish(input), /encryption is not configured/);
    assert.equal(docs.has('documentationEnvironments/development'), false);
    assert.equal(docs.has('documentationV3Environments/development'), false);
    process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 46).toString('base64url');
    const result = await publisher.publish(input);
    assert.equal(result.published, true);
    assert.equal(docs.has('documentationEnvironments/development'), false);
    assert.equal(docs.has('documentationV3Environments/development'), true);
    const overview = await reader.overview({ project: 'Managed' });
    assert.equal(overview.format, 3);
    assert.equal(overview.formatNotice, undefined);
    assert.equal(overview.migration, undefined);
    await assert.rejects(publisher.publish(input), /Release conflict/);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('URL-only hosted tools migrate, decrypt, merge drafts, promote without downgrade and roll back using production crypto', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString('base64url');
  try {
    const { publisher, reader, docs, access } = await setup();
    const legacy = await publisher.publish(draft('empty'));
    assert.equal(docs.has('documentationV3Environments/development'), false, 'Ordinary legacy publication must not silently migrate.');
    const overview = await reader.overview({ project: 'Managed' });
    assert.equal(overview.format, 2);
    assert.match(overview.formatNotice ?? '', /ask the user.*migrate_documentation_to_v3/);
    await assert.rejects(publisher.publish(publishInput.parse({ ...draft(legacy.releaseId), format: 3 })), /migrate_documentation_to_v3/);
    assert.equal(docs.has('documentationV3Environments/development'), false);
    const migrated = await migrateChecked(publisher, 'development', legacy.releaseId);
    assert.equal(migrated.migrated, true);
    assert.equal((migrated as { verification: Record<string, number> }).verification.accurate, records.length - 1);
    assert.equal((await reader.overview({ project: 'Managed' })).format, 3);
    const article = records.find(record => record.key !== 'foundation')!;
    assert.equal((await reader.search({ project: 'Managed', query: 'current settings' })).results.length > 0, true);
    assert.equal((await reader.read({ project: 'Managed', keys: [article.key] })).articles[0]!.key, article.key);
    const expected = (await publisher.status({ project: 'Managed', environment: 'development' })).environments[0]!.expected;
    const applied = await publisher.publish(draft(expected, [article]));
    assert.equal((await reader.overview({ project: 'Managed' })).totalArticles, records.length - 1, 'Partial draft keeps other articles.');
    await assert.rejects(publisher.publish(draft(expected, [article])), /conflict/i);
    const promoted = await publisher.promote({ project: 'Managed', source: 'development', target: 'beta', expected: 'empty',
      expectedSource: applied.releaseId, confirmed: true });
    assert.equal(promoted.promoted, true);
    assert.equal(docs.has('documentationEnvironments/beta'), false, 'Managed promotion cannot create a plaintext target.');
    assert.equal((await reader.overview({ project: 'Managed', environment: 'beta' })).format, 3);
    const rolled = await publisher.rollback({ project: 'Managed', environment: 'development', expected: applied.releaseId,
      rollbackRelease: legacy.releaseId, version: '1.0.1', tags: ['Hotfix'], summary: 'Restore published catalog.', confirmed: true });
    assert.equal(rolled.rolledBack, true);
    assert.equal((await reader.overview({ project: 'Managed' })).format, 3, 'Rollback to legacy remains encrypted.');
    const history = (await publisher.status({ project: 'Managed', environment: 'development' })).history!;
    assert.deepEqual(history.map(item => item.releaseId), [rolled.releaseId, applied.releaseId, expected]);
    assert.deepEqual(history.map(item => item.operation), ['rollback', 'apply', 'import']);
    assert.equal(history[0]!.version, '1.0.1');
    assert.equal(history[0]!.summary, 'Restore published catalog.');
    assert.equal(history[0]!.articles, records.length - 1);
    assert.ok(history.every(item => /^[a-f0-9-]{36}$/.test(item.releaseId)));
    assert.ok(history.every(item => item.author === 'owner@example.com' && !Number.isNaN(Date.parse(String(item.publishedAt)))),
      'Encrypted releases record who published them and when.');
    const beta = (await publisher.status({ project: 'Managed', environment: 'beta' })).environments[0]!.release as { author?: string };
    assert.equal(beta.author, 'owner@example.com');
    access.role = 'viewer';
    await assert.rejects(publisher.migrate({ project: 'Managed', environment: 'beta', expected: promoted.releaseId, mode: 'convert', confirmed: true }), /Viewers/);
    access.role = 'author';
    await assert.rejects(publisher.rollback({ project: 'Managed', environment: 'development', expected: rolled.releaseId,
      rollbackRelease: legacy.releaseId, version: '1.0.2', tags: ['Hotfix'], summary: 'Denied.', confirmed: true }), /owners and admins/);
    const encrypted = [...docs].filter(([path]) => path.startsWith('documentationV3'));
    assert.equal(JSON.stringify(encrypted).includes(paragraph), false, 'V3 Firebase documents contain ciphertext, not article prose.');
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('legacy v1 migration reports conversion before writing and pins the approved legacy release', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString('base64url');
  try {
    const { publisher, reader, docs } = await setup();
    const legacy = JSON.parse(readFileSync(new URL('../../contract/examples/complete.json', import.meta.url), 'utf8')) as { key: string; title: string }[];
    const manifest: Record<string, string> = {};
    for (const record of legacy) {
      const payload = JSON.stringify(record);
      const revision = createHash('sha256').update(payload).digest('hex');
      manifest[record.key] = revision;
      docs.set('documentationRevisions/' + revision, { fields: (encode({ schema: 1, key: record.key, title: record.title, payload }).mapValue as { fields: Record<string, unknown> }).fields, updateTime: 'seed' });
      docs.set('documentationEnvironments/development/revisions/' + revision, docs.get('documentationRevisions/' + revision)!);
    }
    const releaseId = randomUUID();
    const put = (path: string, value: unknown) => docs.set(path, {
      fields: (encode(value).mapValue as { fields: Record<string, unknown> }).fields, updateTime: 'seed'
    });

    put('documentationEnvironments/development', { releaseId, generation: 1 });
    put('documentationReleases/' + releaseId, { schema: 1, environment: 'development', operation: 'import',
      actor: 'owner@example.com', base: '', source: '', sourceRelease: '', rollbackRelease: '', manifest: JSON.stringify(manifest),
      version: '1.0.0', tags: ['New'], summary: 'Legacy published documentation.', createdAt: '2026-10-20T00:00:00Z' });
    const request = migrateInput.parse({ project: 'Managed', environment: 'development', expected: releaseId, mode: 'convert', confirmed: true });
    const overview = await reader.overview({ project: 'Managed' });
    assert.equal(overview.format, 1);
    assert.equal(overview.migration?.targetFormat, 3);
    const findings = await publisher.migrate(request);
    assert.equal(findings.migrated, false);
    assert.equal('requiresConversionApproval' in findings && findings.requiresConversionApproval, true);
    assert.equal('requiresVerification' in findings && findings.requiresVerification, true);
    assert.ok('report' in findings && findings.report);
    assert.equal(docs.has('documentationV3Environments/development'), false);
    await assert.rejects(publisher.migrate({ ...request, expected: randomUUID(), approveConversion: true }), /conflict/i);
    // The old content breaks current rules, so approval alone cannot migrate it.
    const blocked = await publisher.migrate({ ...request, approveConversion: true });
    assert.equal(blocked.migrated, false);
    assert.ok('requiresRewrite' in blocked && blocked.requiresRewrite);
    assert.ok(blocked.issues!.length > 0);
    assert.ok(blocked.rewrite!.some(record => record.key === 'foundation'));
    assert.match(blocked.next!, /source code/);
    assert.equal(docs.has('documentationV3Environments/development'), false);
    // The AI checks every page against the code: rewrites, new pages and removal of features the code no longer has.
    const keep = new Set(records.map(record => record.key));
    const existing = new Set(blocked.articles!);
    const remove = blocked.articles!.filter(key => !keep.has(key));
    const verification = [
      ...records.filter(record => record.key !== 'foundation').map(record => ({ key: record.key,
        verdict: existing.has(record.key) ? 'corrected' as const : 'added' as const, checked: ['Settings screen'] })),
      ...remove.map(key => ({ key, verdict: 'removed' as const, checked: ['Settings screen'] }))];
    const rewrite = { ...request, approveConversion: true, records, remove, verification };
    await assert.rejects(publisher.migrate(migrateInput.parse(rewrite)), /checked against the code/);
    await assert.rejects(publisher.migrate(migrateInput.parse({ ...rewrite, sourceReview: codeReview(5) })), /not read fully/);
    const unchecked = { ...rewrite, sourceReview: codeReview(), verification: verification.slice(1) };
    await assert.rejects(publisher.migrate(migrateInput.parse(unchecked)), /was not checked against the code/);
    const mislabelled = { ...rewrite, sourceReview: codeReview(), verification: verification.map((check, index) => index ? check : { ...check, verdict: 'accurate' as const }) };
    await assert.rejects(publisher.migrate(migrateInput.parse(mislabelled)), /marked accurate/);
    assert.equal(docs.has('documentationV3Environments/development'), false);
    const migrated = await publisher.migrate(migrateInput.parse({ ...rewrite, sourceReview: codeReview(), version: '2.0.0' }));
    assert.equal(migrated.migrated, true);
    assert.ok('rewritten' in migrated && migrated.rewritten!.includes('foundation'));
    const after = await reader.overview({ project: 'Managed' });
    assert.equal(after.format, 3);
    assert.equal(after.totalArticles, records.length - 1);
    assert.equal((await publisher.status({ project: 'Managed', environment: 'development' })).history![0]!.version, '2.0.0');
    assert.equal(migrateInput.safeParse({ ...request, confirmed: false }).success, false);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('fresh v3 documentation replaces older documentation without migration and deletes it', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 47).toString('base64url');
  try {
    const { publisher, reader, docs } = await setup();
    const legacy = await publisher.publish(draft('empty'));
    const beta = await publisher.promote({ project: 'Managed', source: 'development', target: 'beta', expected: 'empty', expectedSource: legacy.releaseId, confirmed: true });
    const fresh = publishInput.parse({ ...draft(legacy.releaseId), format: 3 });
    await assert.rejects(publisher.publish(fresh), /replaceLegacy: true/, 'Older documentation is never replaced without asking.');
    await assert.rejects(publisher.publish({ ...fresh, replaceLegacy: true, records: records.slice(1) }), /foundation and every article/);
    await assert.rejects(publisher.publish(publishInput.parse({ ...draft('empty'), format: 3, replaceLegacy: true })), /conflict/i);
    const replaced = await publisher.publish({ ...fresh, replaceLegacy: true });
    assert.equal(replaced.published, true);
    assert.equal((replaced as { legacyRemoved: { releases: number } }).legacyRemoved.releases, 1);
    assert.equal(docs.has('documentationEnvironments/development'), false, 'The old pointer is deleted.');
    assert.equal([...docs.keys()].some(key => key.startsWith('documentationEnvironments/development/')), false);
    assert.equal(docs.has('documentationEnvironments/beta'), true, 'Other environments keep their older documentation.');
    assert.ok([...docs.keys()].some(key => key.startsWith('documentationReleases/')));
    assert.equal((await reader.overview({ project: 'Managed', environment: 'development' })).format, 3);
    await assert.rejects(publisher.publish({ ...fresh, expected: replaced.releaseId, replaceLegacy: true }), /only for an environment/);
    // Promoting the new documentation over the older Beta deletes the last older documentation, shared revisions included.
    const promoted = await publisher.promote({ project: 'Managed', source: 'development', target: 'beta', expected: beta.releaseId,
      expectedSource: replaced.releaseId, confirmed: true });
    assert.equal(promoted.promoted, true);
    assert.ok('legacyRemoved' in promoted && promoted.legacyRemoved);
    assert.equal([...docs.keys()].some(key => key.startsWith('documentationEnvironments/') || key.startsWith('documentationReleases/') ||
      key.startsWith('documentationRevisions/')), false);
    assert.equal((await reader.overview({ project: 'Managed', environment: 'beta' })).format, 3);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('rewrite mode replaces the legacy pages with documentation written again from the code', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 46).toString('base64url');
  try {
    const { publisher, reader, docs } = await setup();
    const legacy = await publisher.publish(draft('empty'));
    const request = { project: 'Managed', environment: 'development' as const, expected: legacy.releaseId, mode: 'rewrite' as const, confirmed: true as const };
    const plan = await publisher.migrate(request);
    assert.equal(plan.migrated, false);
    assert.ok('requiresRewrite' in plan && plan.requiresRewrite);
    assert.match((plan as { next: string }).next, /never a source/);
    assert.equal(docs.has('documentationV3Environments/development'), false);
    const articles = records.filter(record => record.key !== 'foundation');
    await assert.rejects(publisher.migrate({ ...request, records }), /checked against the code/);
    await assert.rejects(publisher.migrate({ ...request, records: articles, sourceReview: codeReview() }), /foundation and every article/);
    await assert.rejects(publisher.migrate({ ...request, records, remove: [articles[0]!.key], sourceReview: codeReview() }), /replaces every page/);
    const migrated = await publisher.migrate({ ...request, records, sourceReview: codeReview() });
    assert.equal(migrated.migrated, true);
    assert.deepEqual((migrated as { replaced: string[] }).replaced, []);
    assert.equal((await reader.overview({ project: 'Managed' })).format, 3);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('mixed legacy source promotion retains managed encryption and checks both release IDs', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 44).toString('base64url');
  try {
    const { publisher, reader } = await setup();
    const source = await publisher.publish(draft('empty'));
    const target = await publisher.promote({ project: 'Managed', source: 'development', target: 'beta',
      expected: 'empty', expectedSource: source.releaseId, confirmed: true });
    const migration = await migrateChecked(publisher, 'beta', target.releaseId);
    assert.equal(migration.migrated, true);
    const expected = (await publisher.status({ project: 'Managed', environment: 'beta' })).environments[0]!.expected;
    await assert.rejects(publisher.promote({ project: 'Managed', source: 'development', target: 'beta',
      expected, expectedSource: randomUUID(), confirmed: true }), /conflict/i);
    const promoted = await publisher.promote({ project: 'Managed', source: 'development', target: 'beta',
      expected, expectedSource: source.releaseId, confirmed: true });
    assert.equal(promoted.promoted, true);
    assert.equal((await reader.overview({ project: 'Managed', environment: 'beta' })).format, 3);
    assert.equal((await reader.overview({ project: 'Managed', environment: 'development' })).format, 2);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});

test('a legacy writer cannot commit after migration wins between staging and the legacy transaction', async () => {
  const previous = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 45).toString('base64url');
  try {
    let migrateDuringBegin: (() => Promise<void>) | undefined;
    let transactionalMarkerReads = 0;
    const { publisher, reader, docs } = await setup(async input => {
      if (/\/documentationV3Environments\/development\?transaction=/.test(input)) transactionalMarkerReads++;
      if (input.endsWith(':beginTransaction') && migrateDuringBegin) {
        const migrate = migrateDuringBegin;
        migrateDuringBegin = undefined;
        await migrate();
      }
    });
    const legacy = await publisher.publish(draft('empty'));
    const legacyHead = JSON.stringify(docs.get('documentationEnvironments/development'));
    migrateDuringBegin = async () => {
      const result = await migrateChecked(publisher, 'development', legacy.releaseId);
      assert.equal(result.migrated, true);
    };
    const article = records.find(record => record.key !== 'foundation')!;
    const changed = { ...article, data: { ...article.data, blocks: [...article.data.blocks as unknown[],
      { id: 'new-draft', type: 'paragraph', text: paragraph.repeat(2) }] } };
    await assert.rejects(publisher.publish(draft(legacy.releaseId, [changed])), /contract-v3|encrypted|managed/i);
    assert.ok(transactionalMarkerReads > 0, 'The encrypted marker is read using the legacy transaction token.');
    assert.equal(JSON.stringify(docs.get('documentationEnvironments/development')), legacyHead, 'The stale legacy head was not advanced.');
    assert.equal((await reader.overview({ project: 'Managed' })).format, 3);
    assert.equal(JSON.stringify((await reader.read({ project: 'Managed', keys: [article.key] })).articles).includes('new-draft'), false);
  } finally {
    if (previous === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previous;
  }
});
