import test from 'node:test';
import assert from 'node:assert/strict';
import { importable, reconcile, createWebsiteAccess, WebsiteAccessError, type WebsiteState } from '../src/website-access.js';
import type { FirestoreDocument, FirestoreWrite, FirestoreWriter } from '../src/firestore.js';

const support = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const testers = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const doc = (id: string, data: Record<string, unknown>): FirestoreDocument => ({ id, data });
const state = (overrides: Partial<WebsiteState> = {}): WebsiteState => ({
  projectId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222',
  managed: true, managedAt: null, syncedAt: null, syncError: null,
  teams: [{ id: support, name: 'Support', environments: ['production'], reader: 'support', role: 'reader' }],
  people: [
    { email: 'owner@example.com', role: 'owner', joined: true, website: true, admin: true, teamId: null, reader: null },
    { email: 'agent@example.com', role: 'viewer', joined: true, website: true, admin: false, teamId: support, reader: null },
    { email: 'writer@example.com', role: 'author', joined: true, website: false, admin: false, teamId: null, reader: null }
  ],
  ...overrides
});

test('import keeps valid website users, admins and teams and ignores what the website would reject', () => {
  const imported = importable(
    [doc(support, { name: ' Support ', environments: ['production', 'staging'] }), doc('not-a-uuid', { name: 'Bad' }), doc(testers, { name: 'Testers' })],
    [doc('agent@example.com', { enabled: true, teamId: support }), doc('gone@example.com', { enabled: false }),
      doc('lost@example.com', { enabled: true, teamId: 'deleted-team' }), doc('Not An Email', { enabled: true })],
    [doc('console-admin@example.com', { enabled: true }), doc('former@example.com', { enabled: false })]
  );
  assert.deepEqual(imported.teams, [{ id: support, name: 'Support', environments: ['production'] }, { id: testers, name: 'Testers' }]);
  assert.deepEqual(imported.people, [
    { email: 'agent@example.com', admin: false, teamId: support },
    { email: 'lost@example.com', admin: false, teamId: '' },
    { email: 'console-admin@example.com', admin: true, teamId: '' }
  ]);
});

test('reconcile writes only differences and removes access the dashboard no longer grants', () => {
  const writes = reconcile(state(), {
    teams: [doc(support, { name: 'Support', environments: ['production'] }), doc(testers, { name: 'Testers' })],
    access: [doc('agent@example.com', { enabled: true, teamId: support }), doc('writer@example.com', { enabled: true, teamId: '' }), doc('owner@example.com', { enabled: true, teamId: '' })],
    admins: [doc('writer@example.com', { enabled: true })]
  });
  assert.deepEqual(writes, [
    { set: 'adminAccess/owner@example.com', fields: { enabled: true } },
    { delete: 'feedbackAccess/writer@example.com' },
    { delete: 'adminAccess/writer@example.com' },
    { delete: 'teams/' + testers }
  ]);
});

test('reconcile creates everything for a fresh project and clears unknown team assignments', () => {
  const writes = reconcile(state({ people: [{ email: 'agent@example.com', role: 'viewer', joined: false, website: true, admin: false, teamId: testers, reader: null }] }),
    { teams: [], access: [], admins: [] });
  assert.deepEqual(writes, [
    { set: 'teams/' + support, fields: { name: 'Support', environments: ['production'] }, stamp: 'updatedAt' },
    { set: 'feedbackAccess/agent@example.com', fields: { enabled: true, teamId: '' }, stamp: 'updatedAt' }
  ]);
  const allEnvironments = reconcile(state({ teams: [{ id: support, name: 'Support', environments: null, reader: null, role: 'reader' }], people: [] }),
    { teams: [doc(support, { name: 'Support', environments: ['beta'] })], access: [], admins: [] });
  assert.deepEqual(allEnvironments, [{ set: 'teams/' + support, fields: { name: 'Support' }, stamp: 'updatedAt' }], 'No environments field means every environment.');
});

test('sync never touches Firestore before a project is imported, and records failures', async () => {
  const calls: string[] = [];
  const committed: FirestoreWrite[][] = [];
  const firestore: FirestoreWriter = { list: async collection => { calls.push('list ' + collection); return []; }, commit: async writes => { committed.push(writes); }, query: async () => ({ documents: [], truncated: false }) };
  let current = state({ managed: false });
  const results: unknown[] = [];
  const rpc = async (name: string, body: unknown) => {
    calls.push(name);
    if (name === 'mcp_website_state') return current;
    if (name === 'mcp_website_sync_target') return { firebaseProject: 'acme-docs', serviceAccountKey: '{"type":"service_account"}' };
    if (name === 'mcp_website_sync_result') { results.push(body); return true; }
    throw new Error('Unexpected RPC ' + name);
  };
  const service = createWebsiteAccess(rpc, fetch, () => firestore);
  assert.equal(await service.sync(current.projectId), null);
  assert.deepEqual(calls, ['mcp_website_state'], 'An unmanaged project is left alone.');
  current = state();
  assert.equal(await service.sync(current.projectId), null);
  assert.equal(committed.length, 1);
  assert.deepEqual(results.at(-1), { project: current.projectId, failure: null });
  const broken = createWebsiteAccess(rpc, fetch, () => ({ ...firestore, commit: async () => { throw new (await import('../src/firestore.js')).FirestoreAccessError(403, 'denied'); } }));
  assert.equal(await broken.sync(current.projectId), 'denied');
  assert.deepEqual(results.at(-1), { project: current.projectId, failure: 'denied' });
});

