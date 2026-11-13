import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DraftStore, ProjectStore } from '../src/project-store.js';
import type { ReadAccess } from '../src/published.js';
import { createDocumentationPublisher, PART_RECORDS, publishInput, PublishError } from '../src/publish.js';
import { releaseAdapter } from '../src/website-releases.js';
import { fakeFirestore } from './fake-firestore.js';
import { reviewedCatalog, releaseNoteUpdate } from './reviewed-catalog.js';
import type { WireRecord } from '../src/validation.js';

const thin = JSON.parse(readFileSync(new URL('../../contract/examples/v2-catalog.json', import.meta.url), 'utf8')) as { key: string; title: string; data: Record<string, unknown> }[];
// A complete catalog written to the MCP's mandatory outline, as the quality checks require.
const records = reviewedCatalog() as unknown as typeof thin;
const project = { project: 'Acme' };

function setup(role: ReadAccess['role'], access: Partial<ReadAccess> = {}) {
  const { fetchFake, docs } = fakeFirestore('acme-docs');
  const full: ReadAccess = { projectId: 'a0000000-0000-4000-8000-000000000001', name: 'Acme', role, firebaseProject: 'acme-docs', firebaseApiKey: null,
    environments: ['development', 'beta', 'production'], mode: 'service-account', serviceAccountKey: '{}', personalRefreshToken: null, ...access };
  // Drafts as the database keeps them: one environment and the sealed payload of each part.
  const staged = new Map<string, { environment: string; parts: Map<number, { records: number; payload: string }> }>();
  const drafts: DraftStore = {
    async put(_name, _workspace, draft) {
      const found = staged.get(draft.id) ?? { environment: draft.environment, parts: new Map() };
      if (found.environment !== draft.environment) throw new PublishError(400, 'This draft is for ' + found.environment + '.');
      found.parts.set(draft.part, { records: draft.records, payload: draft.payload });
      staged.set(draft.id, found);
      return { environment: found.environment, parts: [...found.parts].sort(([a], [b]) => a - b).map(([part, value]) => ({ part, records: value.records })) };
    },
    async read(_name, _workspace, id) {
      const found = staged.get(id);
      if (!found) throw new PublishError(400, 'This draft does not exist or expired.');
      return { environment: found.environment, parts: [...found.parts].sort(([a], [b]) => a - b).map(([part, value]) => ({ part, payload: value.payload })) };
    },
    async remove(id) { staged.delete(id); }
  };
  const store: ProjectStore = { list: async () => [], save: async () => { throw new Error('unused'); }, forget: async () => false,
    readAccess: async () => full, memberEmail: async () => role + '@example.com', drafts };
  const publisher = createDocumentationPublisher(store, fetchFake, (firebaseProject, _key, actor) => releaseAdapter(firebaseProject, async () => 'token', actor, fetchFake));
  return { publisher, docs, staged };
}
const draft = (overrides: Record<string, unknown> = {}) => publishInput.parse({ ...project, environment: 'development', expected: 'empty', records,
  version: '1.0.0', tags: ['New'], summary: 'First publication.', confirmed: true,
  sourceReview: { repositories: [{ name: 'web', role: 'frontend', sourceFiles: 120, filesRead: 118 }], areas: ['Sign-in', 'Catalog'] }, ...overrides });

test('the MCP publishes, promotes and rolls back documentation itself', async () => {
  const { publisher, docs } = setup('owner');
  const first = await publisher.publish(draft());
  assert.equal(first.published, true);
  assert.equal(first.author, 'owner@example.com', 'The signed-in member is recorded as the author.');
  assert.ok(docs.has('documentationEnvironments/development'));

  const status = await publisher.status(project);
  const development = status.environments.find(item => item.environment === 'development')!;
  assert.equal(development.expected, first.releaseId);
  assert.equal(development.release?.version, '1.0.0');
  assert.equal(status.environments.find(item => item.environment === 'beta')!.expected, 'empty');

  await assert.rejects(publisher.publish(draft({ version: '1.0.1' })), (error: PublishError) => error.status === 409 && /documentation_release_status/.test(error.message),
    'A draft based on an older release never overwrites newer work.');

  const changed = { ...records[1]!, title: 'Renamed article' };
  const notes = releaseNoteUpdate(records as unknown as WireRecord[], '1.1.0');
  const second = await publisher.publish(draft({ expected: first.releaseId, records: [changed, ...notes], version: '1.1.0', tags: ['Changed'], summary: 'Rename.' }));
  const promoted = await publisher.promote({ ...project, source: 'development', target: 'beta', expected: 'empty', expectedSource: second.releaseId, confirmed: true });
  assert.equal(promoted.promoted, true);
  const beta = (await publisher.status({ ...project, environment: 'beta' })).environments[0]!;
  assert.equal(beta.release?.version, '1.1.0', 'Promotion keeps the source version.');

  const rolledBack = await publisher.rollback({ ...project, environment: 'development', expected: second.releaseId, rollbackRelease: first.releaseId,
    version: '1.1.1', tags: ['Hotfix'], summary: 'Restore the previous title.', confirmed: true });
  const history = await publisher.status({ ...project, environment: 'development' });
  assert.equal(history.environments[0]!.expected, rolledBack.releaseId);
  assert.equal(history.history?.length, 3);
});

