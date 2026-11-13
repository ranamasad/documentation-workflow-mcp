import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutlineConformance } from '../src/outline-conformance.js';
import { qualityReport } from '../src/quality.js';
import { reviewedCatalog } from './reviewed-catalog.js';

type Block = Record<string, unknown> & { type?: string; text?: string; title?: string };
type Rec = { key: string; page?: string; data: Record<string, unknown> & { blocks?: Block[]; value?: Record<string, unknown> } };
const catalog = (readers?: Parameters<typeof reviewedCatalog>[0]) => structuredClone(reviewedCatalog(readers)) as unknown as Rec[];
const check = (records: Rec[]) => checkOutlineConformance(records as never, records[0] as never);
const codes = (records: Rec[]) => check(records).map(issue => issue.key + ' ' + issue.code);
const feature = (records: Rec[]) => records.find(record => record.key.startsWith('features/'))!;
const headingIndex = (record: Rec, text: string) => record.data.blocks!.findIndex(block => block.type === 'heading' && block.text === text);

test('documentation written to the prescribed outline has no outline issues', () => {
  assert.deepEqual(codes(catalog()), []);
  assert.deepEqual(codes(catalog(['end-users', 'support', 'developers'])), []);
});

test('a renamed part is reported as missing and extra, with the expected outline to rewrite to', () => {
  const records = catalog();
  feature(records).data.blocks![headingIndex(feature(records), 'Step by step')]!.text = 'How to use it';
  const issues = check(records);
  assert.ok(issues.some(issue => issue.code === 'OUTLINE_MISSING_PART' && /Step by step/.test(issue.message)));
  assert.ok(issues.some(issue => issue.code === 'OUTLINE_EXTRA_PART' && /How to use it/.test(issue.message)));
  assert.ok(issues.some(issue => issue.code === 'OUTLINE_EXPECTED' && /Overview \(paragraph\) → Linked features/.test(issue.message)));
  const quality = qualityReport(records, undefined, undefined, { requireAudienceCoverage: true, complete: true });
  assert.equal(quality.ok, false, 'Outline issues block publication.');
  assert.ok(quality.guidance.some(line => /send the complete documentation again/.test(line)));
});

test('parts must keep their order, first block type and table columns', () => {
  const records = catalog();
  const article = feature(records);
  const blocks = article.data.blocks!;
  const steps = headingIndex(article, 'Step by step');
  blocks[steps + 1] = { ...blocks[steps + 1], ordered: false };
  const rules = headingIndex(article, 'Business rules');
  (blocks[rules + 1] as { columns: { label: string }[] }).columns[0]!.label = 'Rule';
  assert.ok(codes(records).includes(article.key + ' OUTLINE_BLOCK_TYPE'));
  assert.ok(codes(records).includes(article.key + ' OUTLINE_COLUMNS'));

  const reordered = catalog();
  const moved = feature(reordered).data.blocks!;
  const from = headingIndex(feature(reordered), 'Related');
  moved.splice(1, 0, ...moved.splice(from, 2));
  assert.ok(codes(reordered).includes(feature(reordered).key + ' OUTLINE_ORDER'));
});

test('a part that does not apply keeps its heading and says why', () => {
  const records = catalog();
  const article = feature(records);
  const limits = headingIndex(article, 'Settings and limits');
  article.data.blocks![limits + 1] = { id: 'na', type: 'callout', tone: 'info', text: 'Not applicable: this feature has no settings, quotas or limits in the code.' };
  assert.deepEqual(codes(records), []);
  article.data.blocks!.splice(limits, 2);
  assert.ok(codes(records).includes(article.key + ' OUTLINE_MISSING_PART'));
});

test('tabs groups and reader restrictions are enforced', () => {
  const records = catalog(['end-users', 'support']);
  const article = feature(records);
  const why = headingIndex(article, 'Customer questions for support');
  delete article.data.blocks![why]!.audiences;
  delete article.data.blocks![headingIndex(article, 'Overview')]!.group;
  const issues = codes(records);
  assert.ok(issues.includes(article.key + ' OUTLINE_AUDIENCES'));
  assert.ok(issues.includes(article.key + ' OUTLINE_GROUP'));
});

test('sections, their fields and tab visibility cannot be changed', () => {
  const records = catalog(['end-users', 'support', 'developers']);
  const foundation = records[0]!.data as { sections: { id: string; fields: unknown[] }[]; navigation: { tabs: { id: string; audiences?: string[] }[] } };
  foundation.sections.push({ ...foundation.sections[0]!, id: 'custom', fields: [] });
  foundation.sections[0]!.fields = foundation.sections[0]!.fields.slice(1);
  delete foundation.navigation.tabs.find(tab => tab.id === 'api')!.audiences;
  feature(records).data.value = { ...feature(records).data.value, owner: 'Team' };
  const issues = codes(records);
  for (const code of ['foundation OUTLINE_UNKNOWN_SECTION', 'foundation OUTLINE_SECTION_CHANGED', 'foundation OUTLINE_TAB_AUDIENCE', feature(records).key + ' OUTLINE_FIELDS']) {
    assert.ok(issues.includes(code), code);
  }
});

test('FAQ articles need real questions and only one summary may precede the first part', () => {
  const records = catalog();
  const faq = records.find(record => record.key.startsWith('faq/'))!;
  faq.data.blocks = faq.data.blocks!.filter(block => block.type !== 'details');
  faq.data.blocks.splice(1, 0, { id: 'x', type: 'paragraph', text: 'Another loose paragraph before the first part.' });
  const issues = codes(records);
  assert.ok(issues.includes(faq.key + ' OUTLINE_QUESTIONS'));
  assert.ok(issues.includes(faq.key + ' OUTLINE_LOOSE_BLOCK'));
});
