import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { designStructure, discoveryPlan, purposes, searchDiscovery, validateChangePlan } from '../src/authoring.js';
import { sha256, validateRecords, type WireRecord } from '../src/validation.js';
import { audienceGuide, readers, resolveReaders, workflowPlan } from '../src/workflows.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const discovery = require(resolve(root, 'vendor/documentation-discovery.js'));
const readJSON = (path: string): any => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const releaseId = '0f8a3c1e-2b4d-4e6f-8a9b-0c1d2e3f4a5b';

/** A v2 snapshot large enough for several discovery shards (40 entries per shard). */
function bigSnapshot(count: number): WireRecord[] {
  const [foundation, template] = readJSON('contract/examples/v2-catalog.json') as WireRecord[];
  const records: WireRecord[] = [clone(foundation!)];
  const nav = (records[0]!.data.navigation as { entries: unknown[] });
  nav.entries = [];
  for (let index = 0; index < count; index++) {
    const id = 'item-' + index;
    const article = clone(template!);
    article.key = article.page + '/' + id;
    article.title = index === 7 ? 'Password reset flow' : 'Catalog item ' + index;
    article.data = { ...article.data, id, order: index, value: { ...(article.data.value as object), name: 'Item ' + index } };
    records.push(article);
    nav.entries.push({ id, tab: article.page, group: 'main', key: article.key, label: article.title, href: '#/' + article.key, order: index, visible: true, searchable: true });
  }
  return records;
}

async function indexed(records: WireRecord[]) {
  const report = validateRecords(records, { complete: true });
  assert.equal(report.ok, true, report.errors.join('; '));
  const manifest = report.manifest!;
  const built = await discovery.build(records, manifest, sha256);
  return { manifest, built, shards: built.shards.map((shard: { id: string; data: unknown }) => ({ id: shard.id, data: shard.data })) };
}

test('structure design returns valid v2 starters for every purpose and audience', () => {
  for (const purpose of purposes) {
    for (const audience of ['end-users', 'developers'] as const) {
      const design = designStructure({ appName: 'Acme', audience, purposes: [purpose] });
      assert.equal(design.publicationFormat, 3);
      assert.equal(design.format, 2, 'V3 retains the compatible content schema, not a renamed schema.');
      const report = validateRecords(design.starter, { complete: true });
      assert.equal(report.ok, true, purpose + ': ' + report.errors.join('; '));
      assert.equal(report.format, 2);
      assert.ok(design.sections.length >= 1);
    }
  }
  const combined = designStructure({ appName: 'Acme', audience: 'mixed', purposes: [...purposes], sections: ['glossary', 'unknown-section'] });
  assert.equal(new Set(combined.sections.map(section => section.id)).size, combined.sections.length, 'Sections are not duplicated');
  assert.ok(!combined.sections.some(section => section.id === 'unknown-section'), 'Only known templates are proposed');
  assert.ok(combined.sections.some(section => section.id === 'test-scenarios'));
  const icons = combined.starter[0]!.data.icons as Record<string, string>;
  assert.ok(Object.values(icons).every(url => url.startsWith('https://api.iconify.design/lucide/')));
  assert.deepEqual(designStructure({ appName: 'A', audience: 'developers', purposes: ['api-reference'] }).recommendedBlocks.includes('code'), true);
  assert.equal(designStructure({ appName: 'A', audience: 'end-users', purposes: ['product-guide'] }).recommendedBlocks.includes('code'), false);
});

