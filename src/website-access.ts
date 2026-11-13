import { z } from 'zod';
import { createFirestoreWriter, FirestoreAccessError, serviceAccountTokens, type FirestoreDocument, type FirestoreWrite, type FirestoreWriter } from './firestore.js';

// Website access is managed per workspace on the dashboard's Team page (Supabase is the source of truth)
// and copied into the Firestore of each of the workspace's managed projects, where the documentation
// website's security rules enforce it. The reader type comes from the person's team:
//   teams/{id}            { name, environments?, updatedAt }   no environments = every environment
//   feedbackAccess/{email} { enabled: true, teamId, reader?, updatedAt } may sign in; the team decides environments,
//                          the reader type (support, testers, …) decides which written-for-readers content they see
//   adminAccess/{email}    { enabled: true }                    website administrator, every environment
// Sync is a reconcile: Firestore ends up exactly matching Supabase, including removals.

type Rpc = (name: string, body: unknown) => Promise<unknown>;
type Fetch = typeof fetch;

const ENVIRONMENTS = ['development', 'beta', 'production'] as const;
const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A team's role is the role of everyone in it (MCP and website); owners sit outside teams.
export const TEAM_ROLES = ['admin', 'author', 'reader'] as const;
export const READERS = ['end-users', 'support', 'testers', 'product-owners', 'administrators', 'developers', 'internal'] as const;
const EMAIL = /^[a-z0-9!#$%&'*+=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const environments = z.array(z.enum(ENVIRONMENTS)).max(3).nullable();
export const websiteState = z.object({
  projectId: z.string().uuid(), workspaceId: z.string().uuid(),
  managed: z.boolean(), managedAt: z.string().nullable(), syncedAt: z.string().nullable(), syncError: z.string().nullable(),
  teams: z.array(z.object({ id: z.string().uuid(), name: z.string(), environments, reader: z.enum(READERS).nullable().default(null),
    role: z.enum(TEAM_ROLES).default('reader') })),
  people: z.array(z.object({ email: z.string(), role: z.string(), joined: z.boolean(), website: z.boolean(), admin: z.boolean(), teamId: z.string().uuid().nullable(),
    reader: z.enum(READERS).nullable().default(null) }))
});
export type WebsiteState = z.infer<typeof websiteState>;

export class WebsiteAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ImportedAccess {
  teams: { id: string; name: string; environments?: string[] }[];
  people: { email: string; admin: boolean; teamId: string }[];
}

/** Read what the website uses today, ignoring documents the website itself would reject. */
export function importable(teams: FirestoreDocument[], access: FirestoreDocument[], admins: FirestoreDocument[]): ImportedAccess {
  const validTeams = teams.filter(team => TEAM_ID.test(team.id) && typeof team.data.name === 'string' && team.data.name.trim())
    .map(team => ({ id: team.id, name: String(team.data.name).trim().slice(0, 80),
      ...(Array.isArray(team.data.environments) ? { environments: team.data.environments.filter((item): item is string => ENVIRONMENTS.includes(item as never)) } : {}) }));
  const teamIds = new Set(validTeams.map(team => team.id));
  const adminEmails = new Set(admins.filter(item => item.data.enabled === true && EMAIL.test(item.id)).map(item => item.id));
  const people = new Map<string, { email: string; admin: boolean; teamId: string }>();
  for (const item of access) {
    if (item.data.enabled !== true || !EMAIL.test(item.id)) continue;
    const teamId = typeof item.data.teamId === 'string' && teamIds.has(item.data.teamId) ? item.data.teamId : '';
    people.set(item.id, { email: item.id, admin: adminEmails.has(item.id), teamId });
  }
  // Administrators set up in the Firebase console may lack a feedbackAccess document; they keep access.
  for (const email of adminEmails) if (!people.has(email)) people.set(email, { email, admin: true, teamId: '' });
  return { teams: validTeams, people: [...people.values()] };
}

const sameEnvironments = (left: unknown, right: string[] | null) =>
  right === null ? left === undefined : Array.isArray(left) && left.length === right.length && right.every(item => left.includes(item));

/** The Firestore writes that make the website match the dashboard state. Unchanged documents are left alone. */
export function reconcile(state: WebsiteState, current: { teams: FirestoreDocument[]; access: FirestoreDocument[]; admins: FirestoreDocument[] }): FirestoreWrite[] {
  const writes: FirestoreWrite[] = [];
  const existing = (documents: FirestoreDocument[]) => new Map(documents.map(item => [item.id, item.data]));
  const teams = existing(current.teams), access = existing(current.access), admins = existing(current.admins);
  const wantedTeams = new Set(state.teams.map(team => team.id));
  for (const team of state.teams) {
    const now = teams.get(team.id);
    if (now && now.name === team.name && sameEnvironments(now.environments, team.environments)) continue;
    writes.push({ set: 'teams/' + team.id, fields: { name: team.name, ...(team.environments ? { environments: team.environments } : {}) }, stamp: 'updatedAt' });
  }
  const readers = state.people.filter(person => person.website && EMAIL.test(person.email));
  const wantedReaders = new Set(readers.map(person => person.email));
  const wantedAdmins = new Set(readers.filter(person => person.admin).map(person => person.email));
  for (const person of readers) {
    const teamId = person.teamId && wantedTeams.has(person.teamId) ? person.teamId : '';
    const now = access.get(person.email);
    if (!now || now.enabled !== true || (now.teamId ?? '') !== teamId || (now.reader ?? null) !== person.reader) {
      writes.push({ set: 'feedbackAccess/' + person.email, fields: { enabled: true, teamId, ...(person.reader ? { reader: person.reader } : {}) }, stamp: 'updatedAt' });
    }
    if (person.admin && admins.get(person.email)?.enabled !== true) writes.push({ set: 'adminAccess/' + person.email, fields: { enabled: true } });
  }
  for (const email of access.keys()) if (!wantedReaders.has(email)) writes.push({ delete: 'feedbackAccess/' + email });
  for (const email of admins.keys()) if (!wantedAdmins.has(email)) writes.push({ delete: 'adminAccess/' + email });
  for (const id of teams.keys()) if (!wantedTeams.has(id)) writes.push({ delete: 'teams/' + id });
  return writes;
}

const syncTarget = z.object({ firebaseProject: z.string().nullable(), serviceAccountKey: z.string().nullable() });
const teamInput = z.strictObject({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(80), environments, reader: z.enum(READERS).nullable().default(null),
  role: z.enum(TEAM_ROLES).default('reader') });
const websiteInput = z.strictObject({ email: z.string().trim().toLowerCase().regex(EMAIL, 'Enter a valid email address.').max(254),
  website: z.enum(['none', 'reader', 'admin']), teamId: z.string().uuid().nullable().default(null) });
const memberTeamInput = z.strictObject({ email: z.string().trim().toLowerCase().regex(EMAIL, 'Enter a valid email address.').max(254),
  teamId: z.string().uuid().nullable().default(null), owner: z.boolean().default(false) });

export function createWebsiteAccess(rpc: Rpc, fetchGoogle: Fetch, writerFor?: (projectId: string, key: string) => FirestoreWriter) {
  const writer = writerFor ?? ((projectId: string, key: string) => createFirestoreWriter(projectId, serviceAccountTokens(key, fetchGoogle), fetchGoogle));

  async function target(projectId: string) {
    const result = syncTarget.safeParse(await rpc('mcp_website_sync_target', { project: projectId }));
    if (!result.success) throw new WebsiteAccessError(503, 'Account storage returned invalid project settings.');
    if (!result.data.firebaseProject) throw new WebsiteAccessError(400, 'Add the Firebase project ID to this project first.');
    if (!result.data.serviceAccountKey) throw new WebsiteAccessError(400, 'Upload the project\'s service-account key first (project setup, step 3).');
    return writer(result.data.firebaseProject, result.data.serviceAccountKey);
  }
  async function read(firestore: FirestoreWriter) {
    const [teams, access, admins] = await Promise.all([firestore.list('teams'), firestore.list('feedbackAccess'), firestore.list('adminAccess')]);
    return { teams, access, admins };
  }
  const parseState = (value: unknown) => {
    const result = websiteState.safeParse(value);
    if (!result.success) throw new WebsiteAccessError(503, 'Account storage returned invalid website access.');
    return result.data;
  };
  const failure = (error: unknown) => {
    if (error instanceof FirestoreAccessError || error instanceof WebsiteAccessError) return error.message;
    throw error;
  };

  /** Copy one managed project's state into its Firestore and record the outcome. */
  async function sync(projectId: string): Promise<string | null> {
    const state = parseState(await rpc('mcp_website_state', { project: projectId }));
    if (!state.managed) return null;
    let problem: string | null = null;
    try {
      const firestore = await target(projectId);
      const writes = reconcile(state, await read(firestore));
      if (writes.length) await firestore.commit(writes);
    } catch (error) { problem = failure(error); }
    await rpc('mcp_website_sync_result', { project: projectId, failure: problem });
    return problem;
  }

  async function state(member: string, workspace: string, name: string) {
    return parseState(await rpc('mcp_website_get', { member, workspace, project_name: name }));
  }
  async function afterChange(member: string, workspace: string, name: string) {
    const current = await state(member, workspace, name);
    await sync(current.projectId);
    return state(member, workspace, name);
  }

  return {
    state,
    sync,
    /** Start managing a project: copy its current Firestore users, admins and teams into Supabase. */
    async importExisting(member: string, workspace: string, name: string) {
      const current = await state(member, workspace, name);
      if (current.managed) throw new WebsiteAccessError(400, 'Website access for this project is already managed here.');
      let imported: ImportedAccess;
      try {
        const firestore = await target(current.projectId);
        const documents = await read(firestore);
        imported = importable(documents.teams, documents.access, documents.admins);
      } catch (error) { throw new WebsiteAccessError(400, failure(error)); }
      const counts = await rpc('mcp_website_import', { member, workspace, project_name: name, imported });
      return { imported: counts, state: await afterChange(member, workspace, name) };
    },
    /** Create or update a workspace team: the environments it reads and the content it sees. */
    async saveTeam(member: string, workspace: string, input: unknown) {
      const team = teamInput.safeParse(input);
      if (!team.success) throw new WebsiteAccessError(400, 'Give the team a name (up to 80 characters), valid environments and content.');
      await rpc('mcp_workspace_team_save', { member, workspace, team: team.data.id ?? null, team_name: team.data.name,
        team_envs: team.data.environments, team_reader: team.data.reader, team_role: team.data.role });
      return { syncErrors: await resyncWorkspace(workspace) };
    },
    async deleteTeam(member: string, workspace: string, team: string) {
      if (!z.string().uuid().safeParse(team).success) throw new WebsiteAccessError(400, 'Unknown team.');
      await rpc('mcp_workspace_team_delete', { member, workspace, team });
      return { syncErrors: await resyncWorkspace(workspace) };
    },
    /** A member's website access (none, reader or admin) and team, on every managed project's website. */
    async setWebsite(member: string, workspace: string, input: unknown) {
      const person = websiteInput.safeParse(input);
      if (!person.success) throw new WebsiteAccessError(400, person.error.issues[0]?.message ?? 'Choose website access and a team.');
      await rpc('mcp_member_website_set', { member, workspace, person_email: person.data.email, person_website: person.data.website, team: person.data.teamId });
      return { syncErrors: await resyncWorkspace(workspace) };
    },
    /** Add someone or move them to a team (or make them an owner): their team sets their role everywhere. */
    async setTeam(member: string, workspace: string, input: unknown) {
      const person = memberTeamInput.safeParse(input);
      if (!person.success) throw new WebsiteAccessError(400, person.error.issues[0]?.message ?? 'Choose a team.');
      await rpc('mcp_member_team_set', { member, workspace, person_email: person.data.email, team: person.data.owner ? null : person.data.teamId, as_owner: person.data.owner });
      return { syncErrors: await resyncWorkspace(workspace) };
    },
    async retry(member: string, workspace: string, name: string) {
      return afterChange(member, workspace, name);
    },
    resyncWorkspace
  };

  /** Copy the workspace's teams and access into every managed project; answers the failures, if any. */
  async function resyncWorkspace(workspace: string): Promise<string[]> {
    const projects = z.array(z.string().uuid()).safeParse(await rpc('mcp_website_managed_projects', { workspace }));
    if (!projects.success) return [];
    const problems: string[] = [];
    for (const project of projects.data) {
      const problem = await sync(project);
      if (problem) problems.push(problem);
    }
    return problems;
  }
}