test('hosted plaintext publication cannot replace a contract-v3 environment', async () => {
  const { publisher, docs } = setup('owner');
  docs.set('documentationV3Environments/development', { fields: { releaseId: { stringValue: 'encrypted-release' } }, updateTime: 'v3' });
  await assert.rejects(publisher.publish(draft()), /Server-managed encryption is not configured/);
  assert.equal(docs.has('documentationEnvironments/development'), false);
});

test('publishing refuses thin, plain-text drafts', async () => {
  await assert.rejects(setup('owner').publisher.publish(draft({ records: thin })), (error: PublishError) => error.status === 400 && /quality issue.*TOO_THIN/.test(error.message));
});

test('publication requires a coverage plan and rejects hiding required topics without changing the head', async () => {
  const { publisher, docs } = setup('owner');
  const missing = records.map(record => {
    if (record.key !== 'foundation') return record;
    const { audienceCoverage: _plan, ...data } = record.data;
    return { ...record, data };
  });
  await assert.rejects(publisher.publish(draft({ records: missing })), /AUDIENCE_PLAN_REQUIRED/);
  assert.equal(docs.has('documentationEnvironments/development'), false);
  const first = await publisher.publish(draft());
  const foundation = records.find(record => record.key === 'foundation')!;
  const navigation = foundation.data.navigation as { tabs: Record<string, unknown>[] };
  const hidden = { ...foundation, data: { ...foundation.data,
    navigation: { ...navigation, tabs: navigation.tabs.map(tab => ({ ...tab, audiences: ['developers'] })) } } };
  await assert.rejects(publisher.publish(draft({ expected: first.releaseId, records: [hidden] })), /AUDIENCE_TOPIC_MISSING/);
  assert.equal((await publisher.status({ ...project, environment: 'development' })).environments[0]!.expected, first.releaseId);
});

