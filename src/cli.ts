import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFirestoreWriter, serviceAccountKey, serviceAccountTokens, type FirestoreWrite } from './firestore.js';
import { createManagedDocumentation, readDocumentationEncryptionKey } from './managed-documentation.js';
import { buildTransferFile, keyMap, reencryptProject, transferFile } from './project-transfer.js';
import { projectEntry, readSelfHostedConfig, serviceAccountJson, writeProjectsFile, type ProjectEntry, type SelfHostedConfig } from './self-hosted.js';

const HELP = `Documentation Workflow MCP: self-hosting commands

Setup
  init --owner <email>                     Create projects.json and .env with fresh secrets (never overwrites).
  project add --name <name> --firebase <firebase-project-id> --key <service-account.json>
              [--envs development,beta,production] [--site <https://site-origin>[,http://localhost:4173]]
                                           Add a documentation project. --site creates the website token.
  project list                             List projects.
  site-config --project <name> --url <https://your-mcp-url>
                                           Print the docs-site configuration for encrypted (v3) documentation.

Reader access (written to the project's own Firestore)
  team add <team> --project <name> [--envs development,beta] [--reader support|testers|...]
  team list --project <name>
  team remove <team> --project <name>
  access add <email> --project <name> --team <team>
  access admin <email> --project <name>     Website administrator: every environment.
  access remove <email> --project <name>    Removes reader and administrator access.
  access list --project <name>

Moving projects
  export --project <name> [--out <file>]    Write a move file (project + content keys, never the master key).
  import <file> --key <service-account.json> [--site <https://site-origin>] [--reencrypt]
                                           Add a project exported from the hosted dashboard or another server.
                                           --reencrypt re-encrypts every environment with this server's key now.

Run with:  npm run cli -- <command>     (reads .env from this folder)`;

