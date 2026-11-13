import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designStructure } from '../src/authoring.js';
import { expandFacts, factsTemplate, isFacts } from '../src/facts.js';
import { checkOutlineConformance } from '../src/outline-conformance.js';

const design = designStructure({ appName: 'Example', audiences: ['everyone'], purposes: ['product-guide', 'support-handbook', 'test-handbook', 'api-reference'] });
const foundation = (design.starter as { key: string; data: unknown }[]).find(record => record.key === 'foundation')!;
const sentence = 'Crew open the screen, pick the guest and confirm the change, and the app saves it on the iPad and syncs it later.';

function factsFor(section: string) {
  const facts: Record<string, unknown> = {};
  for (const part of factsTemplate(section, foundation)) {
    const cols = part.columns ?? ['Item', 'Details'];
    const row = cols.map(label => label === 'What the user sees' ? '"Saved"' : label === 'Type' ? 'Success' : sentence);
    facts[part.heading] = {
      paragraph: sentence, list: [sentence, sentence, sentence], steps: [sentence, sentence, sentence],
      table: [row, row, row, row, row, row], cards: [{ title: 'Sign in', text: 'Needs: Sign in', href: '#/features/sign-in' }],
      diagram: 'flowchart LR\n  A["iPad"] --> B["API"]\n  B --> C["Database"]\n  C --> D["Report"]', json: { flight: 'EY0000' }, code: 'curl -X GET /v1/example',
      details: [row], callout: sentence,
      question: Array.from({ length: part.count ?? 1 }, () => ({ q: 'How do I save it?', answer: sentence, steps: [sentence], helps: sentence })),
      'support-question': Array.from({ length: part.count ?? 1 }, () => ({ q: 'Why did it not save?', answer: sentence, checks: [['Network', 'Settings', 'Offline']], fix: [sentence], escalate: sentence }))
    }[part.block];
  }
  return { key: section + '/example', title: 'Example', value: {}, order: 1, summary: sentence, facts };
}

test('a facts record is built into a full record that matches the outline', () => {
  const facts = factsFor('features');
  assert.ok(isFacts(facts));
  const record = expandFacts(facts as never, foundation) as { key: string; page: string; data: { blocks: { type: string; audiences?: string[] }[] } };
  assert.equal(record.page, 'features');
  assert.ok(record.data.blocks.length > 40);
  const issues = checkOutlineConformance([record as never], foundation as never).filter(issue => issue.key === record.key && /^OUTLINE_/.test(issue.code));
  assert.deepEqual(issues.map(issue => issue.code + ': ' + issue.message), []);
  const facts2 = JSON.stringify(facts).length, full = JSON.stringify(record).length;
  assert.ok(facts2 < full * 0.8, 'facts are smaller than the record they build (' + facts2 + ' vs ' + full + ')');
});

test('a part that does not apply becomes a Not applicable callout', () => {
  const facts = factsFor('features');
  facts.facts['Known issues'] = 'Not applicable: the code has no known issues for this feature.';
  const record = expandFacts(facts as never, foundation) as { data: { blocks: { type: string; text?: string }[] } };
  assert.ok(record.data.blocks.some(block => block.type === 'callout' && /^Not applicable/.test(block.text ?? '')));
});
