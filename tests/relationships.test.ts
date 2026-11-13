import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRelationships } from '../src/relationships.js';
import { qualityReport } from '../src/quality.js';

test('existing and newly written guides cannot pass quality without related articles', () => {
  const guide = {key: 'guides/invite-member', data: {blocks: [{type: 'paragraph', text: 'Invite a member from the team screen.'}]}};
  assert.equal(checkRelationships([guide])[0]?.code, 'RELATED_ARTICLES_MISSING');
  assert.ok(qualityReport([guide]).issues.some(issue => issue.code === 'RELATED_ARTICLES_MISSING'));
});

test('links to unchanged articles resolve in partial updates', () => {
  const guide = {key: 'guides/invite-member', data: {blocks: [{type: 'cards', items: [{title: 'Team membership',
    text: 'Membership roles govern which invitations are allowed.', href: '#/features/team-membership'}]}]}};
  assert.deepEqual(checkRelationships([guide], ['features/team-membership']), []);
  assert.equal(checkRelationships([guide], [], true)[0]?.code, 'RELATED_ARTICLES_MISSING');
});

const card = (href: string, audiences?: string[]) => ({type: 'cards', ...(audiences ? {audiences} : {}), items: [
  {title: 'Read more', text: 'Follow this article for the matching membership workflow.', href: '#/' + href}
]});

test('new features and existing architecture/troubleshooting need relevant reader links', () => {
  for (const section of ['features', 'architecture', 'troubleshooting', 'api']) {
    assert.equal(checkRelationships([{key: section + '/membership', data: {blocks: []}}])[0]?.code, 'RELATED_ARTICLES_MISSING');
  }
});

test('source references, navigation, self links and title-only cards do not satisfy relationships', () => {
  const record = {key: 'guides/invite', data: {blocks: [card('guides/invite'), {type: 'details', title: 'Technical details',
    blocks: [card('features/membership')]}, {type: 'cards', items: [{title: 'Membership', text: 'Membership', href: '#/features/membership'}]}]}};
  assert.equal(checkRelationships([record], ['features/membership'])[0]?.code, 'RELATED_ARTICLES_MISSING');
});

test('each reader needs a visible link, respecting parent and target audience restrictions', () => {
  const foundation = {key: 'foundation', data: {audienceCoverage: {readers: ['end-users', 'developers']}, navigation: {tabs: [
    {id: 'guides'}, {id: 'architecture', audiences: ['developers']}
  ]}}};
  const record = {key: 'guides/invite', data: {blocks: [{type: 'details', title: 'Engineering', audiences: ['developers'],
    blocks: [card('architecture/membership')]}]}};
  const target = {key: 'architecture/membership', data: {blocks: [card('guides/invite')]}};
  const found = checkRelationships([foundation, record, target], [], true);
  assert.match(found.find(issue => issue.key === record.key)!.message, /end-users/);
  assert.ok(!found.some(issue => issue.key === target.key), 'A technical-only article needs links only for its actual readers.');
});

test('specific visible non-applicability is accepted but short or hidden excuses fail', () => {
  const exception = {id: 'related-not-applicable', type: 'callout', text: 'Not applicable: This standalone command has no screens, callers or companion procedures in the product.'};
  assert.deepEqual(checkRelationships([{key: 'architecture/standalone', data: {blocks: [exception]}}]), []);
  assert.ok(checkRelationships([{key: 'architecture/standalone', data: {blocks: [{...exception, text: 'Not applicable: none'}]}}])
    .some(issue => issue.code === 'RELATED_EXCEPTION_INVALID'));
  assert.ok(checkRelationships([{key: 'architecture/standalone', data: {blocks: [{...exception, audiences: ['developers']}]}}])
    .some(issue => issue.code === 'RELATED_ARTICLES_MISSING'));
});

test('merged-site validation requires feature backlinks and exceptions cannot waive them', () => {
  const feature = {key: 'features/membership', data: {blocks: [card('guides/invite')]}};
  const guide = {key: 'guides/invite', data: {blocks: [{id: 'related-not-applicable', type: 'callout',
    text: 'Not applicable: This procedure has no companion feature or other articles in this product.'}]}};
  const found = checkRelationships([feature, guide], [], true);
  assert.ok(found.some(issue => issue.key === guide.key && issue.code === 'RELATED_BACKLINK_MISSING'));
  assert.ok(found.some(issue => issue.code === 'RELATED_EXCEPTION_CONFLICT'));
  assert.deepEqual(checkRelationships([feature, {...guide, data: {blocks: [card(feature.key)]}}], [], true), []);
});

test('a guide cannot substitute a glossary link for its available feature relationship', () => {
  const guide = {key: 'guides/invite', data: {blocks: [card('glossary/member')]}};
  const found = checkRelationships([guide], ['features/membership', 'glossary/member']);
  assert.ok(found.some(issue => issue.code === 'RELATED_FEATURE_MISSING'));
});

test('separately supplied foundation and compact starters retain relationship rules', async () => {
  const foundation = {key: 'foundation', data: {audienceCoverage: {readers: ['developers']}}};
  const guide = {key: 'guides/invite', data: {blocks: [card('features/membership', ['developers'])]}};
  const found = qualityReport([guide], foundation, ['features/membership']).issues;
  assert.ok(!found.some(issue => issue.code.startsWith('RELATED_')));
  const {designStructure} = await import('../src/authoring.js');
  const structure = designStructure({appName: 'Example', audiences: ['developers'], purposes: ['internal-architecture', 'product-guide'], depth: 'compact'});
  for (const section of ['guides', 'troubleshooting', 'architecture']) assert.ok(structure.articleOutlines[section]!.some(part => part.heading === 'Related'));
  assert.ok(structure.sections.some(section => section.id === 'release-notes'));
});