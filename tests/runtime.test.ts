import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { authorized, readHttpConfig, trustedHost } from '../src/config.js';
import { createHttpHandler, MAX_BODY_BYTES, type HttpRequest } from '../src/http.js';
import { analysisGuide, InvalidPromotionError, publicationChecklist, workflowPlan, workflows } from '../src/workflows.js';

const token = 'test-only-0123456789abcdef0123456789abcdef';
const signingKey = 'test-private-validation-key-0123456789abcdef0123456789';
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const toolText = (result: unknown) => z.object({ content: z.array(z.object({ text: z.string() })) }).parse(result).content.map(item => item.text).join('\n');

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  const handler = createHttpHandler(readHttpConfig({ MCP_BEARER_TOKEN: token }), { serveWebsite: true });
  const server = createServer((req: HttpRequest, res) => {
    if (req.headers['x-test-parsed-body'] === 'large') req.body = { data: 'x'.repeat(MAX_BODY_BYTES) };
    else if (req.headers['x-test-parsed-body'] === 'rpc') req.body = { jsonrpc: '2.0', id: 21, method: 'tools/list' };
    else if (req.headers['x-test-parsed-body'] === 'circular') {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      req.body = circular;
    }
    void handler.handle(req, res).catch(error => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  const url = await listen(server);
  return {
    url,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

test('workflow questions use supplied boolean context without accepting customer answers', () => {
  for (const workflow of workflows) {
    const result = workflowPlan(workflow);
    assert.equal(result.missingQuestions[0]?.id, 'project');
    assert.ok(result.steps.length >= 6);
    assert.match(result.publicationGate.join(' '), /Only after that yes.*confirmed: true/s);
  }
  assert.deepEqual(workflowPlan('new-project').missingQuestions.slice(0, 3).map(item => item.id), ['project', 'repositories', 'audience'], 'Code folders are asked right after the project.');
  assert.equal(workflowPlan('promote').missingQuestions.some(item => item.id === 'audience'), false);
  assert.equal(workflowPlan('audit').savedProjects, undefined, 'Anonymous plans do not mention saved projects.');
  const result = workflowPlan('update', { project: true, audience: true, repositories: true, scope: true });
  assert.deepEqual(result.missingQuestions.map(item => item.id), ['environment', 'changeType', 'version']);
  assert.ok(result.laterConfirmation);
  assert.equal(workflowPlan('promote', { project: true, target: true }).missingQuestions.length, 0);
  assert.match(workflowPlan('audit').steps.join(' '), /all published articles with read_published_documentation/);
  assert.match(workflowPlan('update').steps.join(' '), /Errors, FAQ, troubleshooting/);
  assert.match(workflowPlan('update').steps.join(' '), /test scenarios.*release-notes entry/s, 'Updates keep tester content current.');
  assert.match(workflowPlan('promote').steps.join(' '), /release notes and test scenarios for this version must already be in the source/);
});

test('existing documentation gets incremental source guidance rather than a whole-project reread', () => {
  const update = workflowPlan('update');
  assert.match(update.codeReading!.join(' '), /Do not reread the whole project/);
  assert.match(update.codeReading!.join(' '), /current branch and available tags/);
  assert.match(update.codeReading!.join(' '), /changed source.*dependencies/i);
  assert.doesNotMatch(update.codeReading!.join(' '), /Then read every file|Read at least 80%/);
  assert.doesNotMatch(update.steps.join(' '), /read all source code of the affected repositories/);
  assert.match(workflowPlan('new-project').codeReading!.join(' '), /Then read every file/);
  assert.match(workflowPlan('audit').codeReading!.join(' '), /Then read every file/);
});

test('repository guidance handles multiple roles; promotions cannot merge or move backwards', () => {
  assert.equal(analysisGuide(['frontend', 'backend', 'frontend']).repositories.length, 2);
  for (const [source, target] of [['development', 'beta'], ['development', 'production'], ['beta', 'production']]) {
    assert.equal(publicationChecklist('promote', source, target).operation, 'promote');
  }
  assert.throws(() => publicationChecklist('promote', 'production', 'development'), InvalidPromotionError);
  assert.match(publicationChecklist('apply').gates.join(' '), /Never look for another way to write/);
  assert.match(publicationChecklist('rollback').safety.join(' '), /historical immutable content/);
});

test('every guided write workflow detects legacy transport and offers approved v3 migration', () => {
  for (const workflow of ['update', 'audit', 'promote'] as const) {
    const plan = workflowPlan(workflow);
    assert.match(plan.steps.join(' '), /list_published_documentation/);
    assert.match(plan.steps.join(' '), /format.*1 or 2/);
    assert.match(plan.boundaries.join(' '), /explicit approval.*migrate_documentation_to_v3/s);
    assert.doesNotMatch(plan.boundaries.join(' '), /Documentation is v2 only|converted to v2 first/);
  }
  const migration = workflowPlan('convert');
  assert.match(migration.steps.join(' '), /Omit approveConversion, verification and records on this first call/);
  assert.match(migration.steps.join(' '), /nothing is written.*approveConversion:true/s);
  assert.match(migration.steps.join(' '), /Only after that approval/);
  assert.match(migration.steps.join(' '), /conflict.*renewed approval|conflict.*request renewed approval/is);
  assert.doesNotMatch(migration.steps.join(' '), /call convert_documentation_to_v2/i);
  assert.match(migration.missingQuestions.find(question => question.id === 'convertApproval')!.question, /encrypted v3/);
  assert.match(migration.missingQuestions.find(question => question.id === 'migrationMode')!.question, /Check and convert.*Rewrite from scratch/s);
  assert.match(migration.steps.join(' '), /requiresVerification.*accurate.*corrected.*added.*removed/s);
  assert.ok(!migration.missingQuestions.some(question => question.id === 'version'), 'Migration preserves the published version.');
  assert.match(workflowPlan('new-project').steps.join(' '), /format:3.*expected "empty"/);
});

test('remote config fails closed, validates exact hosts/origins and rejects weak tokens', () => {
  assert.throws(() => readHttpConfig({}, true), /requires MCP_BEARER_TOKEN/);
  assert.throws(() => readHttpConfig({ MCP_BEARER_TOKEN: 'short' }), /32 characters/);
  assert.throws(() => readHttpConfig({ MCP_ALLOWED_HOSTS: '*.example.com' }), /exact hostnames/);
  assert.throws(() => readHttpConfig({ MCP_ALLOWED_ORIGINS: 'https://example.com/path' }), /exact HTTP/);
  assert.throws(() => readHttpConfig({ MCP_BEARER_TOKEN: token, VERCEL_URL: 'preview.example.com' }, true), /MCP_VALIDATION_SIGNING_KEY/);
  assert.throws(() => readHttpConfig({ MCP_BEARER_TOKEN: token, MCP_VALIDATION_SIGNING_KEY: token, VERCEL_URL: 'preview.example.com' }, true), /different private/);
  const config = readHttpConfig({ MCP_BEARER_TOKEN: token, MCP_VALIDATION_SIGNING_KEY: signingKey, VERCEL_URL: 'preview.example.com' }, true);
  assert.equal(trustedHost('preview.example.com:443', config.allowedHosts), true);
  assert.equal(trustedHost('localhost', config.allowedHosts), false);
  assert.equal(trustedHost('preview.example.com.attacker.invalid', config.allowedHosts), false);
  assert.equal(trustedHost('preview.example.com@attacker.invalid', config.allowedHosts), false);
  assert.equal(trustedHost('preview.example.com:99999', config.allowedHosts), false);
  assert.equal(authorized('Bearer ' + token, token), true);
  assert.equal(authorized('Bearer wrong', token), false);
  assert.equal(authorized(undefined, token), false);
});

test('HTTP health, authorization, routing, malformed JSON and body limits', { timeout: 15_000 }, async t => {
  const app = await fixture();
  t.after(app.close);
  const health = await fetch(app.url + '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.match(await health.text(), /"mode":"self-hosted"/);
  assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers: { ...headers, Authorization: 'Bearer incorrect' }, body: '{}' })).status, 401);
  assert.equal((await fetch(app.url + '/sse', { headers })).status, 404);
  assert.equal((await fetch(app.url + '/mcp', { headers })).status, 405);
  assert.equal((await fetch(app.url + '/mcp', { method: 'OPTIONS', headers })).status, 405);
  assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(MAX_BODY_BYTES) }) })).status, 413);
  for (const [kind, status] of [['large', 413], ['circular', 400], ['rpc', 200]] as const) {
    const response = await fetch(app.url + '/api/mcp', { method: 'POST', headers: { ...headers, 'x-test-parsed-body': kind }, body: '{}' });
    assert.equal(response.status, status, kind);
    if (kind === 'rpc') assert.match(await response.text(), /get_documentation_contract/);
  }
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(app.url + '/mcp', { method: 'POST', headers: { ...headers, Host: 'attacker.invalid' } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(status, 403);
  const chunkedStatus = await new Promise<number | undefined>((resolveStatus, reject) => {
    const req = request(app.url + '/mcp', { method: 'POST', headers }, res => {
      res.resume();
      res.on('end', () => resolveStatus(res.statusCode));
    });
    req.on('error', reject);
    req.write('{"data":"');
    req.write('x'.repeat(MAX_BODY_BYTES));
    req.end('"}');
  });
  assert.equal(chunkedStatus, 413);
});