test('each reader gets the topics and article parts they need', () => {
  const headings = (audiences: Parameters<typeof designStructure>[0]['audiences'], section = 'features') =>
    designStructure({ appName: 'Acme', audiences, purposes: ['product-guide'] }).articleOutlines[section]!.map(part => part.heading);
  const sections = (audiences: Parameters<typeof designStructure>[0]['audiences']) =>
    designStructure({ appName: 'Acme', audiences, purposes: ['product-guide'] }).sections.map(section => section.id);
  // Every single reader produces a valid starter.
  for (const reader of readers) {
    const design = designStructure({ appName: 'Acme', audiences: [reader], purposes: ['product-guide'] });
    assert.equal(validateRecords(design.starter, { complete: true }).ok, true, reader);
    assert.deepEqual(design.readers.map(item => item.id), [reader]);
    assert.equal('combining' in design.audienceGuide, false, 'One reader needs no combining rules');
  }

  const testers = headings(['testers']);
  for (const part of ['Test scenarios', 'Regression checks', 'Acceptance criteria', 'Technical details']) assert.ok(testers.includes(part), 'testers: ' + part);
  assert.ok(!testers.includes('Why it matters') && !testers.includes('Customer questions for support'));
  assert.ok(sections(['testers']).includes('test-scenarios') && sections(['testers']).includes('release-notes'));

  const owners = headings(['product-owners']);
  for (const part of ['Why it matters', 'Acceptance criteria', 'Current limitations']) assert.ok(owners.includes(part), 'product owners: ' + part);
  assert.ok(!owners.includes('Test scenarios') && !owners.includes('Technical details'), 'Product owners get no test tables or code internals');
  assert.ok(sections(['product-owners']).includes('release-notes'));

  const endUsers = headings(['end-users']);
  assert.ok(!endUsers.some(part => /Technical details|Test scenarios|How it works|Acceptance criteria/.test(part)), 'End users get no technical or QA parts');
  assert.ok(!headings(['end-users'], 'guides').includes('Example'), 'End-user guides carry no code examples');
  assert.ok(sections(['end-users']).includes('guides') && sections(['end-users']).includes('faq'));

  const support = headings(['support']);
  assert.ok(support.includes('Customer questions for support') && support.includes('Current limitations'));
  assert.ok(headings(['end-users']).includes('Frequently asked questions') && !headings(['end-users']).includes('Customer questions for support'),
    'End users get a plain FAQ per feature; support gets the in-depth version.');
  assert.ok(headings(['support'], 'troubleshooting').includes('When to escalate'));
  assert.ok(!headings(['end-users'], 'troubleshooting').includes('When to escalate'));

  // Several readers: a shared outline whose reader-specific parts carry audiences, never heading suffixes.
  const design = designStructure({ appName: 'Acme', audiences: ['testers', 'product-owners'], purposes: ['product-guide'] });
  const parts = design.articleOutlines.features!;
  assert.equal(parts.find(part => part.heading === 'Acceptance criteria')!.audiences, undefined, 'A part every selected reader needs is for everyone');
  assert.deepEqual(parts.find(part => part.heading === 'Test scenarios')!.audiences, ['testers']);
  assert.deepEqual(parts.find(part => part.heading === 'Why it matters')!.audiences, ['product-owners']);
  assert.ok(!parts.some(part => /\(for /.test(part.heading)));
  const feature = design.starter.find(record => record.key.startsWith('features/'))!;
  const limited = (feature.data.blocks as { type: string; text?: string; audiences?: string[] }[]).filter(block => block.audiences);
  assert.ok(limited.some(block => block.type === 'heading' && block.text === 'Test scenarios' && block.audiences!.join() === 'testers'), 'Starter blocks carry the audiences');
  const tabs = (design.starter[0]!.data.navigation as { tabs: { id: string; audiences?: string[] }[] }).tabs;
  assert.equal(tabs.find(tab => tab.id === 'test-scenarios')!.audiences, undefined, 'Both selected readers use test scenarios, so the section is for everyone');
  const supportAndTesters = designStructure({ appName: 'Acme', audiences: ['support', 'testers'], purposes: ['product-guide', 'test-handbook'] });
  assert.deepEqual((supportAndTesters.starter[0]!.data.navigation as { tabs: { id: string; audiences?: string[] }[] }).tabs.find(tab => tab.id === 'test-scenarios')!.audiences, ['testers'],
    'Support never sees the test scenarios section');
  assert.ok(designStructure({ appName: 'Acme', audiences: ['testers', 'product-owners'], purposes: ['product-guide'] }).audienceGuide.combining!.length > 0);

  // "everyone", the older "mixed" and the older single `audience` all still work.
  assert.deepEqual(resolveReaders(['everyone']), [...readers]);
  assert.deepEqual(resolveReaders(['mixed']), [...readers]);
  assert.deepEqual(headings(['everyone']), headings(['mixed']));
  assert.deepEqual(designStructure({ appName: 'Acme', audience: 'testers', purposes: ['product-guide'] }).readers.map(item => item.id), ['testers']);
  assert.equal(audienceGuide(['everyone']).readers.length, readers.length);
});

test('workflow questions offer every reader and tailor guidance once readers are chosen', () => {
  const question = workflowPlan('new-project').missingQuestions.find(item => item.id === 'audience')!.question;
  for (const reader of ['Everyone', 'end users', 'support team', 'Testers', 'Product owners', 'Administrators', 'Developers']) assert.match(question, new RegExp(reader, 'i'));
  assert.match(question, /one or more/);
  type AudiencePlan = { audienceGuidance?: Record<string, string>; audienceGuide?: ReturnType<typeof audienceGuide> };
  const general = workflowPlan('new-project') as AudiencePlan;
  assert.ok(general.audienceGuidance!.testers && general.audienceGuidance!['product-owners'] && general.audienceGuidance!.everyone);
  const tailored = workflowPlan('new-project', {}, { audiences: ['support', 'testers'] }) as AudiencePlan;
  assert.deepEqual(tailored.audienceGuide!.readers.map(item => item.id), ['support', 'testers']);
  assert.ok(tailored.audienceGuide!.combining);
  assert.equal('audienceGuidance' in tailored, false);
});

test('discovery plan matches the website indexer identity and paths', async () => {
  const { manifest, built } = await indexed(bigSnapshot(5));
  const plan = await discoveryPlan(manifest);
  assert.equal(plan.root, built.path);
  assert.equal(plan.manifestHash, built.root.manifestHash);
  await assert.rejects(discoveryPlan({ 'catalog2/x': 'nothex' }), /Invalid documentation/);
});

test('discovery search verifies shards, reports coverage and ranks matches', async () => {
  const { manifest, built, shards } = await indexed(bigSnapshot(90));
  assert.ok(shards.length >= 3, 'fixture spans several shards');
  const full = await searchDiscovery({ manifest, root: built.root, shards, query: 'password reset' });
  assert.equal(full.coverage.complete, true);
  assert.equal(full.results[0]?.title, 'Password reset flow');
  assert.equal(full.results[0]?.revision, manifest[full.results[0]!.key]);

  const partial = await searchDiscovery({ manifest, root: built.root, shards: shards.slice(1), query: 'password reset' });
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.shardsSearched, shards.length - 1);
  assert.match(partial.note, /Partial search/);

  const corrupt = clone(shards);
  corrupt[0].data.payload = corrupt[0].data.payload + ' ';
  await assert.rejects(searchDiscovery({ manifest, root: built.root, shards: corrupt.slice(0, 1), query: 'item' }), /corrupt shard/);
  await assert.rejects(searchDiscovery({ manifest, root: built.root, shards: [{ id: '9999', data: shards[0].data }], query: 'item' }), /not listed/);
  await assert.rejects(searchDiscovery({ manifest, root: built.root, shards: [shards[0], shards[0]], query: 'item' }), /duplicate shard/);
  const otherManifest = { ...manifest, foundation: 'a'.repeat(64) };
  await assert.rejects(searchDiscovery({ manifest: otherManifest, root: built.root, shards, query: 'item' }), /Invalid documentation discovery/,
    'A root for a different manifest must be rejected.');
});

