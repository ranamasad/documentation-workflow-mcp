import { depthLimits } from '../src/outlines.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceRequirements, checkAudienceCoverage } from '../src/audience-quality.js';
import { designStructure } from '../src/authoring.js';
import type { Reader } from '../src/workflows.js';

const paragraph = 'The authorized member selects an available option, reviews the displayed result and confirms the action only after checking the current configuration. ';
function fixture(role: Reader = 'support') {
  const topics = audienceRequirements[role].topics;
  const articles: { key: string; page: string; title: string; data: { value: Record<string, unknown>; blocks: Record<string, unknown>[] } }[] =
    topics.map(topic => ({ key: topic + '/example', page: topic, title: 'Example',
    data: { value: {}, blocks: topic === 'faq' ? ['Who can use this?', 'What should I check?', 'When should I escalate?'].map((title, index) =>
      ({ id: 'question-' + index, type: 'details', title, blocks: [{ id: 'answer-' + index, type: 'paragraph', text: paragraph.repeat(4) }] })) : [
      { id: 'heading', type: 'heading', level: 2, text: 'Expected behavior' },
      { id: 'body', type: 'paragraph', text: paragraph.repeat(18) },
      { id: 'steps', type: 'list', ordered: true, items: ['Check access before submitting.', 'Verify the resulting record before retrying.'] },
      { id: 'fields', type: 'table', columns: [{ key: 'input', label: 'Precondition' }, { key: 'step', label: 'Step' }, { key: 'result', label: 'Expected result' }],
        rows: [{ input: 'Authorized member', step: 'Confirm the selected option', result: 'The saved result appears once.' }] },
      { id: 'example', type: 'code', language: 'json', code: '{"status":"accepted","id":"synthetic-example"}' }
    ] } }));
  const foundation = { key: 'foundation', data: {
    schemaVersion: 2,
    audienceCoverage: { version: 1, readers: [role], notApplicable: [] as { reader: Reader; topic: string; reason: string; confirmed: boolean }[], sections: {} as Record<string, string[]> },
    sections: topics.map(id => ({ id: String(id), fields: [], visible: true })),
    navigation: { tabs: topics.map(id => ({ id: String(id), visible: true, audiences: [role] as Reader[] })),
      groups: [] as { id: string; tab: string; visible: boolean }[],
      entries: articles.map(article => ({ key: article.key, tab: article.page, group: '', visible: true, searchable: true })) }
  } };
  return { foundation, articles, check: (complete = true) => checkAudienceCoverage(articles, foundation, { required: true, complete }) };
}

test('all seven confirmed audiences have substantial visible coverage', () => {
  for (const role of Object.keys(audienceRequirements) as Reader[]) {
    const f = fixture(role);
    assert.deepEqual(f.check().issues, [], role);
    assert.equal(f.check().summary.topicsChecked, audienceRequirements[role].topics.length);
  }
});

test('new starters persist confirmed readers and include Support API requirements', () => {
  const design = designStructure({ appName: 'Example', audience: 'support', purposes: ['support-handbook'] });
  assert.deepEqual(design.starter[0]!.data.audienceCoverage, { version: 1, readers: ['support'], notApplicable: [] });
  assert.ok(design.sections.some(section => section.id === 'api'));
  for (const role of Object.keys(audienceRequirements) as Reader[]) {
    const starter = designStructure({ appName: 'Example', audiences: [role], purposes: ['product-guide'] }).starter;
    assert.deepEqual(checkAudienceCoverage(starter, starter[0], { required: true, complete: true }).issues
      .filter(issue => issue.code === 'AUDIENCE_TOPIC_MISSING'), [], role);
  }
});

test('missing, duplicate and unknown reader plans fail explicitly', () => {
  assert.equal(checkAudienceCoverage([], undefined, { required: true }).issues[0]!.code, 'AUDIENCE_PLAN_REQUIRED');
  for (const readers of [[], ['support', 'support'], ['owner']]) {
    assert.equal(checkAudienceCoverage([], { key: 'foundation', data: { audienceCoverage: { version: 1, readers } } }).issues[0]!.code, 'INVALID_AUDIENCE_PLAN');
  }
});

test('hidden sections, tabs, groups and entries cannot provide Support API coverage', () => {
  for (const level of ['section', 'tab', 'group', 'entry']) {
    const f = fixture();
    if (level === 'section') f.foundation.data.sections.find(section => section.id === 'api')!.visible = false;
    if (level === 'tab') f.foundation.data.navigation.tabs.find(tab => tab.id === 'api')!.audiences = ['developers'];
    const entry = f.foundation.data.navigation.entries.find(entry => entry.tab === 'api')!;
    if (level === 'entry') entry.visible = false;
    if (level === 'group') {
      entry.group = 'technical';
      f.foundation.data.navigation.groups.push({ id: 'technical', tab: 'api', visible: false });
    }
    assert.ok(f.check().issues.some(issue => issue.reader === 'support' && issue.topic === 'api' && issue.code === 'AUDIENCE_TOPIC_MISSING'), level);
  }
});

test('nested technical content does not supply another reader words, headings or structured depth', () => {
  const f = fixture();
  const article = f.articles[0]!;
  article.data.blocks = [{ id: 'technical', type: 'details', title: 'Engineering only', audiences: ['developers'], blocks: article.data.blocks },
    { id: 'short', type: 'paragraph', text: 'Contact support.' }];
  const issues = f.check().issues.filter(issue => issue.key === article.key).map(issue => issue.code);
  for (const code of ['AUDIENCE_TOO_THIN', 'AUDIENCE_NO_HEADINGS', 'AUDIENCE_PLAIN_TEXT']) assert.ok(issues.includes(code));
});