test('reconcile copies each person\'s reader type and clears it when removed', () => {
  const agent = { email: 'agent@example.com', role: 'viewer', joined: true, website: true, admin: false, teamId: support, reader: 'testers' as const };
  const teams = [doc(support, { name: 'Support', environments: ['production'] })];
  assert.deepEqual(reconcile(state({ people: [agent] }), { teams, access: [doc('agent@example.com', { enabled: true, teamId: support })], admins: [] }),
    [{ set: 'feedbackAccess/agent@example.com', fields: { enabled: true, teamId: support, reader: 'testers' }, stamp: 'updatedAt' }]);
  assert.deepEqual(reconcile(state({ people: [agent] }), { teams, access: [doc('agent@example.com', { enabled: true, teamId: support, reader: 'testers' })], admins: [] }), [],
    'An unchanged reader type writes nothing.');
  assert.deepEqual(reconcile(state({ people: [{ ...agent, reader: null }] }), { teams, access: [doc('agent@example.com', { enabled: true, teamId: support, reader: 'testers' })], admins: [] }),
    [{ set: 'feedbackAccess/agent@example.com', fields: { enabled: true, teamId: support }, stamp: 'updatedAt' }], 'Clearing the type rewrites the document without it.');
});

test('workspace team and access changes are copied to every managed project and report failures', async () => {
  const workspace = '22222222-2222-4222-8222-222222222222';
  const projects = ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'];
  const calls: [string, unknown][] = [];
  const failing = new Set([projects[1]]);
  const rpc = async (name: string, body: unknown) => {
    calls.push([name, body]);
    if (name === 'mcp_website_managed_projects') return projects;
    if (name === 'mcp_website_state') return state({ projectId: (body as { project: string }).project });
    if (name === 'mcp_website_sync_target') return { firebaseProject: 'acme-docs', serviceAccountKey: '{"type":"service_account"}' };
    if (['mcp_website_sync_result', 'mcp_workspace_team_save', 'mcp_workspace_team_delete', 'mcp_member_website_set', 'mcp_member_team_set'].includes(name)) return true;
    throw new Error('Unexpected RPC ' + name);
  };
  const firestore = (project: string): FirestoreWriter => ({ list: async () => [], query: async () => ({ documents: [], truncated: false }),
    commit: async () => { if (failing.has(project)) throw new (await import('../src/firestore.js')).FirestoreAccessError(403, 'denied'); } });
  let current = '';
  const service = createWebsiteAccess(async (name, body) => {
    if (name === 'mcp_website_sync_target') current = (body as { project: string }).project;
    return rpc(name, body);
  }, fetch, () => firestore(current));

  assert.deepEqual(await service.saveTeam('member', workspace, { name: ' Support ', environments: ['beta', 'production'], reader: 'support' }), { syncErrors: ['denied'] });
  assert.deepEqual(calls.find(([name]) => name === 'mcp_workspace_team_save')?.[1],
    { member: 'member', workspace, team: null, team_name: 'Support', team_envs: ['beta', 'production'], team_reader: 'support', team_role: 'reader' });
  assert.equal(calls.filter(([name]) => name === 'mcp_website_state').length, 2, 'Both managed projects are synced.');
  await service.saveTeam('member', workspace, { name: 'Dev', environments: null, reader: null, role: 'author' });
  assert.equal((calls.filter(([name]) => name === 'mcp_workspace_team_save').at(-1)?.[1] as { team_role?: string } | undefined)?.team_role, 'author', 'A team carries its role.');
  await service.setTeam('member', workspace, { email: 'New@Example.com', teamId: null, owner: true });
  assert.deepEqual(calls.find(([name]) => name === 'mcp_member_team_set')?.[1],
    { member: 'member', workspace, person_email: 'new@example.com', team: null, as_owner: true }, 'Owners join outside teams.');
  await assert.rejects(service.saveTeam('member', workspace, { name: 'QA', environments: null, reader: 'everyone' }), /valid environments and content/);

  failing.clear();
  assert.deepEqual(await service.setWebsite('member', workspace, { email: ' Agent@Example.com ', website: 'reader', teamId: support }), { syncErrors: [] });
  assert.deepEqual(calls.find(([name]) => name === 'mcp_member_website_set')?.[1],
    { member: 'member', workspace, person_email: 'agent@example.com', person_website: 'reader', team: support });
  await assert.rejects(service.setWebsite('member', workspace, { email: 'agent@example.com', website: 'owner' }), WebsiteAccessError);
  await assert.rejects(service.deleteTeam('member', workspace, 'not-a-uuid'), /Unknown team/);
  assert.deepEqual(await service.deleteTeam('member', workspace, support), { syncErrors: [] });
});