test('a 2025 protocol client can initialize and make sessionless follow-up requests', { timeout: 10_000 }, async t => {
  const app = await fixture();
  t.after(app.close);
  const initialized = await fetch(app.url + '/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' }
    } })
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get('mcp-session-id'), null);
  assert.match(await initialized.text(), /2025-03-26/);
  const listed = await fetch(app.url + '/mcp', {
    method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  assert.equal(listed.status, 200);
  assert.match(await listed.text(), /get_documentation_contract/);
});

for (const mode of ['legacy', 'modern'] as const) {
  test(`real SDK ${mode} HTTP client discovers and invokes tools, resources and prompts`, { timeout: 20_000 }, async t => {
    const app = await fixture();
    t.after(app.close);
    const client = new Client({ name: 'protocol-test', version: '1.0.0' }, mode === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers } }));
    t.after(() => client.close());
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['convert_documentation_to_v2', 'design_documentation_structure', 'estimate_documentation_effort', 'get_analysis_guide', 'get_discovery_plan', 'get_documentation_contract', 'get_publication_checklist', 'search_discovery', 'start_documentation_workflow', 'validate_change_plan', 'validate_documentation', 'validate_documentation_snapshot'].sort());
    assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint));
    assert.match(tools.tools.find(tool => tool.name === 'design_documentation_structure')!.title ?? '', /v3/);
    assert.match(tools.tools.find(tool => tool.name === 'convert_documentation_to_v2')!.description ?? '', /migrate_documentation_to_v3/);
    const catalog = await client.callTool({ name: 'get_documentation_contract', arguments: {} });
    assert.match(toolText(catalog), /record.schema.json/);
    assert.match(toolText(catalog), /publish_documentation format:3/);
    const contract = await client.callTool({ name: 'get_documentation_contract', arguments: { resource: 'examples/errors.json' } });
    assert.match(toolText(contract), /"message"/);
    const traversal = await client.callTool({ name: 'get_documentation_contract', arguments: { resource: '../vendor/provenance.json' } });
    assert.equal(traversal.isError, true);
    const badInput = await client.callTool({ name: 'start_documentation_workflow', arguments: { workflow: 'update', sourceCode: 'must-not-be-accepted' } });
    assert.equal(badInput.isError, true);
    const workflow = await client.callTool({ name: 'start_documentation_workflow', arguments: { workflow: 'update', known: { project: true } } });
    assert.match(toolText(workflow), /repositories/);
    assert.doesNotMatch(toolText(workflow), /"id": "project"/);
    const fresh = await client.callTool({ name: 'start_documentation_workflow', arguments: { workflow: 'update' } });
    assert.match(toolText(fresh), /"id": "project"/);
    // Readers tailor the guidance and the structure; a structure without readers is refused.
    const forTesters = await client.callTool({ name: 'start_documentation_workflow', arguments: { workflow: 'new-project', audiences: ['testers'] } });
    assert.match(toolText(forTesters), /"audienceGuide"/);
    assert.match(toolText(forTesters), /Test scenarios per feature/);
    const structure = await client.callTool({ name: 'design_documentation_structure', arguments: { appName: 'Acme', audiences: ['testers', 'product-owners'], purposes: ['product-guide'] } });
    assert.notEqual(structure.isError, true);
    assert.match(toolText(structure), /"heading": "Why it matters",[^}]*"audiences": \[\s*"product-owners"\s*\]/);
    const sample = JSON.parse(readFileSync(new URL('../../contract/examples/v2-catalog.json', import.meta.url), 'utf8')) as unknown[];
    const validation = await client.callTool({ name: 'validate_documentation', arguments: { records: sample, complete: true } });
    assert.equal(validation.isError, true);
    const validationReport = JSON.parse(toolText(validation)) as { ok: boolean; publishable: boolean; receipts: unknown[]; quality: { ok: boolean; issues: { code: string }[] } };
    assert.equal(validationReport.ok, true, 'The structural result remains distinct from editorial approval.');
    assert.equal(validationReport.publishable, false);
    assert.equal(validationReport.quality.ok, false);
    assert.ok(validationReport.quality.issues.some(issue => issue.code === 'AUDIENCE_PLAN_REQUIRED'));
    assert.deepEqual(validationReport.receipts, []);
    const malformed = await client.callTool({ name: 'validate_documentation', arguments: { records: [{ key: 'foundation', data: null }] } });
    assert.equal(malformed.isError, true);
    assert.match(toolText(malformed), /STRUCTURE_REQUIRED/);
    const noReaders = await client.callTool({ name: 'design_documentation_structure', arguments: { appName: 'Acme', purposes: ['product-guide'] } });
    assert.equal(noReaders.isError, true);
    assert.match(toolText(noReaders), /Send audiences/);
    const direction = await client.callTool({ name: 'get_publication_checklist', arguments: { operation: 'promote', source: 'production', target: 'development' } });
    assert.equal(direction.isError, true);
    const guide = await client.callTool({ name: 'get_analysis_guide', arguments: { repositoryTypes: ['frontend', 'backend'] } });
    assert.match(toolText(guide), /exact user-visible messages/);
    const resources = await client.listResources();
    const manifest = resources.resources.find(resource => resource.name === 'manifest.json');
    assert.ok(manifest);
    assert.match(JSON.stringify(await client.readResource({ uri: manifest.uri })), /contractVersion/);
    await assert.rejects(client.readResource({ uri: 'docs-contract://v2/../../.env' }));
    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts.length, 5);
    const promote = JSON.stringify(await client.getPrompt({ name: 'documentation_promote' }));
    assert.match(promote, /start_documentation_workflow with workflow \\"promote\\"/);
    assert.ok(promote.length < 400, 'Slash prompts stay short: the plan comes from the tool.');
  });
}

