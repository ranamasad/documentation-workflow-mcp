import { readHttpConfig } from '../src/config.js';
import { createHttpHandler, type HttpRequest } from '../src/http.js';
import type { ServerResponse } from 'node:http';

const handler = createHttpHandler(readHttpConfig(process.env, true));
export default function mcp(req: HttpRequest, res: ServerResponse): Promise<void> {
  return handler.handle(req, res);
}
