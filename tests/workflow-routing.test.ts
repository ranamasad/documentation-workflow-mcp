import test from 'node:test';
import assert from 'node:assert/strict';
import { routeWorkflow } from '../src/workflows.js';

const none = [{ environment: 'development', release: null }, { environment: 'beta', release: null }];
const v3 = [{ environment: 'development', release: { version: '1.4.0', format: 3 } }, { environment: 'beta', release: null }];
const legacy = [{ environment: 'development', release: { version: '1.0.0' } }];

test('the project\'s Firestore decides the workflow when none is requested', () => {
  assert.deepEqual(routeWorkflow(none, 'author'), { workflow: 'new-project', confirm: 'Nothing is published for this project yet. Write its first documentation now?' });
  const update = routeWorkflow(v3, 'author');
  assert.ok('workflow' in update && update.workflow === 'update');
  assert.match(update.confirm!, /Development \(v1\.4\.0\)/);
  assert.ok('workflow' in routeWorkflow(legacy, 'owner') && (routeWorkflow(legacy, 'owner') as { workflow: string }).workflow === 'convert');
  const author = routeWorkflow(legacy, 'author');
  assert.ok('workflow' in author && author.workflow === 'update', 'Authors cannot migrate, so they update legacy documentation.');
  assert.match(author.confirm!, /owner or admin can migrate/);
});

test('requests that contradict what is published, or the role, are refused', () => {
  assert.match((routeWorkflow(v3, 'owner', 'new-project') as { blocked: string }).blocked, /already has documentation in Development/);
  assert.match((routeWorkflow(none, 'owner', 'update') as { blocked: string }).blocked, /Use new-project/);
  assert.match((routeWorkflow(v3, 'owner', 'convert') as { blocked: string }).blocked, /already uses encrypted v3/);
  assert.match((routeWorkflow(v3, 'author', 'promote') as { blocked: string }).blocked, /Only an owner or admin can promote/);
  assert.deepEqual(routeWorkflow(v3, 'admin', 'promote'), { workflow: 'promote' });
  assert.deepEqual(routeWorkflow(legacy, 'owner', 'new-project'), { workflow: 'new-project' }, 'Older documentation can be replaced by a fresh v3 start.');
  assert.match((routeWorkflow(legacy, 'owner') as { confirm: string }).confirm, /start fresh/);
});

test('viewers can only check published documentation', () => {
  assert.match((routeWorkflow(none, 'viewer') as { blocked: string }).blocked, /viewers cannot start/);
  assert.match((routeWorkflow(v3, 'viewer', 'update') as { blocked: string }).blocked, /cannot change it/);
  const audit = routeWorkflow(v3, 'viewer');
  assert.ok('workflow' in audit && audit.workflow === 'audit');
});