test('independent simultaneous clients retain no workflow state', { timeout: 20_000 }, async t => {
  const app = await fixture();
  t.after(app.close);
  const clients = [new Client({ name: 'one', version: '1' }), new Client({ name: 'two', version: '1' })];
  for (const client of clients) {
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers } }));
    t.after(() => client.close());
  }
  const [one, two] = await Promise.all(clients.map((client, index) => client.callTool({
    name: 'start_documentation_workflow', arguments: { workflow: 'audit', known: { project: index === 0 } }
  })));
  assert.doesNotMatch(toolText(one), /"id": "project"/);
  assert.match(toolText(two), /"id": "project"/);
});

test('real stdio client works with legacy and modern negotiation; stdin EOF exits cleanly', { timeout: 20_000 }, async () => {
  const executable = fileURLToPath(new URL('../src/stdio.js', import.meta.url));
  for (const modern of [false, true]) {
    const client = new Client({ name: 'stdio-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    const transport = new StdioClientTransport({ command: process.execPath, args: [executable], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 12);
      assert.match(toolText(await client.callTool({ name: 'get_documentation_contract', arguments: {} })), /manifest.json/);
    } finally { await client.close(); }
    assert.equal(stderr, '');
  }
  const child = spawn(process.execPath, [executable], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  child.stdin.end();
  assert.equal((await exit)[0], 0);
});

test('Vercel adapters handle both route spellings and pre-parsed MCP requests', { timeout: 10_000 }, async t => {
  const previous = { token: process.env.MCP_BEARER_TOKEN, hosts: process.env.MCP_ALLOWED_HOSTS, origins: process.env.MCP_ALLOWED_ORIGINS, signing: process.env.MCP_VALIDATION_SIGNING_KEY };
  process.env.MCP_BEARER_TOKEN = token;
  process.env.MCP_ALLOWED_HOSTS = '127.0.0.1';
  process.env.MCP_VALIDATION_SIGNING_KEY = signingKey;
  delete process.env.MCP_ALLOWED_ORIGINS;
  let adapter: typeof import('../api/mcp.js');
  try { adapter = await import('../api/mcp.js'); }
  finally {
    for (const [key, value] of [['MCP_BEARER_TOKEN', previous.token], ['MCP_ALLOWED_HOSTS', previous.hosts], ['MCP_ALLOWED_ORIGINS', previous.origins], ['MCP_VALIDATION_SIGNING_KEY', previous.signing]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const health = await import('../api/health.js');
  const server = createServer((req: HttpRequest, res) => {
    if (req.method === 'POST') req.body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const handler = req.url?.includes('health') ? health.default : adapter.default;
    void handler(req, res).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  const url = await listen(server);
  t.after(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  for (const path of ['/health', '/api/health']) assert.equal((await fetch(url + path)).status, 200);
  for (const path of ['/mcp', '/api/mcp']) {
    assert.equal((await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const response = await fetch(url + path, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /get_documentation_contract/);
  }
});

test('deployment exposes only the explicit public directory; examples and documentation links are valid', () => {
  const root = process.cwd();
  const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  assert.equal(config.framework, null, 'Explicit Other preset must prevent browser scripts from becoming backend entry points.');
  assert.equal(config.outputDirectory, 'public');
  assert.deepEqual(config.rewrites, [
    { source: '/v3/:asset', destination: '/api/mcp?websiteAsset=/v3/:asset' },
    { source: '/api/documentation-v3', destination: '/api/mcp?documentationV3=1' },
    { source: '/mcp', destination: '/api/mcp' },
    { source: '/health', destination: '/api/health' }
  ]);
  assert.deepEqual(Object.keys(config.functions).sort(), ['api/health.ts', 'api/mcp.ts']);
  assert.deepEqual(readdirSync(resolve(root, 'public')).sort(), ['apple-touch-icon.png', 'favicon-64.png', 'favicon.svg', 'index.html', 'robots.txt', 'tools']);
  assert.deepEqual(readdirSync(resolve(root, 'public/tools')), ['push-records.mjs'], 'Only the record upload script is hosted under /tools.');
  const favicon = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8');
  const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
  assert.match(favicon, /<title>Documentation Workflow MCP<\/title>/);
  assert.ok(html.includes('rel="icon" type="image/svg+xml" href="/favicon.svg?v=2"'));
  assert.ok(html.includes('rel="icon" type="image/png" sizes="64x64" href="/favicon-64.png?v=2"'), 'Safari needs a PNG icon as well as the SVG.');
  assert.ok(Object.values(config.functions).every(value => typeof z.object({ includeFiles: z.string() }).parse(value).includeFiles === 'string'));
  assert.match(readFileSync(resolve(root, '.vercelignore'), 'utf8'), /\.env/);
  assert.match(readFileSync(resolve(root, '.vercelignore'), 'utf8'), /customer-data/);
  for (const file of readdirSync(resolve(root, 'examples'))) JSON.parse(readFileSync(resolve(root, 'examples', file), 'utf8'));
  const docs = [resolve(root, 'README.md'), ...readdirSync(resolve(root, 'docs')).filter(file => file.endsWith('.md')).map(file => resolve(root, 'docs', file))];
  for (const file of docs) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1];
      assert.ok(link);
      if (!link.includes('://') && !link.startsWith('#')) assert.ok(existsSync(resolve(dirname(file), link.split('#')[0] ?? '')), `${file}: ${link}`);
    }
  }
});

test('local landing page serves only explicit public assets and preserves private routes', { timeout: 10_000 }, async t => {
  const app = await fixture();
  t.after(app.close);
  const page = await fetch(app.url + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  const html = await page.text();
  assert.match(html, /self-hosted documentation MCP server/);
  for (const path of ['/index.html', '/favicon.svg', '/favicon-64.png', '/apple-touch-icon.png', '/robots.txt', '/tools/push-records.mjs']) {
    assert.equal((await fetch(app.url + path)).status, 200, path);
    const head = await fetch(app.url + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  for (const path of ['/.env', '/src/server.ts', '/contract/manifest.json', '/vendor/documentation-model.js', '/README.md', '/projects.json',
    '/dashboard', '/admin', '/api/access', '/api/site', '/missing.css']) {
    assert.equal((await fetch(app.url + path)).status, 404, path);
  }
  assert.equal((await fetch(app.url + '/', { method: 'POST' })).status, 405);
  assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'));
  const csp = config.headers[0].headers.find((header: { key: string }) => header.key === 'Content-Security-Policy');
  assert.equal(csp.value, page.headers.get('content-security-policy'));
});

test('workflow questions are plain language and ask about related code projects', () => {
  const jargon = /\b(foundation|schema|v2|manifest|payload|records?|layouts?|fields?|design_documentation_structure|environment pointer)\b/i;
  for (const workflow of ['new-project', 'update', 'audit', 'promote', 'convert'] as const) {
    const plan = workflowPlan(workflow);
    assert.ok(plan.askingGuide.length > 0);
    for (const item of plan.missingQuestions) assert.doesNotMatch(item.question, jargon, workflow + '/' + item.id + ' uses internal words');
    if (plan.laterConfirmation) assert.doesNotMatch(plan.laterConfirmation, jargon);
  }
  const plan = workflowPlan('new-project', { project: true, audience: true, purpose: true, environment: true, version: true });
  assert.deepEqual(plan.missingQuestions.map(item => item.id), ['repositories']);
  assert.match(plan.missingQuestions[0]!.question, /backend.*mobile app.*admin panel/s);
  assert.ok(plan.relatedRepositories?.some(line => /Never assume the open folder is the only project/.test(line)));
  assert.equal(workflowPlan('promote').relatedRepositories, undefined, 'Promotion does not read code.');
});
