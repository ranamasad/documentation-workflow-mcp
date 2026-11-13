import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { DraftStore, NotesStore, ProjectStore, SavedProject } from './project-store.js';
import { createFirestoreReader, serviceAccountKey, serviceAccountTokens } from './firestore.js';
import { DocumentationV3Error, v3Access, type V3Access, type v3Request } from './documentation-v3.js';
import { registerImportedDataKeys, registerImportedKeys } from './managed-documentation.js';
import { transferDataKey } from './project-transfer.js';
import { createIssues } from './issues.js';

/**
 * Self-hosted mode: one owner runs this MCP for their own projects without the hosted dashboard.
 * Projects come from projects.json (or the MCP_PROJECTS_JSON environment variable on serverless hosts).
 * Whoever holds MCP_BEARER_TOKEN is the owner of every listed project. Readers of the documentation website
 * are managed in the project's own Firestore (teams, feedbackAccess, adminAccess), exactly as on the hosted service.
 */
export const LOCAL_USER = '00000000-0000-4000-8000-000000000001';
export const LOCAL_WORKSPACE = '00000000-0000-4000-8000-000000000002';
const environments = ['development', 'beta', 'production'] as const;
const environment = z.enum(environments);

export const projectEntry = z.strictObject({
  id: z.uuid().describe('Stable project ID. It is part of every encryption scope: never change it after publishing.'),
  name: z.string().trim().min(1).max(120),
  firebaseProject: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  environments: z.array(environment).min(1).max(3).default([...environments]),
  serviceAccountKeyFile: z.string().min(1).optional(),
  serviceAccountKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  site: z.strictObject({
    token: z.string().regex(/^dsite_[A-Za-z0-9_-]{43}$/),
    origins: z.array(z.string().url()).min(1).max(10)
  }).optional(),
  importedKeys: z.record(z.uuid(), z.string().regex(/^[A-Za-z0-9_-]{43}$/)).default({}),
  // Keys for issues, attachments and reader feedback written before the project moved here.
  importedDataKeys: z.array(transferDataKey).max(20).default([])
}).refine(project => project.serviceAccountKeyFile || project.serviceAccountKeyEnv, {
  message: 'Set serviceAccountKeyFile or serviceAccountKeyEnv for every project.'
});
export const projectsFile = z.strictObject({
  $schema: z.string().optional(),
  owner: z.string().email(),
  projects: z.array(projectEntry).max(100)
});
export type ProjectEntry = z.infer<typeof projectEntry>;
export type ProjectsFile = z.infer<typeof projectsFile>;

export interface SelfHostedConfig {
  file: ProjectsFile;
  /** projects.json on disk, or undefined when the projects came from MCP_PROJECTS_JSON (read-only). */
  path?: string;
  dataDir: string;
}

/** Load the projects, or undefined when this server runs without projects (guide and validation tools only). */
export function readSelfHostedConfig(env: NodeJS.ProcessEnv = process.env): SelfHostedConfig | undefined {
  const inline = env.MCP_PROJECTS_JSON;
  const path = resolve(env.MCP_PROJECTS_FILE ?? 'projects.json');
  let raw: string;
  if (inline) raw = inline;
  else if (existsSync(path)) raw = readFileSync(path, 'utf8');
  else if (env.MCP_PROJECTS_FILE) throw new Error('MCP_PROJECTS_FILE points to a missing file: ' + path);
  else return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error((inline ? 'MCP_PROJECTS_JSON' : path) + ' is not valid JSON.'); }
  const result = projectsFile.safeParse(parsed);
  if (!result.success) {
    throw new Error((inline ? 'MCP_PROJECTS_JSON' : path) + ' is invalid: ' +
      result.error.issues.map(issue => (issue.path.join('.') || 'file') + ': ' + issue.message).join('; '));
  }
  const ids = new Set<string>();
  for (const project of result.data.projects) {
    if (ids.has(project.id)) throw new Error('Two projects share the ID ' + project.id + '.');
    ids.add(project.id);
    if (Object.keys(project.importedKeys).length) registerImportedKeys(project.id, project.importedKeys);
    if (project.importedDataKeys.length) registerImportedDataKeys(project.id, project.importedDataKeys);
  }
  const base = inline ? process.cwd() : dirname(path);
  return { file: result.data, ...(inline ? {} : { path }), dataDir: resolve(base, env.MCP_DATA_DIR ?? '.mcp-data') };
}

