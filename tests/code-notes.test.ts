import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openNotes, sealNotes } from '../src/code-notes.js';

test('code notes are sealed to their project and area', () => {
  const sealed = sealNotes('Acme', 'ios-guests', '# Notes\nGuests tab shows the seat map.');
  assert.ok(!sealed.includes('Guests'));
  assert.equal(openNotes('acme', 'ios-guests', sealed), '# Notes\nGuests tab shows the seat map.');
  assert.equal(openNotes('Acme', 'other-area', sealed), undefined);
  assert.equal(openNotes('Other', 'ios-guests', sealed), undefined);
});

test('the hosted script lists changed, new and deleted source files from saved hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-root-'));
  const notes = mkdtempSync(join(tmpdir(), 'notes-'));
  writeFileSync(join(root, 'a.swift'), 'let a = 1\n');
  writeFileSync(join(root, 'b.swift'), 'let b = 2\n');
  writeFileSync(join(root, 'c.swift'), 'let c = 3\n');
  mkdirSync(join(notes, 'ios-core'));
  writeFileSync(join(notes, 'ios-core', 'notes.md'), '# core');
  // a.swift unchanged (git blob hash of "let a = 1\n"), b.swift changed, gone.swift deleted, c.swift new.
  const hashA = execFileSync('git', ['hash-object', join(root, 'a.swift')]).toString().trim();
  writeFileSync(join(notes, 'ios-core', 'files.json'), JSON.stringify({ 'a.swift': hashA, 'b.swift': '0'.repeat(40), 'gone.swift': '1'.repeat(40) }));
  writeFileSync(join(notes, 'ios-core', 'read.txt'), [join(root, 'a.swift'), join(root, 'b.swift'), join(root, 'c.swift')].join('\n'));
  const out = execFileSync('node', [resolve('public/tools/push-records.mjs'), 'changed', notes, '--root', root], { env: { ...process.env, DMCP_TOKEN: 'unused' } }).toString();
  assert.match(out, /ios-core: 1 changed, 1 new, 1 deleted/);
  assert.match(out, /changed b\.swift/);
  assert.match(out, /new c\.swift/);
  assert.match(out, /deleted gone\.swift/);
});
