import { createServer } from 'node:http';
import { readHttpConfig } from './config.js';
import { createHttpHandler } from './http.js';

const port = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const handler = createHttpHandler(readHttpConfig(), { serveWebsite: true });
const server = createServer((req, res) => {
  void handler.handle(req, res).catch((error: unknown) => {
    console.error('MCP request failed:', error instanceof Error ? error.name : 'UnknownError');
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MCP request failed. Check server diagnostics.' }));
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
// 127.0.0.1 keeps a laptop server private; set HOST=0.0.0.0 in a container or on a server behind HTTPS.
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => console.error(`Documentation MCP: http://${host}:${port}/mcp`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void handler.close().finally(() => server.close());
  });
}
