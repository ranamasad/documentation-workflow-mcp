import test from 'node:test';
import assert from 'node:assert/strict';
import { designStructure } from '../src/authoring.js';
import { qualityReport } from '../src/quality.js';

const codes = (records: unknown[]) => qualityReport(records).issues.map(issue => issue.key + ' ' + issue.code);

test('the starter outlines every article with headings and structured blocks, without duplicate navigation', () => {
  const design = designStructure({ appName: 'Acme', audience: 'mixed', purposes: ['product-guide', 'test-handbook'] });
  const foundation = design.starter[0]!.data as { navigation: { groups: unknown[]; entries: { group: string }[] } };
  assert.deepEqual(foundation.navigation.groups, [], 'Entries sit directly under their section.');
  assert.ok(foundation.navigation.entries.every(entry => entry.group === ''));
  const feature = design.starter.find(record => record.key.startsWith('features/'))!;
  const blocks = feature.data.blocks as { type: string; text?: string }[];
  assert.deepEqual(blocks.filter(block => block.type === 'heading').map(block => block.text),
    ['Overview', 'Linked features', 'Why it matters', 'Who can use it', 'How it works', 'Step by step', 'Settings and limits', 'Business rules',
      'Frequently asked questions', 'Customer questions for support', 'Current limitations', 'Errors and edge cases', 'Check these first',
      'What happens in each scenario', 'Risks', 'Known issues', 'Acceptance criteria', 'Test scenarios', 'Regression checks',
      'Applications and services involved', 'External systems used', 'Endpoints used', 'Data and JSON', 'Database tables and objects',
      'Events and background jobs', 'Related']);
  const groups = (feature.data.blocks as { type: string; level?: number; group?: string }[]).filter(block => block.type === 'heading' && block.level === 2).map(block => block.group);
  assert.deepEqual([...new Set(groups)], ['Overview', 'How to use', 'Questions', 'Problems', 'Testing', 'Technical'], 'Every feature part sits in one of the article tabs');
  assert.ok(design.sections.some(section => section.id === 'external-systems'), 'Features get an External systems section');
  assert.deepEqual(design.articleOutlines['external-systems']!.slice(0, 4).map(part => part.heading), ['Overview', 'Features that use it', 'How to check it is working', 'When it fails']);
  assert.ok(design.sections.some(section => section.id === 'api'), 'Features list their endpoints, so the API reference is included.');
  assert.ok(design.articleOutlines.api!.some(part => part.heading === 'Response fields') && design.articleOutlines.api!.some(part => part.heading === 'Used by'));
  assert.ok(design.writingRules.some(rule => /Never write numbered steps inside a paragraph/.test(rule)));
  assert.ok(design.articleOutlines.features!.some(part => part.heading.startsWith('Test scenarios') && part.columns?.includes('Expected result')));
  assert.ok(codes(design.starter).some(code => code === feature.key + ' PLACEHOLDER'), 'Unreplaced starter prompts can never be published.');
});

test('quality checks catch shallow, unformatted documentation', () => {
  const foundation = { key: 'foundation', data: { icons: { book: 'https://api.iconify.design/lucide/book.svg' },
    sections: [{ id: 'guides', fields: [{ key: 'goal', label: 'Goal' }, { key: 'duration', label: 'Time needed' }] }],
    navigation: { tabs: [{ id: 'guides', label: 'How-to guides', icon: 'book' }], groups: [{ id: 'g', tab: 'guides', label: 'How-to guides', icon: 'book-open' }] } } };
  const article = { key: 'guides/first', data: { value: { goal: 'Publish the first release' }, blocks: [
    { id: 'p', type: 'paragraph', text: 'Evidence: documentation-mcp README.md and src/publish.ts. 1. Start a workflow. 2. Confirm the project. 3. Publish.' }] } };
  const found = codes([foundation, article]);
  for (const code of ['foundation UNKNOWN_ICON', 'foundation DUPLICATE_NAVIGATION', 'guides/first EVIDENCE_IN_CONTENT', 'guides/first TOO_THIN',
    'guides/first NO_HEADINGS', 'guides/first PLAIN_TEXT_ONLY', 'guides/first INLINE_STEPS', 'guides/first EMPTY_FIELDS']) {
    assert.ok(found.includes(code), 'Expected ' + code + ' in ' + found.join(', '));
  }
  assert.match(qualityReport([foundation, article]).issues.find(issue => issue.code === 'EMPTY_FIELDS')!.message, /Time needed/);
});