export function writeProjectsFile(path: string, file: ProjectsFile): void {
  writeFileSync(path, JSON.stringify(projectsFile.parse(file), null, 2) + '\n', { mode: 0o600 });
}

/** The project's service-account key JSON, from its file (relative to projects.json) or environment variable. */
export function serviceAccountJson(config: SelfHostedConfig, project: ProjectEntry, env: NodeJS.ProcessEnv = process.env): string {
  let json: string | undefined;
  if (project.serviceAccountKeyEnv) json = env[project.serviceAccountKeyEnv];
  else if (project.serviceAccountKeyFile) {
    const file = isAbsolute(project.serviceAccountKeyFile) ? project.serviceAccountKeyFile
      : resolve(config.path ? dirname(config.path) : process.cwd(), project.serviceAccountKeyFile);
    if (!existsSync(file)) throw new DocumentationV3Error(400, 'The service-account key file for "' + project.name + '" is missing: ' + file);
    json = readFileSync(file, 'utf8');
  }
  if (!json) throw new DocumentationV3Error(400, 'No service-account key is configured for "' + project.name + '".');
  let key;
  try { key = serviceAccountKey.parse(JSON.parse(json)); }
  catch { throw new DocumentationV3Error(400, 'The service-account key for "' + project.name + '" is not a Firebase service-account JSON key.'); }
  if (key.project_id !== project.firebaseProject) {
    throw new DocumentationV3Error(400, 'The service-account key for "' + project.name + '" belongs to ' + key.project_id + ', not ' + project.firebaseProject + '.');
  }
  return json;
}

const sameValue = (a: string, b: string) => {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
};

