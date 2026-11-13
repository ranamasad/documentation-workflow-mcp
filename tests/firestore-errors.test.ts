import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreReader, FIRESTORE_DENIED, FirestoreAccessError } from '../src/firestore.js';

const reader = (status: number, body: unknown) => createFirestoreReader('acme-docs', async () => 'test-token',
  async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

test('Firestore errors say whether the database is missing or access is denied', async () => {
  const disabled = reader(403, { error: { status: 'PERMISSION_DENIED', message: 'Cloud Firestore API has not been used in project acme-docs before or it is disabled.' } });
  await assert.rejects(disabled.get('documentationEnvironments/development'), (error: FirestoreAccessError) =>
    error.status === 424 && /Create database/.test(error.message));
  const missing = reader(404, { error: { status: 'NOT_FOUND', message: 'The database (default) does not exist for project acme-docs' } });
  await assert.rejects(missing.get('documentationEnvironments/development'), /Create database/);
  const denied = reader(403, { error: { status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } });
  await assert.rejects(denied.get('documentationEnvironments/development'), (error: FirestoreAccessError) => error.message === FIRESTORE_DENIED);
  assert.equal(await reader(404, { error: { status: 'NOT_FOUND', message: 'Document "projects/acme-docs/databases/(default)/documents/documentationEnvironments/development" not found.' } }).get('documentationEnvironments/development'), null);
});
