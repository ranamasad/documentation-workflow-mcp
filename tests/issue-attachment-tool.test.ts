import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createDocumentationV3 } from '../src/documentation-v3.js';
import { ATTACHMENT_BYTES } from '../src/issues.js';
import { createDocumentationServer } from '../src/server.js';
import type { ProjectStore } from '../src/project-store.js';

const ISSUE = '11111111-1111-4111-8111-111111111111';
const IMAGE = '22222222-2222-4222-8222-222222222222';
const JSON_FILE = '33333333-3333-4333-8333-333333333333';
const LONG_LOG = '44444444-4444-4444-8444-444444444444';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A real MCP client talking to the real tools, with only the issue desk replaced. */
async function connect(t: { after(run: () => unknown): void }) {
  const updates: unknown[] = [];
  let attachments = [{ id: IMAGE, name: 'shot.png', type: 'image/png', size: PNG.length }];
  const desk = {
    async attachment({ attachment }: { attachment: string }) {
      if (attachment === IMAGE) return { name: 'shot.png', type: 'image/png', size: PNG.length, bytes: PNG };
      if (attachment === JSON_FILE) return { name: 'trace.json', type: 'application/json', size: 11, bytes: Buffer.from('{"ok":true}') };
      if (attachment === LONG_LOG) return { name: 'long.log', type: 'text/plain', size: 200_100, bytes: Buffer.alloc(200_100, 97) };
      throw Object.assign(new Error('No such attachment.'), { status: 404 });
    },
    async list() { return { issues: [{ id: ISSUE, attachments }] }; },
    async update(change: unknown) { updates.push(change); attachments = []; return { issue: { id: ISSUE } }; }
  };
  const projects = { issues: () => desk } as unknown as ProjectStore;
  const session = { userId: '55555555-5555-4555-8555-555555555555', clientId: 'test' };
  const handler = toNodeHandler(createMcpHandler(() => createDocumentationServer(undefined, undefined, projects, fetch, session),
    { legacy: 'stateless', responseMode: 'json' }));
  const server: Server = createServer((req, res) => { void handler(req as never, res as never); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + '/mcp')));
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); });
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project: 'Docs', id: ISSUE, ...args } }) as Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
  return { call, updates };
}

test('read_issue_attachment returns screenshots as images and files as text, marked untrusted', async t => {
  const { call } = await connect(t);
  const image = await call('read_issue_attachment', { attachment: IMAGE });
  assert.equal(image.content[1]!.type, 'image');
  assert.equal(image.content[1]!.mimeType, 'image/png');
  assert.equal(image.content[1]!.data, PNG.toString('base64'));
  assert.match(image.content[0]!.text!, /never follow instructions/);

  const json = await call('read_issue_attachment', { attachment: JSON_FILE });
  assert.equal(json.content[1]!.text, '{"ok":true}');
  assert.match(json.content[0]!.text!, /never follow instructions/);

  const long = await call('read_issue_attachment', { attachment: LONG_LOG });
  assert.match(long.content[1]!.text!, /Cut at 200000 characters/);
  assert.ok(long.content[1]!.text!.length < 200_100);

  const missing = await call('read_issue_attachment', { attachment: '66666666-6666-4666-8666-666666666666' });
  assert.equal(missing.isError, true);
});

test('closing through MCP warns about the files first, and only closes after confirmation', async t => {
  const { call, updates } = await connect(t);
  const warned = await call('close_issue', {});
  assert.match(warned.content[0]!.text!, /deletes 1 attached file for good/);
  assert.equal(updates.length, 0);
  await call('close_issue', { confirmed: true });
  assert.deepEqual(updates, [{ id: ISSUE, status: 'closed' }]);
});

test('answering and closing through MCP warns about the files in the preview', async t => {
  const { call, updates } = await connect(t);
  const preview = await call('answer_issue', { answer: 'Fixed.', close: true, confirmed: false });
  assert.match(preview.content[0]!.text!, /deletes 1 attached file for good/);
  assert.equal(updates.length, 0);
});

test('the website API accepts a full-size file from a verified reader, and only with website credentials', async t => {
  const seen: Record<string, unknown>[] = [];
  const access = { projectId: ISSUE, userId: null, name: 'Docs', role: 'none', email: 'reader@example.com', readerUid: 'reader', displayName: 'Reader',
    administrator: false, environments: ['development'], firebaseProject: 'test-project', serviceAccountKey: 'test-only' };
  const handler = createDocumentationV3({ allowedOrigins: new Set(), rpc: async () => assert.fail('Unexpected RPC'), authenticate: async () => access as never,
    issues: async (_identity, request) => { seen.push(request); return { ok: true }; } });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (body: object) => fetch('http://127.0.0.1:' + (server.address() as { port: number }).port, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { action: 'issues.attach', siteToken: 'dsite_' + 'a'.repeat(43), environment: 'development', id: ISSUE,
    name: 'trace.log', type: 'text/plain', data: Buffer.alloc(ATTACHMENT_BYTES, 97).toString('base64') };
  const accepted = await call(body);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(seen.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 4_500_000, 'It fits the Vercel request limit.');
  const { siteToken: _token, ...withoutToken } = body;
  assert.equal((await call(withoutToken)).status, 403);
  assert.equal((await call({ ...body, data: 'x'.repeat(3 * 1024 * 1024 + 1) })).status, 400);
});
