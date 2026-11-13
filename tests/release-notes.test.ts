import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReleaseNotes } from '../src/release-notes.js';
import { qualityReport } from '../src/quality.js';

const feature = {key: 'features/membership', data: {blocks: []}};
const note = (version: string, highlights = 'Documentation-only: clarify invitations without changing behavior.') => ({
  key: 'release-notes/v' + version.replaceAll('.', '-'), data: {value: {version, highlights}, blocks: [
    {type: 'cards', items: [{title: 'Membership', text: 'Updated invitation instructions.', href: '#/features/membership'}]}
  ]}
});

test('new documentation and new versions need their own release entry', () => {
  assert.equal(checkReleaseNotes([feature], '1.0.0')[0]?.code, 'RELEASE_NOTES_MISSING');
  assert.equal(checkReleaseNotes([feature, note('1.0.0')], '1.1.0')[0]?.code, 'RELEASE_NOTES_MISSING');
  assert.deepEqual(checkReleaseNotes([feature, note('1.0.0'), note('1.1.0')], '1.1.0'), []);
  assert.ok(qualityReport([feature], undefined, undefined, {publicationVersion: '1.0.0'}).issues.some(issue => issue.code === 'RELEASE_NOTES_MISSING'));
});

test('scope is explicit without treating feature links as application changes', () => {
  assert.deepEqual(checkReleaseNotes([feature, note('1.0.0')], '1.0.0'), []);
  assert.deepEqual(checkReleaseNotes([feature, note('1.1.0', 'Application changes: add member revocation.')], '1.1.0'), []);
  assert.equal(checkReleaseNotes([feature, note('1.0.0', 'A new version is available.')], '1.0.0')[0]?.code, 'RELEASE_NOTES_SCOPE');
});

test('duplicate versions, missing affected articles and a mismatched version are rejected', () => {
  assert.equal(checkReleaseNotes([feature, note('1.0.0'), {...note('1.0.0'), key: 'release-notes/another'}], '1.0.0')[0]?.code, 'RELEASE_NOTES_DUPLICATE');
  assert.equal(checkReleaseNotes([note('1.0.0')], '1.0.0')[0]?.code, 'RELEASE_NOTES_LINKS');
  assert.deepEqual(checkReleaseNotes([feature]), [], 'Batch validation without a publication version does not invent one.');
});