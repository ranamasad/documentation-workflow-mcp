#!/usr/bin/env node
// push-records.mjs: send documentation record files to the documentation-workflow MCP server from disk,
// so an AI host never pastes record bodies into tool calls. Node 20+, no packages.
//
//   curl -fsSL <your MCP URL>/tools/push-records.mjs -o push-records.mjs
//   DMCP_TOKEN=<upload ticket> node push-records.mjs <command> <dir> [options]
//
// Get the ticket with the MCP tool create_upload_ticket (valid 2 hours; it opens only validation and
// staging and can never publish). <dir> holds foundation.json plus one <section>__<id>.json per article.
const HELP = `Commands:
  validate <dir> [key …]      Check articles one at a time (all failing or unchecked ones when no keys are given).
                              Links to any article in the foundation navigation count as existing.
                              Writes <dir>/report.json: {key: {ok, issues, token}}. Prints ok/FAIL per key.
  stage <dir> --project <name> --environment <env> [--draft <id>] [--keys <file>]
                              Stage the foundation and every article (25 per part). Prints the draftId.
                              With --draft and --keys, restages only the parts holding those keys.
  check <dir> --project <name> --environment <env> --draft <id> [--merge] [--version <version>]
                              validate_draft: check the staged draft on the server. Writes <dir>/draft-report.json.
                              --merge: the draft holds only changed articles; merge it into the published release
                              and check the whole site, as publication will.
                              --version: check the matching release-note entry and its explicit change scope.
  audit <dir> --project <name> --environment <env>
                              check_published: every current rule on what is published now. Writes <dir>/audit.json
                              (issues per article) and audit-keys.txt (one key per line) for planning a clean-up.
  snapshot <dir>              validate_documentation_snapshot with the foundation and every receipt in report.json.
  notes-push <dir> --project <name> [--area <a>] [--root <folder>]
                              Save code notes (only after the user agreed): <dir>/<area>/notes.md plus files.json
                              (path -> git blob hash), or read.txt (one source path per line, hashed here; paths are
                              stored relative to --root).
  notes-pull <dir> --project <name> [--area <a>]
                              Write the saved notes to <dir>/<area>/notes.md and files.json.
  changed <dir> --root <folder>
                              Compare each <dir>/<area>/files.json with the files under --root: prints changed, new
                              (in read.txt but not in files.json) and deleted files, so an update reads only those.
Options: --report <file> (validate), --url <mcp url> (default $DMCP_URL or http://127.0.0.1:4318/mcp).
Environment: DMCP_TOKEN (required), DMCP_DEBUG=1 prints raw validator issues.`;

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const PART_RECORDS = 25;
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exit(0); }
const [command, dirArg, ...rest] = argv;
const option = name => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const token = process.env.DMCP_TOKEN;
const url = option('url') ?? process.env.DMCP_URL ?? 'http://127.0.0.1:4318/mcp';
if (!token || !dirArg) { console.error('DMCP_TOKEN and <dir> are required.\n\n' + HELP); process.exit(2); }
const dir = resolve(dirArg);
if (command === 'audit') mkdirSync(dir, { recursive: true });

// Minimal MCP client: the server is stateless and answers JSON, so each call is one POST.
let nextId = 1;
async function rpc(method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + token, 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
  const body = await response.text();
  if (response.status === 401) throw new Error('Unauthorized: get a new upload ticket with create_upload_ticket.');
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body.startsWith('event:') || body.startsWith('data:') ? body.split('\n').find(l => l.startsWith('data:')).slice(5) : body);
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  return json.result;
}
async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = result?.content?.find(c => c.type === 'text')?.text ?? '{}';
  try { return JSON.parse(text); } catch { return { error: text }; }
}

const read = file => JSON.parse(readFileSync(join(dir, file), 'utf8'));
// "[3/24 13%] … ~1m 20s left" so the person and the AI can see how far a long upload is.
const started = Date.now();
const progress = (done, total, label) => {
  const elapsed = (Date.now() - started) / 1000, left = done ? Math.round(elapsed / done * (total - done)) : 0;
  const eta = done && total > done ? ' ~' + (left >= 60 ? Math.floor(left / 60) + 'm ' : '') + (left % 60) + 's left' : '';
  return '[' + done + '/' + total + ' ' + Math.round(done / total * 100) + '%] ' + label + eta;
};
const next = lines => console.log('\nNext:\n' + lines.map(line => '  ' + line).join('\n'));
const blobHash = file => { const body = readFileSync(file); return createHash('sha1').update('blob ' + body.length + '\0').update(body).digest('hex'); };
const areasIn = () => readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^[a-z0-9][a-z0-9-]{0,63}$/.test(e.name)).map(e => e.name)
  .filter(a => !option('area') || a === option('area'));
