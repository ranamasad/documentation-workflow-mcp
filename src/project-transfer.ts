import { z } from 'zod';
import { createManagedDocumentation, documentationEncryptionRoot, forgetImportedDataKeys, registerImportedDataKeys, registerImportedKeys,
  type ManagedAccess, type ManagedOptions } from './managed-documentation.js';
import { createFirestoreWriter, serviceAccountTokens, type FirestoreWrite } from './firestore.js';
import { issueRecords } from './issues.js';
import { telemetryRecords } from './managed-telemetry.js';
import type { Environment } from './v3-client.js';

/**
 * The file that moves a project between the hosted dashboard and a self-hosted MCP, in either direction.
 * The documentation itself never moves: it stays in the project's own Firebase. The file carries the project's
 * identity (its ID is part of every encryption scope, so it must stay the same), its settings and the content keys
 * of its encrypted releases. A server's master key is never part of it.
 */
const environment = z.enum(['development', 'beta', 'production']);
export const transferKey = z.strictObject({
  environment, keyId: z.uuid(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
export const transferDataKey = z.strictObject({
  purpose: z.enum(['issues', 'issue-attachments', 'telemetry', 'profile']),
  environment: environment.optional(), kind: z.enum(['visit', 'vote']).optional(),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).refine(entry => entry.purpose !== 'telemetry' || (entry.environment && entry.kind), 'Telemetry keys need an environment and a kind.');
export const transferFile = z.strictObject({
  format: z.literal('documentation-workflow-project'),
  version: z.literal(1),
  exportedAt: z.string().datetime({ offset: true }),
  source: z.enum(['hosted', 'self-hosted']),
  project: z.strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).max(120),
    firebaseProject: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    environments: z.array(environment).min(1).max(3),
    settings: z.record(z.string(), z.unknown()).default({})
  }),
  keys: z.array(transferKey).max(300).default([]),
  // Issues, attachments, reader feedback and the profile cache: each has its own per-project key.
  dataKeys: z.array(transferDataKey).max(20).default([])
});
export type TransferFile = z.infer<typeof transferFile>;

export function buildTransferFile(source: TransferFile['source'], project: TransferFile['project'], keys: TransferFile['keys'],
  dataKeys: TransferFile['dataKeys'] = []): TransferFile {
  return transferFile.parse({ format: 'documentation-workflow-project', version: 1, exportedAt: new Date().toISOString(), source, project, keys, dataKeys });
}

/** Content keys as stored in projects.json: key ID to key. */
export function keyMap(keys: TransferFile['keys']): Record<string, string> {
  return Object.fromEntries(keys.map(entry => [entry.keyId, entry.key]));
}

/**
 * Re-encrypt the current release of every environment with this server's own master key. The imported keys open
 * the existing releases; each environment's new release gets a fresh key ID derived from this server's master key.
 * Releases from before the move stay readable only while their imported keys are kept.
 */
export async function reencryptProject(access: ManagedAccess, keys: TransferFile['keys'], options: ManagedOptions = {}) {
  if (!['owner', 'admin'].includes(access.role)) throw new Error('Only owners and admins can move a project.');
  registerImportedKeys(access.projectId, keyMap(keys));
  const managed = createManagedDocumentation(access, options);
  const moved: { environment: Environment; releaseId: string; keyId: string }[] = [];
  const skipped: { environment: Environment; reason: string }[] = [];
  for (const env of access.environments) {
    const current = await managed.head(env);
    if (!current.head) { skipped.push({ environment: env, reason: 'Nothing encrypted is published here.' }); continue; }
    if (!keys.some(entry => entry.keyId === current.head!.keyId)) {
      skipped.push({ environment: env, reason: 'Already encrypted with this server\'s key.' });
      continue;
    }
    const snapshot = await managed.read(env);
    const previous = snapshot.metadata;
    const result = await managed.publish(env, {
      records: snapshot.records, expected: current.head.releaseId, rotate: true,
      metadata: {
        version: previous?.version ?? 'moved', tags: previous?.tags ?? ['Changed'],
        summary: 'Moved to a new server: the same documentation, encrypted with the new server\'s key.',
        operation: 'import', sourceRelease: current.head.releaseId
      }
    }) as { releaseId?: string; keyId?: string; head?: { releaseId: string; keyId: string } };
    const head = (await managed.head(env)).head!;
    moved.push({ environment: env, releaseId: result.releaseId ?? head.releaseId, keyId: head.keyId });
  }
  return { moved, skipped };
}

/**
 * Re-encrypt a moved project's issues, attachments and reader feedback with this server's own keys, so the imported
 * data keys are not needed afterwards. Everything is read and checked before anything is written, and running it
 * again after an interruption finishes the job.
 * The profile cache is not copied: it is rebuilt on demand.
 */
export async function rekeyProjectData(access: ManagedAccess, dataKeys: TransferFile['dataKeys'], options: { fetchService?: typeof fetch | undefined; masterKey?: string | undefined } = {}) {
  if (!['owner', 'admin'].includes(access.role)) throw new Error('Only owners and admins can move a project.');
  if (!dataKeys.length) return { issues: 0, attachments: 0, telemetry: 0 };
  const fetchService = options.fetchService ?? fetch;
  const firestore = createFirestoreWriter(access.firebaseProject, serviceAccountTokens(access.serviceAccountKey, fetchService), fetchService);
  const root = documentationEncryptionRoot(options.masterKey);
  const id = access.projectId;
  // Records an earlier, interrupted import already re-keyed open with this server's key and are left as they are.
  const pending: { path: string; data: unknown; kind: 'issue' | 'part' | 'telemetry' }[] = [];
  for (const document of await firestore.list(issueRecords.collection(id))) {
    pending.push({ path: issueRecords.collection(id) + '/' + document.id, data: document.data, kind: 'issue' });
    for (const part of await firestore.list(issueRecords.parts(id, document.id))) {
      pending.push({ path: issueRecords.parts(id, document.id) + '/' + part.id, data: part.data, kind: 'part' });
    }
  }
  for (const collection of telemetryRecords.collections(id)) {
    for (const document of await firestore.list(collection)) pending.push({ path: collection + '/' + document.id, data: document.data, kind: 'telemetry' });
  }
  const open = (item: typeof pending[number]) => item.kind === 'issue' ? issueRecords.open(root, id, item.path, item.data)
    : item.kind === 'part' ? issueRecords.openPart(root, id, item.path, item.data) : telemetryRecords.open(root, id, item.path, item.data);
  const opened = new Map<string, unknown>();
  const unreadable: typeof pending = [];
  registerImportedDataKeys(id, dataKeys);
  try {
    for (const item of pending) {
      try { opened.set(item.path, open(item)); } catch { unreadable.push(item); }
    }
  } finally { forgetImportedDataKeys(id); }
  for (const item of unreadable) {
    try { open(item); } catch { throw new Error('A stored ' + item.kind + ' opens with neither the imported key nor this server\'s key: ' + item.path); }
  }
  const issues = pending.filter(item => item.kind === 'issue' && opened.has(item.path))
    .map(item => ({ path: item.path, issue: opened.get(item.path) as ReturnType<typeof issueRecords.open> }));
  const parts = pending.filter(item => item.kind === 'part' && opened.has(item.path))
    .map(item => ({ path: item.path, bytes: opened.get(item.path) as Buffer }));
  const telemetry = pending.filter(item => item.kind === 'telemetry' && opened.has(item.path))
    .map(item => ({ path: item.path, value: opened.get(item.path) as ReturnType<typeof telemetryRecords.open> }));
  const strings = (value: object) => value as Record<string, string>;
  const writes: FirestoreWrite[] = [
    ...issues.map(item => ({ set: item.path, fields: strings(issueRecords.seal(root, id, item.path, item.issue)) })),
    ...parts.map(item => ({ set: item.path, fields: strings(issueRecords.sealPart(root, id, item.path, item.bytes)) })),
    ...telemetry.map(item => ({ set: item.path, fields: strings(telemetryRecords.seal(root, id, item.path, item.value)) }))
  ];
  await firestore.commit(writes);
  return { issues: issues.length, attachments: parts.length, telemetry: telemetry.length };
}
