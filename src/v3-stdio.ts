import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { V3Client, V3ClientError, releaseNotesSchema } from './v3-client.js';

const environment = z.enum(['development', 'beta', 'production']);
const context = {
  project: z.string().min(1).max(120), workspace: z.uuid().optional(), environment
};
const expected = z.union([z.uuid(), z.literal('empty')]);
const publishSchema = z.strictObject({
  ...context, ...releaseNotesSchema.shape, expected, confirmed: z.literal(true), records: z.array(z.record(z.string(), z.unknown())).min(1).max(2000),
  approveConversion: z.boolean().optional(),
  sourceReview: z.strictObject({
    repositories: z.array(z.strictObject({
      name: z.string().min(1).max(120), role: z.string().min(1).max(60),
      sourceFiles: z.number().int().min(1).max(1000000), filesRead: z.number().int().min(0).max(1000000)
    })).min(1).max(12), areas: z.array(z.string().min(1).max(120)).min(1).max(300),
    unread: z.array(z.string().max(200)).max(100).optional()
  })
});
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const text = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }] });

export function createV3Server(client: V3Client): McpServer {
  const server = new McpServer({ name: 'documentation-v3-local', version: '0.3.0' }, {
    capabilities: { tools: {} },
    instructions: 'Documentation is decrypted locally in this connector only. Never request passwords, recovery codes or private keys as tool arguments. Publishing requires user approval, a complete snapshot and source review. There is no remote plaintext/v2 fallback. Tool results contain plaintext for the host: use only a trusted AI host.'
  });
  async function run(operation: () => Promise<unknown>) {
    try { return text(await operation()); }
    catch (error) {
      return { ...text({ error: error instanceof V3ClientError ? error.message : 'Local encrypted documentation operation failed.',
        code: error instanceof V3ClientError ? error.code : 'LOCAL_ERROR' }), isError: true };
    }
  }
  server.registerTool('list_published_documentation', {
    description: 'List locally decrypted articles in the authoritative current encrypted release.',
    inputSchema: z.strictObject({ ...context, offset: z.number().int().min(0).max(2000).optional(), limit: z.number().int().min(1).max(500).optional() }), annotations: readOnly
  }, input => run(() => client.list(input, input.offset, input.limit)));
  server.registerTool('search_published_documentation', {
    description: 'Search full decrypted article text locally; no search terms or plaintext go to the backend.',
    inputSchema: z.strictObject({ ...context, query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }), annotations: readOnly
  }, input => run(() => client.search(input, input.query, input.limit)));
  server.registerTool('read_published_documentation', {
    description: 'Authenticate and decrypt up to ten current articles locally.',
    inputSchema: z.strictObject({ ...context, keys: z.array(z.string().min(1).max(200)).min(1).max(10) }), annotations: readOnly
  }, input => run(() => client.read(input, input.keys)));
  server.registerTool('whats_changed', {
    description: 'Read authenticated encrypted release version/tags/summary when present. Per-article change details are unavailable and never fabricated.',
    inputSchema: z.strictObject(context), annotations: readOnly
  }, input => run(() => client.changes(input)));
  server.registerTool('documentation_release_status', {
    description: 'Read the live encrypted release ID/generation, locally decrypted version/tags/summary and its CAS expected value.',
    inputSchema: z.strictObject(context), annotations: readOnly
  }, input => run(() => client.status(input)));
  server.registerTool('publish_documentation', {
    description: 'Validate a COMPLETE snapshot locally, encrypt and publish with CAS. Never submit a partial update. Only confirmed user-reviewed content; approveConversion separately approves reported normalization/conversion losses. Passwords/keys are never tool arguments.',
    inputSchema: publishSchema, annotations: write
  }, input => run(() => client.publish(input)));
  server.registerTool('convert_documentation_to_v3', {
    description: 'Convert a COMPLETE local v1/v2 snapshot through validated v2 content to an encrypted v3 publication. Returns the conversion report without publishing until changes/losses have approveConversion consent. Requires user confirmed:true, source review and target expected CAS. Never returns keys or uploads plaintext.',
    inputSchema: publishSchema, annotations: write
  }, input => run(() => client.publish(input, 'import')));
  server.registerTool('promote_documentation', {
    description: 'Owner/admin: decrypt the complete pinned source release locally and re-encrypt under target scope. Version/tags/summary default to authenticated source metadata; supply overrides if absent. Atomically checks both live heads; never copies cross-environment ciphertext.',
    inputSchema: z.strictObject({ ...context, ...releaseNotesSchema.partial().shape, target: environment, expected, expectedSource: z.uuid(), confirmed: z.literal(true) }), annotations: write
  }, input => run(() => client.promote(input)));
  server.registerTool('rollback_documentation', {
    description: 'Owner/admin: authenticate/decrypt an immutable historical release from this environment, then re-encrypt under its current key and publish as a new release with live target CAS. Requires grants for historical and current keys.',
    inputSchema: z.strictObject({ ...context, ...releaseNotesSchema.shape, rollbackRelease: z.uuid(), expected: z.uuid(), confirmed: z.literal(true) }), annotations: write
  }, input => run(() => client.rollback(input)));
  return server;
}

// Importing this module in tests does not start a transport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const client = new V3Client({
      endpoint: process.env.MCP_V3_ENDPOINT ?? '', token: process.env.MCP_V3_TOKEN ?? '',
      password: process.env.MCP_V3_UNLOCK_PASSWORD, recoveryCode: process.env.MCP_V3_RECOVERY_CODE
    });
    // Remove the inherited copies; the connector retains only in-memory unlock state.
    delete process.env.MCP_V3_UNLOCK_PASSWORD;
    delete process.env.MCP_V3_RECOVERY_CODE;
    const handle = serveStdio(() => createV3Server(client), {
      legacy: 'serve', maxSubscriptions: 0,
      transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 10 * 1024 * 1024 }),
      onerror: () => { console.error('Local encrypted MCP transport error.'); }
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { client.close(); void handle.close(); });
    }
    process.stdin.once('end', () => { client.close(); void handle.close(); });
  } catch {
    console.error('Cannot start local encrypted MCP. Check endpoint, personal token, unlock environment and the built v3 vendor.');
    process.exitCode = 1;
  }
}
