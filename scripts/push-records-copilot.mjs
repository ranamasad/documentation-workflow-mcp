// Send documentation record files from disk to the hosted documentation-workflow MCP server,
// so the AI host never has to paste record bodies into tool calls.
//
// Usage:
//   DMCP_TOKEN=dup_... node scripts/push-records.mjs validate <dir> [key ...]
//   DMCP_TOKEN=dup_... node scripts/push-records.mjs snapshot <dir>
//   DMCP_TOKEN=dup_... node scripts/push-records.mjs stage <dir> --project "<name>" --environment development [--draft <uuid>]
//
// DMCP_TOKEN is an upload ticket from the create_upload_ticket MCP tool: the AI host gets it through the
// user's own sign-in and passes it in the environment. It lasts at most 2 hours and opens only the
// validation and staging tools, so this script can never publish.
//
// <dir> holds foundation.json plus one <section>__<id>.json record per article.
// validate: checks each article alone with a foundation trimmed to its navigation entry and
//   writes <dir>/report.json ({key: {ok, issues, token}}) so only the issues need reading.
// snapshot: validate_documentation_snapshot with the full foundation and every saved receipt token.
// stage: stage_documentation in parts of 25 records (foundation first) and prints the draftId.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PART_RECORDS = 25;
const url = process.env.DMCP_URL ?? 'http://127.0.0.1:4318/mcp';
const token = process.env.DMCP_TOKEN;
const [command, dir, ...rest] = process.argv.slice(2);
if (!token || !command || !dir) {
  console.error('Usage: DMCP_TOKEN=<upload ticket> node scripts/push-records.mjs <validate|snapshot|stage> <dir> [options]');
  process.exit(2);
}

const option = name => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
const keysArg = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
// --report <file>: write results there instead of <dir>/report.json (one per parallel writer).

const read = file => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const foundation = read('foundation.json');
const articles = readdirSync(dir).filter(f => f.endsWith('.json') && f.includes('__')).map(read);
const reportFile = option('report') ?? join(dir, 'report.json');
const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};

const client = new Client({ name: 'push-records', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: 'Bearer ' + token } }
}));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find(c => c.type === 'text')?.text ?? '{}';
  try { return JSON.parse(text); } catch { return { error: text }; }
}
const trimmed = keys => ({ ...foundation, data: { ...foundation.data, navigation: { ...foundation.data.navigation,
  entries: foundation.data.navigation.entries.filter(e => keys.includes(e.key)) } } });

try {
  if (command === 'validate') {
    const todo = articles.filter(a => keysArg.length ? keysArg.includes(a.key) : !report[a.key]?.ok);
    for (const article of todo) {
      // The server accepts a link only when the linked article is in the same call, so send the linked
      // articles that exist on disk as context; only this article's own issues and receipt are used.
      const links = record => [...JSON.stringify(record).matchAll(/#\/([a-z0-9-]+\/[a-z0-9-]+)/g)].map(m => m[1]);
      const context = articles.filter(a => a.key !== article.key && links(article).includes(a.key));
      const result = await call('validate_documentation', { records: [trimmed([article.key, ...links(article), ...context.flatMap(links)]), article, ...context] });
      const issues = [...(result.errors ?? []), ...(result.issues ?? []), ...(result.quality?.issues ?? [])]
        .filter(i => !i.key || i.key === article.key)
        // links to articles outside this one-record batch are expected with a trimmed navigation
        .filter(i => !(i.code === 'BROKEN_LINK' && foundation.data.navigation.entries.some(e => (i.message ?? '').includes(e.key))));
      if (process.env.DMCP_DEBUG) console.log(JSON.stringify({ errors: result.errors, issues: result.issues, quality: result.quality?.issues }).slice(0, 3000));
      const receipt = result.receipts?.find(r => r.key === article.key)?.token;
      report[article.key] = { ok: Boolean(receipt) && issues.length === 0, issues, token: receipt };
      writeFileSync(reportFile, JSON.stringify(report, null, 1));
      console.log((report[article.key].ok ? 'ok   ' : 'FAIL ') + article.key + (issues.length ? ' (' + issues.length + ' issues)' : ''));
    }
    const failed = Object.entries(report).filter(([, r]) => !r.ok).map(([k]) => k);
    console.log(`\n${Object.keys(report).length - failed.length} ok, ${failed.length} failing. Details: ${reportFile}`);
  } else if (command === 'snapshot') {
    // Merge every report-*.json too, so parallel writers can each keep their own report.
    for (const file of readdirSync(dir).filter(f => /^report.*\.json$/.test(f))) Object.assign(report, JSON.parse(readFileSync(join(dir, file), 'utf8')));
    const receipts = articles.map(a => report[a.key]?.token).filter(Boolean);
    const missing = articles.filter(a => !report[a.key]?.token).map(a => a.key);
    if (missing.length) console.log('No receipt yet (validate first): ' + missing.join(', '));
    console.log(JSON.stringify(await call('validate_documentation_snapshot', { foundation, receipts }), null, 1));
  } else if (command === 'stage') {
    const project = option('project'), environment = option('environment');
    if (!project || !environment) throw new Error('stage needs --project and --environment');
    let draftId = option('draft');
    const records = [foundation, ...articles];
    for (let part = 1; part * PART_RECORDS - PART_RECORDS < records.length; part++) {
      const slice = records.slice((part - 1) * PART_RECORDS, part * PART_RECORDS);
      const result = await call('stage_documentation', { project, environment, part, records: slice, ...(draftId ? { draftId } : {}) });
      if (result.error) throw new Error(`part ${part}: ${JSON.stringify(result)}`);
      draftId ??= result.draftId;
      console.log(`staged part ${part} (${slice.length} records)`);
    }
    console.log('draftId: ' + draftId);
  } else {
    throw new Error('Unknown command ' + command);
  }
} finally {
  await client.close();
}