const argv = process.argv.slice(2);
const option = (name: string) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name: string) => argv.includes('--' + name);
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !(argv[i - 1]?.startsWith('--') && !['reencrypt'].includes(argv[i - 1]!.slice(2))));
const fail = (message: string): never => { console.error(message); process.exit(1); };
const need = (name: string) => option(name) ?? fail('Missing --' + name + '.\n\n' + HELP);
const ENVIRONMENTS = ['development', 'beta', 'production'] as const;
const READERS = ['end-users', 'support', 'testers', 'product-owners', 'administrators', 'developers', 'internal'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function config(): SelfHostedConfig {
  const loaded = readSelfHostedConfig();
  if (!loaded) fail('No projects.json here. Run: npm run cli -- init --owner you@example.com');
  if (!loaded!.path) fail('Projects come from MCP_PROJECTS_JSON, which this tool cannot edit. Edit the variable instead.');
  return loaded!;
}
function project(cfg: SelfHostedConfig, name = need('project')): ProjectEntry {
  return cfg.file.projects.find(item => item.name.toLowerCase() === name.toLowerCase()) ?? fail('No project called "' + name + '" in projects.json.');
}
function environmentsOf(value: string | undefined): ProjectEntry['environments'] {
  if (!value) return [...ENVIRONMENTS];
  const list = value.split(',').map(item => item.trim()).filter(Boolean);
  for (const item of list) if (!ENVIRONMENTS.includes(item as never)) fail('Unknown environment "' + item + '". Use development, beta or production.');
  return list as ProjectEntry['environments'];
}
function writer(cfg: SelfHostedConfig, entry: ProjectEntry) {
  return createFirestoreWriter(entry.firebaseProject, serviceAccountTokens(serviceAccountJson(cfg, entry)));
}
async function teamsOf(cfg: SelfHostedConfig, entry: ProjectEntry) {
  return (await writer(cfg, entry).list('teams')).map(doc => ({ id: doc.id, name: String(doc.data.name ?? ''), data: doc.data }));
}
function checkKeyFile(path: string, firebase?: string) {
  if (!existsSync(path)) fail('Service-account key not found: ' + path);
  let key;
  try { key = serviceAccountKey.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return fail(path + ' is not a Firebase service-account JSON key (Firebase console > Project settings > Service accounts).'); }
  if (firebase && key.project_id !== firebase) fail('That key belongs to ' + key.project_id + ', not ' + firebase + '.');
  return key;
}

async function main() {
  const [command, sub] = positional;
  if (!command || flag('help') || command === 'help') { console.log(HELP); return; }

  if (command === 'init') {
    const owner = need('owner');
    if (!EMAIL.test(owner)) fail('--owner must be an email address.');
    const projectsPath = resolve(process.env.MCP_PROJECTS_FILE ?? 'projects.json');
    if (existsSync(projectsPath)) console.log('projects.json already exists: left unchanged.');
    else { writeProjectsFile(projectsPath, { owner, projects: [] }); console.log('Created ' + projectsPath); }
    const envPath = resolve('.env');
    if (existsSync(envPath)) console.log('.env already exists: left unchanged. Compare it with .env.example.');
    else {
      const secret = () => randomBytes(32).toString('hex');
      writeFileSync(envPath, [
        '# Created by "npm run cli -- init". Keep this file private and back it up.',
        'MCP_BEARER_TOKEN=' + secret(),
        'MCP_VALIDATION_SIGNING_KEY=' + secret(),
        '# Losing this key makes encrypted documentation unreadable. Back it up outside this folder.',
        'MCP_DOCUMENTATION_ENCRYPTION_KEY=' + randomBytes(32).toString('base64url'),
        '# Optional: answers for Orbit (reader questions) and issue write-ups.',
        'GEMINI_API_KEY=',
        'GROQ_API_KEY=',
        ''
      ].join('\n'), { mode: 0o600 });
      console.log('Created .env with a new bearer token, signing key and encryption key. Back up MCP_DOCUMENTATION_ENCRYPTION_KEY now.');
    }
    return;
  }

  if (command === 'project' && sub === 'add') {
    const cfg = config();
    const name = need('name'); const firebase = need('firebase'); const keyPath = need('key');
    checkKeyFile(resolve(keyPath), firebase);
    if (cfg.file.projects.some(item => item.name.toLowerCase() === name.toLowerCase())) fail('A project called "' + name + '" already exists.');
    const site = option('site');
    const entry = projectEntry.parse({
      id: randomUUID(), name, firebaseProject: firebase, serviceAccountKeyFile: keyPath, environments: environmentsOf(option('envs')),
      ...(site ? { site: { token: 'dsite_' + randomBytes(32).toString('base64url'), origins: [...new Set(site.split(',').map(origin => new URL(origin.trim()).origin))] } } : {})
    });
    cfg.file.projects.push(entry);
    writeProjectsFile(cfg.path!, cfg.file);
    console.log('Added "' + name + '" (' + entry.id + '). Restart the MCP to load it.');
    return;
  }
  if (command === 'project' && sub === 'list') {
    for (const entry of config().file.projects) console.log(entry.name + '  firebase=' + entry.firebaseProject + '  envs=' + entry.environments.join(',') + (entry.site ? '  site=' + entry.site.origins.join(',') : ''));
    return;
  }
  if (command === 'site-config') {
    const entry = project(config());
    const url = new URL(need('url')).origin;
    if (!entry.site) fail('This project has no website token. Add "site" to it in projects.json, or re-add it with --site.');
    console.log(`// assets/js/site-config.js in your docs-site copy
window.DOCS_SITE_CONFIG = {
  projectName: ${JSON.stringify(entry.name)},
  documentation: { format: 3, api: ${JSON.stringify(url)}, project: ${JSON.stringify(entry.name)}, siteToken: ${JSON.stringify(entry.site!.token)} }
};`);
    return;
  }

  if (command === 'team') {
    const cfg = config(); const entry = project(cfg);
    const teams = await teamsOf(cfg, entry);
    if (sub === 'list') {
      for (const team of teams) console.log(team.name + '  envs=' + (Array.isArray(team.data.environments) ? team.data.environments.join(',') : 'all') + (team.data.reader ? '  reader=' + team.data.reader : ''));
      return;
    }
    const name = positional[2] ?? fail('Give the team name.');
    const existing = teams.find(team => team.name.toLowerCase() === name.toLowerCase());
    if (sub === 'add') {
      const reader = option('reader');
      if (reader && !READERS.includes(reader)) fail('--reader must be one of: ' + READERS.join(', '));
      const fields: Record<string, string | string[]> = { name };
      if (option('envs')) fields.environments = environmentsOf(option('envs'));
      if (reader) fields.reader = reader;
      await writer(cfg, entry).commit([{ set: 'teams/' + (existing?.id ?? randomUUID()), fields, stamp: 'updatedAt' }]);
      console.log((existing ? 'Updated' : 'Created') + ' team "' + name + '".');
      return;
    }
    if (sub === 'remove') {
      if (!existing) fail('No team called "' + name + '".');
      await writer(cfg, entry).commit([{ delete: 'teams/' + existing!.id }]);
      console.log('Removed team "' + name + '". Its members can no longer read until moved to another team.');
      return;
    }
  }

  if (command === 'access') {
    const cfg = config(); const entry = project(cfg);
    const firestore = writer(cfg, entry);
    if (sub === 'list') {
      const [teams, readers, admins] = await Promise.all([teamsOf(cfg, entry), firestore.list('feedbackAccess'), firestore.list('adminAccess')]);
      for (const admin of admins.filter(doc => doc.data.enabled === true)) console.log(admin.id + '  administrator');
      for (const reader of readers.filter(doc => doc.data.enabled === true)) {
        console.log(reader.id + '  team=' + (teams.find(team => team.id === reader.data.teamId)?.name ?? '(none: cannot read)'));
      }
      return;
    }
    const email = (positional[2] ?? fail('Give the email address.')).toLowerCase();
    if (!EMAIL.test(email)) fail('"' + email + '" is not an email address.');
    let writes: FirestoreWrite[];
    if (sub === 'add') {
      const teamName = need('team');
      const team = (await teamsOf(cfg, entry)).find(item => item.name.toLowerCase() === teamName.toLowerCase()) ?? fail('No team called "' + teamName + '". Create it with: team add');
      writes = [{ set: 'feedbackAccess/' + email, fields: { enabled: true, teamId: team.id }, stamp: 'updatedAt' }];
    } else if (sub === 'admin') {
      writes = [{ set: 'adminAccess/' + email, fields: { enabled: true } }, { set: 'feedbackAccess/' + email, fields: { enabled: true }, stamp: 'updatedAt' }];
    } else if (sub === 'remove') {
      writes = [{ delete: 'feedbackAccess/' + email }, { delete: 'adminAccess/' + email }];
    } else return fail(HELP);
    await firestore.commit(writes);
    console.log('Done. ' + email + (sub === 'remove' ? ' can no longer sign in to the documentation website.' : ' can sign in with Google on the documentation website.'));
    return;
  }

  if (command === 'export') {
    const cfg = config(); const entry = project(cfg);
    const masterKey = readDocumentationEncryptionKey();
    const access = { projectId: entry.id, firebaseProject: entry.firebaseProject, serviceAccountKey: serviceAccountJson(cfg, entry),
      environments: entry.environments, role: 'owner' as const };
    const keys = masterKey ? await createManagedDocumentation(access, { masterKey }).exportKeys() : [];
    const file = buildTransferFile('self-hosted', { id: entry.id, name: entry.name, firebaseProject: entry.firebaseProject,
      environments: entry.environments, settings: entry.settings }, keys);
    const out = resolve(option('out') ?? entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-export.json');
    writeFileSync(out, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    console.log('Wrote ' + out + ' with ' + keys.length + ' content key(s). It opens this project\'s encrypted documentation: keep it private and delete it after the move.');
    return;
  }

  if (command === 'import') {
    const cfg = config();
    const path = positional[1] ?? fail('Give the export file.');
    const parsed = transferFile.safeParse(JSON.parse(readFileSync(resolve(path), 'utf8')));
    if (!parsed.success) fail(path + ' is not a Documentation Workflow move file.');
    const file = parsed.data!;
    const keyPath = need('key');
    checkKeyFile(resolve(keyPath), file.project.firebaseProject);
    if (cfg.file.projects.some(item => item.id === file.project.id || item.name.toLowerCase() === file.project.name.toLowerCase())) {
      fail('A project with this ID or name is already in projects.json.');
    }
    const entry = projectEntry.parse({ id: file.project.id, name: file.project.name, firebaseProject: file.project.firebaseProject,
      environments: file.project.environments, settings: file.project.settings, serviceAccountKeyFile: keyPath, importedKeys: keyMap(file.keys),
      ...(option('site') ? { site: { token: 'dsite_' + randomBytes(32).toString('base64url'),
        origins: [...new Set(option('site')!.split(',').map(origin => new URL(origin.trim()).origin))] } } : {}) });
    cfg.file.projects.push(entry);
    writeProjectsFile(cfg.path!, cfg.file);
    console.log('Imported "' + entry.name + '" with ' + file.keys.length + ' content key(s).');
    if (flag('reencrypt') && file.keys.length) {
      const masterKey = readDocumentationEncryptionKey() ?? fail('Set MCP_DOCUMENTATION_ENCRYPTION_KEY in .env first.');
      const result = await reencryptProject({ projectId: entry.id, firebaseProject: entry.firebaseProject, serviceAccountKey: serviceAccountJson(cfg, entry),
        environments: entry.environments, role: 'owner' }, file.keys, { masterKey, actor: cfg.file.owner });
      for (const item of result.moved) console.log('  ' + item.environment + ': re-encrypted with this server\'s key.');
      for (const item of result.skipped) console.log('  ' + item.environment + ': ' + item.reason);
    } else if (file.keys.length) {
      console.log('The next publication in each environment switches to this server\'s key automatically.');
    }
    console.log('Next: point the docs-site and your AI at this server (see the README, "Move a project here").');
    return;
  }
  fail(HELP);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