test('change plans follow the CLI format, guards and metadata rules', () => {
  const starter = designStructure({ appName: 'Acme', audience: 'end-users', purposes: ['product-guide'] }).starter;
  const absent = Object.fromEntries(starter.map(record => [record.key, 'absent']));
  const initial = { environment: 'development', expected: 'empty', version: '1.0.0', tags: ['New'], summary: 'Initial documentation.',
    expectedRevisions: absent, records: starter };
  const ok = validateChangePlan(initial);
  assert.equal(ok.ok, true, ok.issues.join('; '));
  assert.deepEqual(ok.stats, { new: starter.length, changed: 0, removed: 0 });
  assert.equal(ok.format, 2);

  const check = (mutate: (plan: any) => void, pattern: RegExp) => {
    const plan: any = clone(initial);
    mutate(plan);
    const result = validateChangePlan(plan);
    assert.equal(result.ok, false);
    assert.match(result.issues.join(' | '), pattern);
  };
  check(plan => { plan.tags = ['Feature']; }, /Hotfix, New and\/or Changed/);
  check(plan => { plan.version = ''; }, /target version/);
  check(plan => { delete plan.expectedRevisions[starter[1]!.key]; }, /expectedRevisions is missing/);
  check(plan => { plan.expectedRevisions.foundation = 'b'.repeat(64); }, /Initial publication requires "absent"/);
  check(plan => { plan.records = plan.records.slice(1); }, /foundation/);
  check(plan => { plan.areaChanges = { 'nope/x': { tags: ['New'], summary: 'x' } }; }, /areaChanges may refer only/);
  check(plan => { plan.extra = true; }, /Apply plan shape/);

  const existing = Object.fromEntries(validateRecords(starter, { complete: true }).revisions.map(item => [item.key, item.revision]));
  const article = clone(starter[1]!);
  (article.data.value as Record<string, unknown>).summary = 'Updated';
  const update = { environment: 'development', expected: releaseId, version: '1.1.0', tags: ['Changed'], summary: 'Updated summary.',
    expectedRevisions: { [article.key]: existing[article.key]! }, records: [article] };
  const updated = validateChangePlan(update, existing, 2);
  assert.equal(updated.ok, true, updated.issues.join('; '));
  assert.deepEqual(updated.stats, { new: 0, changed: 1, removed: 0 });
  const stale = validateChangePlan({ ...update, expectedRevisions: { [article.key]: 'c'.repeat(64) } }, existing, 2);
  assert.match(stale.issues.join(' '), /Revision conflict/);

  const removeKey = starter[2]!.key;
  const removal = validateChangePlan({ ...update, records: [starter[0]!], expectedRevisions: { foundation: existing.foundation, [removeKey]: existing[removeKey] }, remove: [removeKey] }, existing, 2);
  assert.match(removal.issues.join(' '), /from foundation navigation/, 'Removed articles must leave navigation in the same plan');
  assert.match(validateChangePlan({ ...update, remove: ['foundation'], expectedRevisions: { ...update.expectedRevisions, foundation: existing.foundation } }).issues.join(' '), /never foundation/);

  const legacy = readJSON('contract/examples/complete.json') as WireRecord[];
  const legacyArticle = legacy.find(record => record.key !== 'foundation')!;
  const formatChange = validateChangePlan({ ...update, records: [legacyArticle], expectedRevisions: { [legacyArticle.key]: 'absent' } }, existing, 2);
  assert.match(formatChange.issues.join(' '), /format change must replace or remove every existing record/);
});

test('promotion plans allow only forward full-snapshot promotions', () => {
  const plan = { environment: 'beta', source: 'development', expectedSource: releaseId, expected: 'empty', version: '1.0.0', tags: ['New'], summary: 'Promote.' };
  assert.equal(validateChangePlan(plan).ok, true);
  assert.equal(validateChangePlan(plan).operation, 'promote');
  assert.match(validateChangePlan({ ...plan, environment: 'development', source: 'production' }).issues.join(' '), /Only Development/);
  assert.match(validateChangePlan({ ...plan, selected: ['features/x'] }).issues.join(' '), /Promotion plan shape/);
});