test('FAQ articles are expandable questions with real answers', () => {
  const design = designStructure({ appName: 'Acme', audience: 'support', purposes: ['support-handbook'] });
  const faq = design.starter.find(record => record.key.startsWith('faq/'))!;
  const questions = (faq.data.blocks as { type: string; title?: string; blocks?: { type: string }[] }[]).filter(block => block.type === 'details');
  assert.equal(questions.length, 3);
  assert.ok(questions.every(block => block.title!.endsWith('?') && block.blocks!.some(inner => inner.type === 'callout')), 'Each answer says how it helps the reader.');

  const answer = 'Open Settings, choose Members and select Invite. Enter their work email and pick a role; they get an email and can sign in right away, so your team reaches the documentation without waiting for support. If the invite does not arrive, check the spam folder or send it again from the same page.';
  const good = { key: 'faq/access', data: { value: {}, blocks: ['Who can sign in?', 'How do I invite a colleague?', 'Why do I see Access denied?'].map((title, index) =>
    ({ id: 'q' + index, type: 'details', title, blocks: [{ id: 'a' + index, type: 'paragraph', text: title + ' ' + answer }] })) } };
  assert.deepEqual(codes([good]), []);
  const plain = { key: 'faq/plain', data: { value: {}, blocks: [{ id: 'q', type: 'paragraph', text: 'Can I edit articles inside the website?' }, { id: 'a', type: 'paragraph', text: 'No.' }] } };
  const found = codes([plain]);
  assert.ok(found.includes('faq/plain FAQ_FORMAT') && found.includes('faq/plain FAQ_PLAIN_QUESTION'), found.join(', '));
  const short = { key: 'faq/short', data: { value: {}, blocks: ['A?', 'B?', 'C?'].map((title, index) => ({ id: 'q' + index, type: 'details', title, blocks: [{ id: 'a' + index, type: 'paragraph', text: 'No.' }] })) } };
  assert.ok(codes([short]).includes('faq/short FAQ_THIN_ANSWER'));
});