test('publishing refuses links to articles that do not exist', async () => {
  const linked = records.map((record, index) => index === 1 ? { ...record, data: { ...record.data,
    blocks: [...(record.data.blocks as unknown[]), { id: 'api', type: 'cards', items: [{ title: 'GET /items', href: '#/api/list-items' }] }] } } : record);
  await assert.rejects(setup('owner').publisher.publish(draft({ records: linked })), (error: PublishError) => error.status === 400 && /BROKEN_LINK.*#\/api\/list-items/.test(error.message));
});

test('publishing refuses documentation written without reading the code', async () => {
  const review = { repositories: [{ name: 'web', role: 'frontend', sourceFiles: 120, filesRead: 118 }, { name: 'api', role: 'backend', sourceFiles: 300, filesRead: 2 }], areas: ['Sign-in'] };
  await assert.rejects(setup('owner').publisher.publish(draft({ sourceReview: review })), (error: PublishError) => error.status === 400 && /api \(2 of 300 source files\)/.test(error.message));
  assert.equal(publishInput.safeParse({ ...project, environment: 'development', expected: 'empty', records, version: '1.0.0', tags: ['New'], summary: 'x', confirmed: true }).success, false,
    'A coverage report is required.');
});

test('existing documentation accepts a complete incremental source review without a whole-project reread', async () => {
  const {publisher} = setup('owner');
  const first = await publisher.publish(draft());
  const review = {mode: 'incremental', repositories: [{name: 'web', role: 'frontend', sourceFiles: 120,
    filesRead: 3, changedFiles: 2, changedFilesRead: 2}], areas: ['Membership']};
  const result = await publisher.publish(draft({expected: first.releaseId, records: [{...records[1]!, title: 'Updated membership'}], sourceReview: review}));
  assert.equal(result.published, true, 'Two changed files and one dependency are enough for this scoped update.');
});

test('incremental review cannot bypass an initial source review or omit changed code', async () => {
  const review = {mode: 'incremental', repositories: [{name: 'web', role: 'frontend', sourceFiles: 120,
    filesRead: 3, changedFiles: 2, changedFilesRead: 2}], areas: ['Membership']};
  await assert.rejects(setup('owner').publisher.publish(draft({sourceReview: review})), /existing published environment/);
  const {publisher} = setup('owner');
  const first = await publisher.publish(draft());
  for (const invalid of [
    {...review, repositories: [{...review.repositories[0]!, changedFilesRead: 1}]},
    {...review, repositories: [{name: 'web', role: 'frontend', sourceFiles: 120, filesRead: 3}]},
    {...review, repositories: [{...review.repositories[0]!, filesRead: 0}]},
    {...review, unread: ['Changed API implementation is inaccessible']}
  ]) await assert.rejects(publisher.publish(draft({expected: first.releaseId, records: [records[1]], sourceReview: invalid})), /incremental source review is incomplete/);
  assert.equal((await publisher.status({...project, environment: 'development'})).environments[0]!.expected, first.releaseId);
});

test('existing updates without a review mode are guided to incremental reporting, not a full reread', async () => {
  const {publisher} = setup('owner');
  const first = await publisher.publish(draft());
  await assert.rejects(publisher.publish(draft({expected: first.releaseId, records: [records[1]], sourceReview: {
    repositories: [{name: 'web', role: 'frontend', sourceFiles: 120, filesRead: 2}], areas: ['Membership']
  }})), /already has documentation.*mode="incremental".*Do not reread the whole project/);
  const result = await publisher.publish(draft({expected: first.releaseId, records: [{...records[1]!, title: 'Editorial clarification'}], sourceReview: {
    mode: 'incremental', repositories: [{name: 'web', role: 'frontend', sourceFiles: 120, filesRead: 0, changedFiles: 0, changedFilesRead: 0}],
    areas: ['Existing verified membership guidance']
  }}));
  assert.equal(result.published, true, 'An editorial-only correction can reuse verified source knowledge.');
});

test('publishing needs approval, the right role and a service-account key', async () => {
  assert.equal(publishInput.safeParse({ ...project, environment: 'development', expected: 'empty', records, version: '1.0.0', tags: ['New'], summary: 'x' }).success, false,
    'Without confirmed: true nothing is published.');
  await assert.rejects(setup('viewer').publisher.publish(draft()), (error: PublishError) => error.status === 403 && /Viewers/.test(error.message));
  await assert.rejects(setup('author').publisher.publish(draft({ environment: 'production' })), (error: PublishError) => error.status === 403 && /Authors publish to Development/.test(error.message));
  assert.equal((await setup('author').publisher.publish(draft())).published, true, 'Authors publish to Development.');
  await assert.rejects(setup('owner', { mode: 'personal', serviceAccountKey: null }).publisher.publish(draft()), /service-account key/);
  await assert.rejects(setup('owner').publisher.promote({ ...project, source: 'production', target: 'beta', expected: 'empty', expectedSource: 'a0000000-0000-4000-8000-000000000001', confirmed: true }), /Only Development/);
  const viewer = setup('viewer', { environments: ['beta'] });
  assert.deepEqual((await viewer.publisher.status(project)).environments.map(item => item.environment), ['beta'], 'Viewers only see environments they may read.');
});

test('large documentation is staged in parts and published by draftId', async () => {
  const { publisher, docs, staged } = setup('owner');
  const part = (number: number, items: unknown[], draftId?: string) =>
    publisher.stage({ ...project, environment: 'development', part: number, records: items, ...(draftId ? { draftId } : {}) });
  await assert.rejects(part(2, records.slice(0, 2)), /Start with part 1/);
  const first = await part(1, records.slice(0, 2));
  assert.equal(first.staged, true);
  assert.match(first.next, /part 2/);
  await part(2, [{ ...records[2]!, title: 'Old title' }], first.draftId);
  await part(2, records.slice(2, 4), first.draftId);
  const last = await part(3, records.slice(4), first.draftId);
  assert.equal(last.records, records.length, 'Sending a part number again replaces that part.');
  assert.equal(docs.has('documentationEnvironments/development'), false, 'Staging writes no documentation.');
  assert.ok(![...staged.values()][0]!.parts.get(1)!.payload.includes(records[1]!.key), 'Staged parts are sealed before they are stored.');

  await assert.rejects(publisher.publish(draft({ records: undefined, draftId: first.draftId, environment: 'beta' })), /staged for development/);
  await assert.rejects(publisher.publish(draft({ draftId: first.draftId })), /records or draftId, not both/);
  const published = await publisher.publish(draft({ records: undefined, draftId: first.draftId }));
  assert.equal(published.published, true);
  assert.equal(published.articles, records.length);
  assert.equal(staged.size, 0, 'A published draft is deleted.');
});

test('a failed staged publication keeps the draft and tampered parts are refused', async () => {
  const { publisher, staged } = setup('owner');
  const foundation = records.find(record => record.key === 'foundation')!;
  const { audienceCoverage: _plan, ...data } = foundation.data;
  const first = await publisher.stage({ ...project, environment: 'development', part: 1, records: [{ ...foundation, data }, ...records.filter(record => record !== foundation)] });
  await assert.rejects(publisher.publish(draft({ records: undefined, draftId: first.draftId })), /AUDIENCE_PLAN_REQUIRED/);
  assert.equal(staged.size, 1, 'The AI can replace the failing part and publish again.');
  await publisher.stage({ ...project, environment: 'development', part: 1, records, draftId: first.draftId });
  const moved = staged.get(first.draftId)!.parts.get(1)!;
  staged.get(first.draftId)!.parts.set(2, moved);
  staged.get(first.draftId)!.parts.delete(1);
  await assert.rejects(publisher.publish(draft({ records: undefined, draftId: first.draftId })), (error: PublishError) => error.status === 410,
    'A sealed part only opens under its own draft and part number.');
});

test('one call carries at most PART_RECORDS records and points the AI to staging', () => {
  const many = Array.from({ length: PART_RECORDS + 1 }, (_, index) => ({ ...records[1]!, key: records[1]!.key + '-' + index }));
  assert.throws(() => draft({ records: many }), /stage_documentation/);
});

test('a partial draft is checked merged into the published release, and the published release can be read whole', async () => {
  const { publisher } = setup('owner');
  const first = await publisher.publish(draft());
  assert.equal(first.published, true);
  const changed = { ...records[1]!, title: records[1]!.title + ' (updated)' };
  const staged = await publisher.stage({ ...project, environment: 'development', part: 1, records: [changed] });
  const draftOnly = await publisher.draftRecords({ ...project, environment: 'development', draftId: staged.draftId });
  assert.equal(draftOnly.length, 1, 'Without merging only the staged article is checked.');
  const merged = await publisher.draftRecords({ ...project, environment: 'development', draftId: staged.draftId }, true);
  assert.equal(merged.length, records.length, 'Merged: every published article plus the change.');
  assert.equal(merged.map(record => record as { key: string; title?: string }).find(record => record.key === changed.key)!.title, changed.title);
  const published = await publisher.publishedRecords({ ...project, environment: 'development' });
  assert.equal(published.length, records.length);
});

test('a new version without its release note cannot advance the published head', async () => {
  const {publisher} = setup('owner');
  const first = await publisher.publish(draft());
  await assert.rejects(publisher.publish(draft({expected: first.releaseId, records: [{...records[1]!, title: 'Updated membership'}], version: '2.0.0'})), /RELEASE_NOTES_MISSING/);
  assert.equal((await publisher.status({...project, environment: 'development'})).environments[0]!.expected, first.releaseId);
});

test('partial publication checks backlinks from unchanged published pages', async () => {
  const {publisher} = setup('owner');
  const first = await publisher.publish(draft());
  const guide = structuredClone(records.find(record => record.key.startsWith('guides/'))!);
  const blocks = guide.data.blocks as {type: string; items?: {title: string; href: string; text?: string}[]}[];
  for (const block of blocks) if (block.type === 'cards') block.items = [{title: 'Unauthorized', href: '#/errors/unauthorized', text: 'Read the authentication failure and its recovery steps.'}];
  await assert.rejects(publisher.publish(draft({expected: first.releaseId, records: [guide]})), /RELATED_BACKLINK_MISSING/);
  assert.equal((await publisher.status({...project, environment: 'development'})).environments[0]!.expected, first.releaseId);
});
