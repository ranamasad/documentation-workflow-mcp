import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { releaseAdapter, createWebsiteReleases } from '../src/website-releases.js';
import { fakeFirestore } from './fake-firestore.js';
import { createManagedDocumentation } from '../src/managed-documentation.js';
import { generateKeyPair, exportPKCS8 } from 'jose';
import type { ProjectStore } from '../src/project-store.js';
import type { ReadAccess } from '../src/published.js';
import { reviewedCatalog, releaseNoteUpdate } from './reviewed-catalog.js';

const require = createRequire(import.meta.url);
const engine = require('../../vendor/documentation-engine.js') as { publish(adapter: unknown, options: Record<string, unknown>): Promise<{ releaseId: string }> };
const records = reviewedCatalog();

test('dashboard promotion and rollback use the release engine with create-only writes and an atomic pointer', async () => {
  const { fetchFake, docs } = fakeFirestore('acme-docs');
  const adapter = releaseAdapter('acme-docs', async () => 'token', 'owner@example.com', fetchFake);
  const first = await engine.publish(adapter, { operation: 'apply', environment: 'development', expected: 'empty', version: '1.0.0', tags: ['New'],
    summary: 'First publication.', actor: 'owner@example.com', records });
  assert.ok(docs.has('documentationEnvironments/development'));

  const projectId = '11111111-1111-4111-8111-111111111111';
  const rpc = async (name: string) => {
    if (name === 'mcp_website_get') return { projectId, workspaceId: '22222222-2222-4222-8222-222222222222', managed: true, managedAt: null, syncedAt: null, syncError: null, teams: [], people: [] };
    if (name === 'mcp_website_sync_target') return { firebaseProject: 'acme-docs', serviceAccountKey: '{}' };
    throw new Error('Unexpected RPC ' + name);
  };
  const releases = createWebsiteReleases(rpc, fetchFake, (project, _key, actor) => releaseAdapter(project, async () => 'token', actor, fetchFake));
  const target = ['member', 'workspace', 'Acme', 'Owner@Example.com'] as const;

  const before = await releases.status(...target);
  assert.equal(before.environments.find(item => item.environment === 'development')?.release?.id, first.releaseId);
  assert.equal(before.environments.find(item => item.environment === 'beta')?.release, null);

  const promoted = await releases.promote(...target, { source: 'development', target: 'beta', expected: 'empty', expectedSource: first.releaseId });
  const after = await releases.status(...target);
  const beta = after.environments.find(item => item.environment === 'beta')!.release!;
  assert.equal(beta.id, promoted.releaseId);
  assert.equal(beta.operation, 'promote');
  assert.equal(beta.version, '1.0.0', 'Promotion keeps the source version by default.');
  assert.equal(beta.actor, 'owner@example.com', 'The dashboard user is recorded as the author.');

  await assert.rejects(releases.promote(...target, { source: 'development', target: 'beta', expected: 'empty', expectedSource: first.releaseId }),
    /Conflict/, 'A stale plan never overwrites newer work.');
  await assert.rejects(releases.promote(...target, { source: 'production', target: 'beta', expected: promoted.releaseId, expectedSource: first.releaseId }),
    /Only Development/);

  const second = await engine.publish(adapter, { operation: 'apply', environment: 'development', expected: first.releaseId, version: '1.1.0', tags: ['Changed'],
    summary: 'Second.', actor: 'owner@example.com', records: [{ ...records[1]!, title: 'Renamed article' }] });
  const history = await releases.history(...target, 'development');
  assert.deepEqual(history.releases.map(item => item.id), [second.releaseId, first.releaseId]);
  const rolledBack = await releases.rollback(...target, { environment: 'development', expected: second.releaseId, rollbackRelease: first.releaseId,
    version: '1.0.1', tags: ['Hotfix'], summary: 'Restore the previous title.' });
  const restored = (await releases.status(...target)).environments.find(item => item.environment === 'development')!.release!;
  assert.equal(restored.id, rolledBack.releaseId);
  assert.equal(restored.operation, 'rollback');
  await assert.rejects(releases.rollback(...target, { environment: 'development', expected: second.releaseId, rollbackRelease: first.releaseId, version: '1.0.2', tags: ['Hotfix'], summary: 'Again.' }), /Conflict/);
  await assert.rejects(releases.rollback(...target, { environment: 'development', expected: rolledBack.releaseId, rollbackRelease: first.releaseId }), /needs a version/);
  const unplanned = structuredClone(records[0]!);
  delete unplanned.data.audienceCoverage;
  const historical = await engine.publish(adapter, { operation: 'apply', environment: 'development', expected: rolledBack.releaseId,
    version: '0.9.0', tags: ['Changed'], summary: 'Historical coverage plan absent.', records: [unplanned], actor: 'owner@example.com' });
  await assert.rejects(releases.promote(...target, { source: 'development', target: 'beta',
    expected: promoted.releaseId, expectedSource: historical.releaseId }), /AUDIENCE_PLAN_REQUIRED/);
  assert.equal((await releases.status(...target)).environments.find(item => item.environment === 'beta')!.release!.id, promoted.releaseId);
});

