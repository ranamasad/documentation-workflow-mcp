import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadContractResources } from './contract.js';
import { createDocumentationServer } from './server.js';
import { MAX_BODY_BYTES } from './http.js';
import { createValidationService } from './validation.js';
import { readValidationSigningKey } from './config.js';
import { createSelfHosted, LOCAL_USER, readSelfHostedConfig } from './self-hosted.js';
import { readDocumentationEncryptionKey } from './managed-documentation.js';

const resources = loadContractResources();
const validation = createValidationService(readValidationSigningKey());
// Run by the owner's own AI client: with projects.json every project's tools load, without it the guide and validation tools.
const config = readSelfHostedConfig();
const masterKey = readDocumentationEncryptionKey();
const local = config ? createSelfHosted(config, masterKey ? { masterKey } : {}) : undefined;
const handle = serveStdio(() => createDocumentationServer(resources, validation, local?.projects, fetch,
  local ? { userId: LOCAL_USER, clientId: 'stdio' } : undefined), {
  legacy: 'serve',
  maxSubscriptions: 0,
  transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_BODY_BYTES }),
  onerror: error => console.error('MCP stdio error:', error.name)
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void handle.close(); });
}
