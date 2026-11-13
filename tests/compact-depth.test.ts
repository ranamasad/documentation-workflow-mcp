import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineFor, depthOf } from '../src/outlines.js';
import { designStructure } from '../src/authoring.js';

const everyone = ['end-users', 'support', 'testers', 'product-owners', 'administrators', 'developers', 'internal'] as const;
const skipped = ['What happens in each scenario', 'Risks', 'Regression checks', 'Applications and services involved', 'Events and background jobs'];

test('compact feature outlines drop the detail parts and ask fewer questions', () => {
  const standard = outlineFor('features', [...everyone]);
  const compact = outlineFor('features', [...everyone], 'compact');
  for (const heading of skipped) {
    assert.ok(standard.some(part => part.heading === heading), heading + ' is in the standard outline');
    assert.ok(!compact.some(part => part.heading === heading), heading + ' is left out of the compact outline');
  }
  assert.equal(compact.find(part => part.heading === 'Customer questions for support')?.count, 2);
  assert.equal(standard.find(part => part.heading === 'Customer questions for support')?.count, 3);
});

test('a compact structure declares its depth in the foundation and its starters follow it', () => {
  const design = designStructure({ appName: 'Example', audiences: ['everyone'], purposes: ['product-guide'], depth: 'compact' });
  const foundation = (design.starter as { key: string; data: unknown }[]).find(record => record.key === 'foundation');
  assert.equal(depthOf(foundation), 'compact');
  const outline = (design.articleOutlines as Record<string, { heading: string }[]>).features!;
  assert.ok(!outline.some(part => skipped.includes(part.heading)));
  assert.equal(depthOf(undefined), 'standard');
});
