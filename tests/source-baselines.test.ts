import test from 'node:test';
import assert from 'node:assert/strict';
import { addSourceBaselineTags, mergeSourceBaselines, sourceBaseline, sourceBaselines } from '../src/source-baselines.js';

const web = {name: 'web', repository: 'github.com/example/web', commit: 'a'.repeat(40), branch: 'develop', tag: 'documentation-v1.0.0'};

test('source baselines require an exact reviewed commit and stable credential-free identity', () => {
  assert.deepEqual(sourceBaseline.parse(web), web);
  for (const commit of ['HEAD', 'main', 'abc123', 'a'.repeat(39)]) assert.equal(sourceBaseline.safeParse({...web, commit}).success, false);
  for (const repository of ['/Users/member/web', 'https://token@github.com/example/web', '../web']) {
    assert.equal(sourceBaseline.safeParse({...web, repository}).success, false);
  }
  assert.equal(sourceBaseline.safeParse({...web, tag: 'documentation-v1.0.0^{commit}'}).success, false);
  assert.equal(sourceBaselines.safeParse([web, web]).success, false);
});

test('an update advances only reviewed repositories and preserves the other baseline commits', () => {
  const backend = {name: 'backend', repository: 'github.com/example/backend', commit: 'b'.repeat(40)};
  const updated = {...web, commit: 'c'.repeat(40), branch: 'release/prod', tag: 'documentation-v1.0.1'};
  assert.deepEqual(mergeSourceBaselines([web, backend], [updated]), [updated, backend]);
  assert.throws(() => mergeSourceBaselines([web], [{...web, repository: 'github.com/other/web'}]), /identity changed/);
});

test('post-publication tag association can only add missing tags to the same reviewed commits', () => {
  const untagged = {name: web.name, repository: web.repository, commit: web.commit, branch: web.branch};
  assert.deepEqual(addSourceBaselineTags([untagged], [web]), [web]);
  assert.deepEqual(addSourceBaselineTags([web], [web]), [web]);
  for (const changed of [{...web, tag: 'other'}, {...web, commit: 'b'.repeat(40)}, {...web, branch: 'prod'}, untagged]) {
    assert.throws(() => addSourceBaselineTags([web], [changed]), /different source baseline/);
  }
  assert.throws(() => addSourceBaselineTags([web], []), /mappings cannot be replaced/);
});