import { z } from 'zod';
import { createManagedDocumentation, registerImportedKeys, type ManagedAccess, type ManagedOptions } from './managed-documentation.js';
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
  keys: z.array(transferKey).max(300).default([])
});
export type TransferFile = z.infer<typeof transferFile>;

export function buildTransferFile(source: TransferFile['source'], project: TransferFile['project'], keys: TransferFile['keys']): TransferFile {
  return transferFile.parse({ format: 'documentation-workflow-project', version: 1, exportedAt: new Date().toISOString(), source, project, keys });
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