test('visible non-searchable articles count, and custom API section mappings retain field/example requirements', () => {
  const f = fixture('developers');
  const api = f.articles.find(article => article.page === 'api')!;
  api.page = 'reference';
  api.key = 'reference/example';
  f.foundation.data.sections.find(section => section.id === 'api')!.id = 'reference';
  const entry = f.foundation.data.navigation.entries.find(entry => entry.tab === 'api')!;
  entry.key = api.key;
  entry.tab = 'reference';
  const tab = f.foundation.data.navigation.tabs.find(tab => tab.id === 'api')!;
  tab.id = 'reference';
  f.foundation.data.navigation.entries.forEach(entry => { entry.searchable = false; });
  f.foundation.data.audienceCoverage.sections.api = ['reference'];
  assert.deepEqual(f.check().issues, []);
  api.data.blocks = api.data.blocks.filter(block => block.type !== 'table' && block.type !== 'code');
  const codes = f.check().issues.map(issue => issue.code);
  assert.ok(codes.includes('AUDIENCE_API_FIELDS') && codes.includes('AUDIENCE_API_EXAMPLE'));
});

test('only explicitly approved genuine non-applicability is accepted', () => {
  const f = fixture();
  const exemption = { reader: 'support' as Reader, topic: 'api',
    reason: 'Source inspection confirms this standalone fixture has no API or network request implementation.', confirmed: true };
  f.foundation.data.audienceCoverage.notApplicable.push(exemption);
  assert.ok(f.check().issues.some(issue => issue.code === 'CONTRADICTORY_AUDIENCE_EXEMPTION'));
  f.articles.splice(f.articles.findIndex(article => article.page === 'api'), 1);
  assert.deepEqual(f.check().issues, []);
  exemption.confirmed = false;
  assert.equal(f.check().issues[0]!.code, 'INVALID_AUDIENCE_PLAN');
  exemption.confirmed = true;
  exemption.reason = 'Not needed';
  assert.equal(f.check().issues[0]!.code, 'INVALID_AUDIENCE_PLAN');
});

test('partial batches defer topic completeness, but not the depth of included articles', () => {
  const f = fixture();
  f.articles.splice(1);
  assert.deepEqual(f.check(false).issues, []);
  assert.ok(f.check().issues.some(issue => issue.code === 'AUDIENCE_TOPIC_MISSING'));
  f.articles[0]!.data.blocks = [];
  assert.ok(f.check(false).issues.some(issue => issue.code === 'AUDIENCE_TOO_THIN'));
});

test('word floors use the exact text visible to the reader', () => {
  for (const [page, minimum] of [['features', depthLimits.standard.articleWords], ['faq', 150], ['errors', 80]] as const) {
    const f = fixture();
    const article = f.articles.find(article => article.page === page)!;
    for (const [count, fails] of [[minimum - 2, true], [minimum - 1, false]] as const) {
      article.data.blocks = [{ id: 'body', type: 'paragraph', text: 'word '.repeat(count) }];
      assert.equal(f.check().issues.some(issue => issue.key === article.key && issue.code === 'AUDIENCE_TOO_THIN'), fails,
        page + ' includes its one-word title');
    }
  }
});

test('an empty details container does not count, and hidden FAQ answers cannot satisfy visible depth', () => {
  const f = fixture();
  const article = f.articles[0]!;
  article.data.blocks = article.data.blocks.filter(block => ['heading', 'paragraph', 'list'].includes(String(block.type)));
  article.data.blocks.push({ id: 'empty-details', type: 'details', title: 'Technical detail',
    blocks: [{ id: 'hidden-content', type: 'paragraph', audiences: ['developers'], text: paragraph.repeat(20) }] });
  assert.ok(f.check().issues.some(issue => issue.key === article.key && issue.code === 'AUDIENCE_PLAIN_TEXT'));
  const faq = f.articles.find(article => article.page === 'faq')!;
  faq.data.blocks[0]!.blocks = [{ id: 'hidden-answer', type: 'paragraph', audiences: ['developers'], text: paragraph.repeat(20) }];
  assert.ok(f.check().issues.some(issue => issue.key === faq.key && issue.code === 'AUDIENCE_FAQ_THIN_ANSWER'));
});

test('empty and hidden table fields cannot satisfy API contracts', () => {
  const f = fixture();
  const api = f.articles.find(article => article.page === 'api')!;
  const table = api.data.blocks.find(block => block.type === 'table')!;
  table.rows = [{ unrelated: 'This value is not in any displayed column.' }];
  assert.ok(f.check().issues.some(issue => issue.key === api.key && issue.code === 'AUDIENCE_API_FIELDS'));
  table.rows = [{ input: 'Visible input' }];
  table.columns = [{ key: 'input', label: 'Input', visible: false }, { key: 'missing', label: 'Absent field' }];
  assert.ok(f.check().issues.some(issue => issue.key === api.key && issue.code === 'AUDIENCE_API_FIELDS'));
});

test('unknown section aliases and contradictory or duplicate exemptions fail explicitly', () => {
  const f = fixture();
  f.foundation.data.audienceCoverage.sections.api = ['misspelled-section'];
  assert.ok(f.check().issues.some(issue => issue.code === 'INVALID_AUDIENCE_SECTION'));
  const exemption = { reader: 'support' as Reader, topic: 'api',
    reason: 'TODO: document a verified reason instead of using this temporary filler explanation.', confirmed: true };
  f.foundation.data.audienceCoverage.notApplicable.push(exemption, exemption);
  assert.ok(f.check().issues.some(issue => issue.code === 'INVALID_AUDIENCE_EXEMPTION'));
});