export function createSelfHosted(config: SelfHostedConfig, options: { fetchService?: typeof fetch; firebaseKeys?: JWTVerifyGetKey; masterKey?: string } = {}) {
  const fetchService = options.fetchService ?? fetch;
  const firebaseKeys = options.firebaseKeys ?? createRemoteJWKSet(
    new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'), { timeoutDuration: 5000 });
  const started = new Date().toISOString();
  const owner = config.file.owner.toLowerCase();

  const find = (name: string) => {
    const project = config.file.projects.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (!project) throw new DocumentationV3Error(404, 'There is no project called "' + name + '" in projects.json.');
    return project;
  };
  const ownerAccess = (project: ProjectEntry): V3Access => v3Access.parse({
    projectId: project.id, name: project.name, role: 'owner', environments: project.environments,
    userId: LOCAL_USER, email: owner, administrator: true, firebaseProject: project.firebaseProject,
    serviceAccountKey: serviceAccountJson(config, project)
  });

  // Stands in for the hosted database functions the shared modules call (issues, Orbit, encrypted documentation).
  async function rpc(name: string, body: unknown): Promise<unknown> {
    const input = (body ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'mcp_v3_access': return ownerAccess(find(String(input.project_name ?? '')));
      case 'mcp_issue_ai_key': return process.env.GEMINI_API_KEY || null;
      case 'mcp_issue_groq_key': return process.env.GROQ_API_KEY || null;
      case 'mcp_issue_team_emails': return [];
      case 'mcp_issue_people': return [{ email: owner, name: null }];
      case 'mcp_issue_assignees': return [owner];
      default: throw new DocumentationV3Error(501, 'This feature needs the hosted dashboard and is not part of self-hosting (' + name + ').');
    }
  }
  const issues = createIssues({ rpc, fetchService, masterKey: options.masterKey });

  const saved = (project: ProjectEntry): SavedProject => ({
    name: project.name,
    settings: { ...project.settings, firebaseProject: project.firebaseProject, environments: project.environments },
    updatedAt: started, lastUsedAt: started,
    workspace: { id: LOCAL_WORKSPACE, name: 'Self-hosted', role: 'owner' }
  });

  const drafts = fileDrafts(join(config.dataDir, 'drafts'));
  const notes = fileNotes(join(config.dataDir, 'notes'));
  const projects: ProjectStore = {
    async list() { return config.file.projects.map(saved); },
    async save(name, settings) {
      const project = find(name);
      project.settings = settings;
      if (config.path) writeProjectsFile(config.path, config.file);
      return saved(project);
    },
    async forget() {
      throw new DocumentationV3Error(400, 'Projects are listed in projects.json. Remove the project there to forget it.');
    },
    async readAccess(name) {
      const project = find(name);
      return { projectId: project.id, name: project.name, role: 'owner', firebaseProject: project.firebaseProject, firebaseApiKey: null,
        environments: project.environments, mode: 'service-account', serviceAccountKey: serviceAccountJson(config, project), personalRefreshToken: null };
    },
    async memberEmail() { return owner; },
    issues: name => issues.member(LOCAL_USER, undefined, name),
    drafts, notes
  };

  /** Readers of a self-hosted documentation website: verified Google sign-in, then the project's own Firestore decides. */
  async function websiteReader(req: IncomingMessage, siteToken: string, idToken: string | undefined): Promise<V3Access> {
    const project = config.file.projects.find(item => item.site && sameValue(item.site.token, siteToken));
    const origin = req.headers.origin;
    if (!project || !origin || !project.site!.origins.includes(origin)) throw new DocumentationV3Error(403, 'Site access denied.');
    if (!idToken) throw new DocumentationV3Error(401, 'Sign in to read encrypted documentation.');
    let user;
    try {
      ({ payload: user } = await jwtVerify(idToken, firebaseKeys, { issuer: 'https://securetoken.google.com/' + project.firebaseProject,
        audience: project.firebaseProject, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'] }));
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || error instanceof TypeError) throw new DocumentationV3Error(503, 'Sign-in verification unavailable.');
      if (error instanceof errors.JOSEError) throw new DocumentationV3Error(401, 'Sign-in could not be verified.');
      throw error;
    }
    const firebase = user.firebase as { sign_in_provider?: unknown } | undefined;
    if (!user.sub || user.sub.length > 128 || user.email_verified !== true || typeof user.email !== 'string' ||
        firebase?.sign_in_provider !== 'google.com') throw new DocumentationV3Error(401, 'A verified Google sign-in is required.');
    const email = user.email.toLowerCase();
    const key = serviceAccountJson(config, project);
    const reader = createFirestoreReader(project.firebaseProject, serviceAccountTokens(key, fetchService), fetchService);
    const [admin, member] = await Promise.all([reader.get('adminAccess/' + email, { fresh: true }), reader.get('feedbackAccess/' + email, { fresh: true })]);
    const administrator = admin?.data.enabled === true;
    let allowed: string[] = project.environments;
    let team: { name?: unknown; reader?: unknown } | undefined;
    if (!administrator) {
      const teamId = member?.data.enabled === true && typeof member.data.teamId === 'string' ? member.data.teamId : '';
      const stored = teamId ? await reader.get('teams/' + teamId, { fresh: true }) : null;
      if (!stored) throw new DocumentationV3Error(403, 'Website membership required.');
      team = stored.data;
      if (Array.isArray(stored.data.environments)) allowed = allowed.filter(item => (stored.data.environments as unknown[]).includes(item));
    }
    const readerType = typeof member?.data.reader === 'string' ? member.data.reader : typeof team?.reader === 'string' ? team.reader : null;
    return v3Access.parse({
      projectId: project.id, name: project.name, role: administrator ? 'admin' : 'none', environments: allowed,
      userId: null, email, administrator, team: typeof team?.name === 'string' ? team.name.slice(0, 80) : null,
      reader: administrator ? null : readerType, firebaseProject: project.firebaseProject, serviceAccountKey: key,
      readerUid: user.sub, displayName: typeof user.name === 'string' ? user.name.slice(0, 256) : ''
    });
  }

  return {
    projects, rpc, issues,
    /** /api/documentation-v3: website readers (site token plus Firebase sign-in) or the owner's bearer token. */
    async v3Authenticate(req: IncomingMessage, _res: ServerResponse, input: z.infer<typeof v3Request>, ownerAuthorized: boolean) {
      if (input.siteToken) return websiteReader(req, input.siteToken, input.idToken);
      if (!ownerAuthorized) throw new DocumentationV3Error(401, 'Provide the MCP bearer token.');
      if (input.action.startsWith('vault.')) throw new DocumentationV3Error(501, 'Personal-key vaults are not part of self-hosting.');
      if (!input.project) throw new DocumentationV3Error(400, 'Choose a project.');
      return ownerAccess(find(input.project));
    },
    async v3Preflight(req: IncomingMessage): Promise<string | null> {
      const origin = req.headers.origin;
      if (!origin || req.headers['access-control-request-method'] !== 'POST') return null;
      return config.file.projects.some(project => project.site?.origins.includes(origin)) ? origin : null;
    },
    siteOrigins(): string[] { return config.file.projects.flatMap(project => project.site?.origins ?? []); }
  };
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const safeName = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Large documentation staged in parts, kept on disk for 24 hours (payloads arrive sealed). */
function fileDrafts(root: string): DraftStore {
  const folder = (id: string) => join(root, safeName(id));
  const sweep = () => {
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (Date.now() - statSync(path).mtimeMs > DRAFT_TTL_MS) rmSync(path, { recursive: true, force: true });
    }
  };
  const meta = z.object({ project: z.string(), environment: environment, parts: z.array(z.object({ part: z.number().int(), records: z.number().int() })) });
  return {
    async put(name, _workspace, draft) {
      sweep();
      const dir = folder(draft.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const metaPath = join(dir, 'draft.json');
      const current = existsSync(metaPath) ? meta.parse(JSON.parse(readFileSync(metaPath, 'utf8'))) : { project: name, environment: draft.environment, parts: [] };
      if (current.project.toLowerCase() !== name.toLowerCase() || current.environment !== draft.environment) {
        throw new DocumentationV3Error(409, 'This draft belongs to another project or environment.');
      }
      writeFileSync(join(dir, 'part-' + draft.part + '.txt'), draft.payload, { mode: 0o600 });
      const parts = [...current.parts.filter(part => part.part !== draft.part), { part: draft.part, records: draft.records }].sort((a, b) => a.part - b.part);
      writeFileSync(metaPath, JSON.stringify({ ...current, parts }), { mode: 0o600 });
      return { environment: current.environment, parts };
    },
    async read(name, _workspace, id) {
      sweep();
      const metaPath = join(folder(id), 'draft.json');
      if (!existsSync(metaPath)) throw new DocumentationV3Error(404, 'This draft does not exist or expired after 24 hours. Stage it again.');
      const current = meta.parse(JSON.parse(readFileSync(metaPath, 'utf8')));
      if (current.project.toLowerCase() !== name.toLowerCase()) throw new DocumentationV3Error(404, 'This draft belongs to another project.');
      return { environment: current.environment,
        parts: current.parts.map(part => ({ part: part.part, payload: readFileSync(join(folder(id), 'part-' + part.part + '.txt'), 'utf8') })) };
    },
    async remove(id) { rmSync(folder(id), { recursive: true, force: true }); }
  };
}

/** Code notes per project area, kept on disk (payloads arrive sealed). */
function fileNotes(root: string): NotesStore {
  const file = (name: string, area: string) => join(root, safeName(name.toLowerCase()), safeName(area) + '.json');
  const entry = z.object({ area: z.string(), payload: z.string(), files: z.record(z.string(), z.string()), updatedAt: z.string() });
  const list = (name: string) => {
    const dir = join(root, safeName(name.toLowerCase()));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map(item => entry.parse(JSON.parse(readFileSync(join(dir, item), 'utf8'))))
      .map(note => ({ area: note.area, files: Object.keys(note.files).length, updatedAt: note.updatedAt }));
  };
  return {
    async put(name, _workspace, notes) {
      const path = file(name, notes.area);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify({ ...notes, updatedAt: new Date().toISOString() }), { mode: 0o600 });
      return list(name);
    },
    async read(name, _workspace, area) {
      const path = file(name, area);
      return existsSync(path) ? entry.parse(JSON.parse(readFileSync(path, 'utf8'))) : null;
    },
    async list(name) { return list(name); }
  };
}

export const newProjectId = () => randomUUID();