if (command === 'notes-push' || command === 'notes-pull' || command === 'changed') {
  const project = option('project'), root = option('root') ? resolve(option('root')) : undefined;
  if (command !== 'changed' && !project) throw new Error(command + ' needs --project');
  if (command === 'notes-pull') {
    const areas = option('area') ? [option('area')] : (await call('read_code_notes', { project })).areas?.map(a => a.area) ?? [];
    for (const area of areas) {
      const found = await call('read_code_notes', { project, area });
      if (!found.notes) { console.log('none ' + area); continue; }
      mkdirSync(join(dir, area), { recursive: true });
      writeFileSync(join(dir, area, 'notes.md'), found.notes);
      writeFileSync(join(dir, area, 'files.json'), JSON.stringify(found.files, null, 1));
      console.log('pulled ' + area + ' (' + Object.keys(found.files).length + ' files, saved ' + found.updatedAt + ')');
    }
  } else {
    for (const area of areasIn()) {
      const base = join(dir, area);
      if (!existsSync(join(base, 'notes.md'))) continue;
      const rel = path => root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
      const listed = existsSync(join(base, 'read.txt')) ? readFileSync(join(base, 'read.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [];
      if (command === 'changed') {
        if (!root) throw new Error('changed needs --root <folder that holds the repositories>');
        const saved = existsSync(join(base, 'files.json')) ? JSON.parse(readFileSync(join(base, 'files.json'), 'utf8')) : {};
        const changed = [], added = [], deleted = [];
        for (const [path, hash] of Object.entries(saved)) {
          const full = join(root, path);
          if (!existsSync(full)) deleted.push(path); else if (blobHash(full) !== hash) changed.push(path);
        }
        for (const path of listed.map(rel)) if (!(path in saved)) added.push(path);
        console.log(area + ': ' + changed.length + ' changed, ' + added.length + ' new, ' + deleted.length + ' deleted');
        for (const [label, list] of [['changed', changed], ['new', added], ['deleted', deleted]]) for (const path of list) console.log('  ' + label + ' ' + path);
        continue;
      }
      const files = existsSync(join(base, 'files.json')) ? JSON.parse(readFileSync(join(base, 'files.json'), 'utf8'))
        : Object.fromEntries(listed.filter(p => existsSync(p)).map(p => [rel(p), blobHash(p)]));
      const result = await call('save_code_notes', { project, area, notes: readFileSync(join(base, 'notes.md'), 'utf8'), files });
      console.log(progress(areasIn().indexOf(area) + 1, areasIn().length, result.error ? 'FAIL ' + area + ': ' + result.error : 'saved ' + area + ' (' + Object.keys(files).length + ' files)'));
    }
  }
  process.exit(0);
}
// audit needs no local files; every other command reads the folder's records.
const foundation = command === 'audit' && !existsSync(join(dir, 'foundation.json')) ? null : read('foundation.json');
const articleFiles = readdirSync(dir).filter(f => f.endsWith('.json') && f.includes('__'));
const articles = articleFiles.map(read);
const navKeys = foundation?.data?.navigation?.entries?.map(e => e.key) ?? [];
const trimmed = keys => ({ ...foundation, data: { ...foundation.data, navigation: { ...foundation.data.navigation,
  entries: foundation.data.navigation.entries.filter(e => keys.includes(e.key)) } } });

if (command === 'validate') {
  const reportFile = resolve(option('report') ?? join(dir, 'report.json'));
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};
  const todo = articles.filter(a => positional.length ? positional.includes(a.key) : !report[a.key]?.ok);
  for (const article of todo) {
    const result = await call('validate_documentation', { records: [trimmed([article.key]), article], existingKeys: navKeys.filter(k => k !== article.key) });
    if (process.env.DMCP_DEBUG) console.log(JSON.stringify({ errors: result.errors, quality: result.quality?.issues }).slice(0, 3000));
    const issues = [...(result.errors ?? []), ...(result.issues ?? []), ...(result.quality?.issues ?? [])].filter(i => !i.key || i.key === article.key);
    const receipt = result.receipts?.find(r => r.key === article.key)?.token;
    report[article.key] = { ok: Boolean(receipt) && issues.length === 0, issues, token: receipt };
    writeFileSync(reportFile, JSON.stringify(report, null, 1));
    console.log(progress(todo.indexOf(article) + 1, todo.length, (report[article.key].ok ? 'ok   ' : 'FAIL ') + article.key +
      (issues.length ? ' (' + issues.map(i => i.code).join(', ') + ')' : '')));
  }
  const failed = articles.filter(a => !report[a.key]?.ok).length;
  console.log(`\n${articles.length - failed} ok, ${failed} not ok. Issues: ${reportFile}`);
  next(failed ? ['Read only the issues in ' + reportFile + ', fix those articles, then run validate again (it re-checks only articles that are not ok).']
    : ['All articles pass. Stage them: node push-records.mjs stage ' + dirArg + ' --project "<name>" --environment <env>']);
} else if (command === 'stage' || command === 'check' || command === 'audit') {
  const project = option('project'), environment = option('environment');
  let draftId = option('draft');
  if (!project || !environment) throw new Error(command + ' needs --project and --environment');
  if (command === 'audit') {
    console.log('Checking everything published in ' + environment + ' against current rules (one call)…');
    const result = await call('check_published', { project, environment, limit: 500 });
    if (result.error) throw new Error(result.error);
    writeFileSync(join(dir, 'audit.json'), JSON.stringify(result, null, 1));
    const keys = result.allKeys ?? Object.keys(result.issues ?? {});
    writeFileSync(join(dir, 'audit-keys.txt'), keys.join('\n') + '\n');
    console.log(`${result.ok ? 'PASS' : 'ISSUES'}: ${result.records} records, ${result.articlesWithIssues} articles with issues ${JSON.stringify(result.issueCounts ?? {})}`);
    next(result.ok ? ['Nothing to fix.'] : ['Fix the articles in audit-keys.txt (details in audit.json), write them to a folder with foundation.json,',
      'stage only those (stage <folder> …), then: check <folder> … --draft <id> --merge']);
    process.exit(0);
  }
  if (command === 'check') {
    if (!draftId) throw new Error('check needs --draft <id>');
    const result = await call('validate_draft', { project, environment, draftId, ...(rest.includes('--merge') ? { mergePublished: true } : {}),
      ...(option('version') ? { publicationVersion: option('version') } : {}) });
    writeFileSync(join(dir, 'draft-report.json'), JSON.stringify(result, null, 1));
    console.log('Checking the whole draft on the server (one call; large drafts take up to a minute)…');
    console.log(result.error ? 'Error: ' + result.error : `${result.ok ? 'PASS' : 'FAIL'}: ${result.records} records, ${result.articlesWithIssues ?? 0} with issues. Details: ${join(dir, 'draft-report.json')}`);
    next(result.ok ? ['Show the user what will be published (environment, version, pages added/changed/removed) and ask for approval.',
      'After a clear yes: call the MCP tool publish_documentation with draftId ' + draftId + ' (expected from documentation_release_status).']
      : ['Fix the articles listed in draft-report.json, then restage only them: node push-records.mjs stage ' + dirArg + ' --project "' + project + '" --environment ' + environment + ' --draft ' + draftId + ' --keys <file with keys>',
        'Then run check again with the same --draft.']);
  } else {
    // Order is fixed (foundation, then files by name) so part numbers stay stable between runs.
    const records = [foundation, ...articleFiles.sort().map(read)];
    const only = option('keys') ? new Set(readFileSync(resolve(option('keys')), 'utf8').split(/\s+/).filter(Boolean)) : undefined;
    const parts = Math.ceil(records.length / PART_RECORDS);
    const sending = Array.from({ length: parts }, (_, i) => i + 1)
      .filter(part => !(draftId && only && !records.slice((part - 1) * PART_RECORDS, part * PART_RECORDS).some(r => only.has(r.key))));
    console.log('Staging ' + records.length + ' records in ' + sending.length + ' of ' + parts + ' parts (25 records each)…');
    for (let part = 1; part <= parts; part++) {
      const slice = records.slice((part - 1) * PART_RECORDS, part * PART_RECORDS);
      if (!sending.includes(part)) continue;
      const result = await call('stage_documentation', { project, environment, part, records: slice, ...(draftId ? { draftId } : {}) });
      if (result.error || !result.draftId) throw new Error(`part ${part}: ${JSON.stringify(result).slice(0, 500)}`);
      draftId ??= result.draftId;
      console.log(progress(sending.indexOf(part) + 1, sending.length, `staged part ${part} (${slice.length} records)`));
    }
    console.log('draftId: ' + draftId);
    next(['Check the whole draft: node push-records.mjs check ' + dirArg + ' --project "' + project + '" --environment ' + environment + ' --draft ' + draftId,
      'The draft expires 24 hours after its last part.']);
  }
} else if (command === 'snapshot') {
  const report = existsSync(join(dir, 'report.json')) ? JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) : {};
  const receipts = articles.map(a => report[a.key]?.token).filter(Boolean);
  const missing = articles.filter(a => !report[a.key]?.token).map(a => a.key);
  if (missing.length) console.log('No receipt yet (validate first): ' + missing.join(', '));
  console.log(JSON.stringify(await call('validate_documentation_snapshot', { foundation, receipts }), null, 1));
} else {
  console.error('Unknown command ' + command + '\n\n' + HELP);
  process.exit(2);
}