test('links to articles that do not exist are reported, against the draft, its navigation and the published release', () => {
  const foundation = { key: 'foundation', data: { sections: [{ id: 'features' }, { id: 'api' }],
    navigation: { tabs: [], groups: [], entries: [{ key: 'features/checkout' }, { key: 'api/create-order' }] } } };
  const feature = { key: 'features/checkout', data: { value: {}, blocks: [
    { id: 'e', type: 'cards', items: [{ title: 'POST /orders', href: '#/api/create-order' }, { title: 'GET /orders', href: '#/api/list-orders' }] },
    { id: 'l', type: 'link', label: 'Refunds', href: '#/features/refunds' },
    { id: 'p', type: 'paragraph', text: 'See #/api for every endpoint and #/billing for invoices.' }] } };
  const broken = qualityReport([foundation, feature]).issues.find(issue => issue.code === 'BROKEN_LINK')!;
  assert.match(broken.message, /#\/api\/list-orders, #\/features\/refunds, #\/billing\./);
  assert.doesNotMatch(broken.message, /create-order|#\/api[,.]/, 'Listed articles and declared sections resolve.');

  assert.ok(!codes([feature]).some(code => code.endsWith('BROKEN_LINK')), 'A batch without the foundation cannot judge links.');
  const kept = qualityReport([feature], undefined, ['features/checkout', 'api/create-order', 'api/list-orders', 'features/refunds', 'billing/invoices']);
  assert.ok(!kept.issues.some(issue => issue.code === 'BROKEN_LINK'), 'Articles kept from the published release resolve.');
});

test('technical facts written as a paragraph are reported; the same facts in a table are not', () => {
  const prose = { key: 'features/reset', data: { value: {}, blocks: [{ id: 't', type: 'details', title: 'Technical details', blocks: [{ id: 'p', type: 'paragraph',
    text: 'The sign-in page calls POST /v1/password-resets with the email and stores a token in the password_resets table.' }] }] } };
  assert.ok(codes([prose]).includes('features/reset TECHNICAL_PROSE'));
  const tabled = { key: 'features/reset', data: { value: {}, blocks: [{ id: 't', type: 'table', columns: [{ key: 'e', label: 'Endpoint' }, { key: 'w', label: 'What happens' }],
    rows: [{ e: 'POST /v1/password-resets', w: 'Stores a token in password_resets' }] }, { id: 'p', type: 'paragraph', text: 'Members reset a forgotten password from the sign-in page.' }] } };
  assert.ok(!codes([tabled]).includes('features/reset TECHNICAL_PROSE'));
  const design = designStructure({ appName: 'Acme', audiences: ['developers'], purposes: ['product-guide'] });
  const feature = design.starter.find(record => record.key.startsWith('features/'))!;
  const technical = (feature.data.blocks as { type: string; title?: string; blocks?: { type: string }[] }[]).find(block => block.title === 'Technical details')!;
  assert.equal(technical.blocks![0]!.type, 'table', 'Starter technical details are a table to fill, not a paragraph.');
});

test('padding is rejected: a list repeated under another heading, and one sentence reused across many articles', () => {
  const steps = ['Open Settings and choose Members.', 'Select Invite and enter the work email.', 'Pick a role and send the invite.'];
  const copied = { key: 'guides/invite', title: 'Invite a member', data: { value: {}, blocks: [
    { id: 'p0', type: 'list', items: steps }, { id: 'p1', type: 'list', ordered: true, items: steps }] } };
  assert.ok(codes([copied]).includes('guides/invite DUPLICATE_CONTENT'));
  const filler = 'Verify the actual final local, peer, API and downstream states that apply before closing the task.';
  const many = Array.from({ length: 8 }, (_, index) => ({ key: 'guides/task-' + index, title: 'Task ' + index, data: { value: {}, blocks: [
    { id: 'p0', type: 'list', items: ['Step for task ' + index + ' only, written from its own code path.', filler] }] } }));
  assert.equal(codes(many).filter(code => code.endsWith('BOILERPLATE')).length, 8);
  assert.equal(codes(many.slice(0, 7)).filter(code => code.endsWith('BOILERPLATE')).length, 0, 'Seven repeats are allowed.');
  const shared = Array.from({ length: 8 }, (_, index) => ({ key: 'api/endpoint-' + index, title: 'Endpoint ' + index, data: { value: {}, blocks: [
    { id: 'tech', type: 'details', title: 'Technical details', blocks: [{ id: 'src', type: 'paragraph', text: 'Handled in IFMBackend/src/modules/crew-service/crew-services.controller.ts by the shared crew services controller class.' }] }] } }));
  assert.equal(codes(shared).filter(code => code.endsWith('BOILERPLATE')).length, 0, 'Shared source references are not filler.');
});

test('related articles and file mapping come from links, endpoints, messages and cited source files', async () => {
  const { relatedArticles, pagesForFiles } = await import('../src/doc-graph.js');
  const tech = (path: string) => ({ id: 't', type: 'details', title: 'Technical details', blocks: [{ id: 'x', type: 'paragraph', text: 'Handled in ' + path + ' for this page.' }] });
  const records = [
    { key: 'features/orders', title: 'Orders', data: { blocks: [{ id: 'p', type: 'paragraph', text: 'Calls POST /v1/orders and shows "Order could not be saved".' }, tech('Backend/src/orders/orders.controller.ts')] } },
    { key: 'api/post-orders', title: 'POST /v1/orders', data: { blocks: [{ id: 'c', type: 'cards', items: [{ title: 'Orders', href: '#/features/orders' }] },
      { id: 'p', type: 'paragraph', text: 'POST /v1/orders saves an order.' }, tech('Backend/src/orders/orders.controller.ts')] } },
    { key: 'errors/order-not-saved', title: 'Order not saved', data: { blocks: [{ id: 'p', type: 'paragraph', text: 'The app shows "Order could not be saved" when saving fails.' }] } }
  ];
  const related = relatedArticles(records, 'features/orders')!;
  assert.deepEqual(related.linkedFrom.map(item => item.key), ['api/post-orders']);
  assert.deepEqual(related.sameEndpoints.map(item => item.key), ['api/post-orders']);
  assert.deepEqual(related.sameMessages.map(item => item.key), ['errors/order-not-saved']);
  const mapped = pagesForFiles(records, ['src/orders/orders.controller.ts', 'src/unknown.ts']);
  assert.deepEqual(mapped.files[0]!.pages.map(page => page.key), ['features/orders', 'api/post-orders']);
  assert.deepEqual(mapped.notDocumented, ['src/unknown.ts']);
});

test('the effort estimate recommends compact depth for large projects and stays small for updates', async () => {
  const { estimateEffort } = await import('../src/effort.js');
  const large = estimateEffort({ sourceFiles: 3364, sourceLines: 357000, readers: 7 });
  assert.ok(large.compactAlternative && /compact/.test(large.recommendation));
  assert.equal(large.estimate.articles, 561);
  const update = estimateEffort({ sourceFiles: 3364, sourceLines: 357000, readers: 7, changedFiles: 4, changedLines: 300 });
  assert.equal(update.kind, 'update');
  assert.ok(Number(update.estimate.total.replace('M', '')) < 0.3);
});
