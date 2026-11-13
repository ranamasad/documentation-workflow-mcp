import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, type WireRecord } from '../src/validation.js';

// Shared test fixture: an in-memory Firestore with published documentation, served over the REST shapes.
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const model = require(resolve(root, 'vendor/documentation-model.js'));
export const records = JSON.parse(readFileSync(resolve(root, 'contract/examples/v2-catalog.json'), 'utf8')) as WireRecord[];
export const releaseId = '0f8a3c1e-2b4d-4e6f-8a9b-0c1d2e3f4a5b';
export const projectId = 'acme-docs';

// Firestore REST value encoding, the inverse of decodeFields.
export function encode(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, encode(item)])) } };
}

/** An in-memory Firestore with one published release in beta, served over the REST shapes. */
export function fakeFirestore(options: { deny?: boolean; corrupt?: boolean } = {}) {
  const documents = new Map<string, Record<string, unknown>>();
  const manifest: Record<string, string> = {};
  for (const record of records) {
    const payload = model.json(record);
    const revision = sha256(payload);
    manifest[record.key] = revision;
    documents.set('documentationEnvironments/beta/revisions/' + revision,
      { schema: 1, key: record.key, title: record.title, payload: options.corrupt && record.key !== 'foundation' ? payload + ' ' : payload });
  }
  const changed = records[1]!.key;
  documents.set('documentationEnvironments/beta', { releaseId, generation: 3 });
  documents.set('documentationReleases/' + releaseId, {
    schema: 1, environment: 'beta', version: '1.2.0', tags: ['New'], summary: 'Adds the beta item.', actor: 'admin@example.com',
    base: '', operation: 'apply', source: '', sourceRelease: '', rollbackRelease: '', manifest: JSON.stringify(manifest),
    areaChanges: JSON.stringify({ [changed]: { before: '', after: manifest[changed], version: '1.2.0', tags: ['New'], summary: 'Adds the beta item.',
      actor: 'admin@example.com', releaseId, previousRelease: '' } }),
    createdAt: '2026-10-16T10:00:00Z'
  });
  const base = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents';
  const calls: string[] = [];
  const fetchFirestore: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (options.deny) return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
    assert.match(String(new Headers(init?.headers).get('authorization')), /^Bearer .+/);
    if (url === base + ':batchGet') {
      const names = (JSON.parse(String(init?.body)) as { documents: string[] }).documents;
      return Response.json(names.map(name => {
        const data = documents.get(name.slice(('projects/' + projectId + '/databases/(default)/documents/').length));
        return data ? { found: { name, fields: (encode(data) as { mapValue: { fields: object } }).mapValue.fields } } : { missing: name };
      }));
    }
    const path = url.slice(base.length + 1);
    const data = documents.get(path);
    if (!data) return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    const fields = (encode(data) as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields;
    if (path.startsWith('documentationReleases/')) fields.createdAt = { timestampValue: '2026-10-16T10:00:00Z' };
    return Response.json({ name: base + '/' + path, fields });
  };
  return { fetchFirestore, calls, manifest, changed };
}