test('dashboard status, history, promotion and rollback use managed encryption without a vault', async () => {
  const previousRoot = process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
  process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = Buffer.alloc(32, 81).toString('base64url');
  try {
    const fake = fakeFirestore('acme-docs');
    const rsa = await generateKeyPair('RS256', { extractable: true });
    const key = JSON.stringify({ type: 'service_account', project_id: 'acme-docs',
      client_email: 'test@acme-docs.iam.gserviceaccount.com', private_key: await exportPKCS8(rsa.privateKey) });
    const fetcher: typeof fetch = async (url, options) => String(url).includes('oauth2.googleapis.com') ?
      Response.json({ access_token: 'test-token', expires_in: 3600 }) : fake.fetchFake(url, options);
    const projectId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const access: ReadAccess = { projectId, name: 'Acme', role: 'owner', environments: ['development', 'beta', 'production'],
      mode: 'service-account', firebaseProject: 'acme-docs', firebaseApiKey: null, serviceAccountKey: key, personalRefreshToken: null };
    const projects: ProjectStore = {
      async readAccess() { return access; }, async memberEmail() { return 'owner@example.com'; },
      async list() { throw new Error('Unexpected project listing'); },
      async save() { throw new Error('Unexpected settings write'); },
      async forget() { throw new Error('Unexpected project removal'); }
    };
    const managed = createManagedDocumentation({ projectId, firebaseProject: 'acme-docs', serviceAccountKey: key,
      role: 'owner', environments: access.environments }, { fetchService: fetcher });
    const first = await managed.publish('development', { records, expected: 'empty',
      metadata: { version: '1.0.0', tags: ['New'], summary: 'First managed publication.', operation: 'apply' } });
    const rpc = async (name: string) => {
      if (name === 'mcp_website_get') return { projectId, workspaceId, managed: true, managedAt: null, syncedAt: null, syncError: null, teams: [], people: [] };
      if (name === 'mcp_website_sync_target') return { firebaseProject: 'acme-docs', serviceAccountKey: key };
      throw new Error('Unexpected RPC ' + name);
    };
    const releases = createWebsiteReleases(rpc, fetcher, undefined, () => projects);
    const target = ['member', workspaceId, 'Acme', 'owner@example.com'] as const;
    const status = await releases.status(...target);
    assert.equal(status.environments.find(item => item.environment === 'development')?.release?.id, first.releaseId);
    const promoted = await releases.promote(...target, { source: 'development', target: 'beta', expected: 'empty', expectedSource: first.releaseId });
    await assert.rejects(releases.promote(...target, { source: 'development', target: 'beta', expected: promoted.releaseId,
      expectedSource: first.releaseId, version: '1.1.0', tags: ['Changed'], summary: 'Missing version entry.' }), /RELEASE_NOTES_MISSING/);
    assert.equal((await releases.status(...target)).environments.find(item => item.environment === 'beta')?.release?.id, promoted.releaseId);
    const updated = await managed.publish('development', {records: [...records.filter(record => record.key !== 'foundation'), ...releaseNoteUpdate(records, '1.1.0')],
      expected: first.releaseId, metadata: {version: '1.1.0', tags: ['Changed'], summary: 'Document the next version.', operation: 'apply'}});
    const next = await releases.promote(...target, { source: 'development', target: 'beta', expected: promoted.releaseId,
      expectedSource: updated.releaseId, version: '1.1.0', tags: ['Changed'], summary: 'New release notes.' });
    const history = await releases.history(...target, 'beta');
    assert.deepEqual(history.releases.map(item => item.id), [next.releaseId, promoted.releaseId]);
    const restored = await releases.rollback(...target, { environment: 'beta', expected: next.releaseId, rollbackRelease: promoted.releaseId,
      version: '1.0.1', tags: ['Hotfix'], summary: 'Restore original managed snapshot.' });
    assert.equal((await releases.status(...target)).environments.find(item => item.environment === 'beta')?.release?.id, restored.releaseId);
    assert.ok(!fake.docs.has('documentationEnvironments/beta'), 'Managed promotion never creates a plaintext target.');
    assert.ok(fake.docs.has('documentationV3History/beta'), 'History is maintained with the encrypted pointer.');
  } finally {
    if (previousRoot === undefined) delete process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY;
    else process.env.MCP_DOCUMENTATION_ENCRYPTION_KEY = previousRoot;
  }
});
