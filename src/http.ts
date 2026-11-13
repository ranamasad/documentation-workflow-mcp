import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JWTVerifyGetKey } from 'jose';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { authorized, trustedHost, type HttpConfig } from './config.js';
import { loadContractResources } from './contract.js';
import { createDocumentationServer, identity } from './server.js';
import { loadWebsite, websiteHeaders } from './website.js';
import { createValidationService, VALIDATION_REQUEST_BYTES } from './validation.js';
import { createDocumentationV3, createV3FirestoreStore } from './documentation-v3.js';
import { createCiphertextCache } from './ciphertext-cache.js';
import { createFirestoreCache } from './firestore-cache.js';
import { useFirestoreCache } from './firestore.js';
import { handleManagedDocumentation } from './managed-documentation.js';
import { createManagedTelemetry } from './managed-telemetry.js';
import { createProfileStats } from './profile-stats.js';
import { createOrbit } from './orbit.js';
import { createSelfHosted, LOCAL_USER, readSelfHostedConfig, type SelfHostedConfig } from './self-hosted.js';
import { UPLOAD_TICKET_CLIENT, verifyUploadTicket } from './upload-ticket.js';
import type { Principal } from './project-store.js';

export const MAX_BODY_BYTES = VALIDATION_REQUEST_BYTES;
export type HttpRequest = IncomingMessage & { body?: unknown };

function answer(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

/** The owner's bearer token, or an upload ticket that opens only the validation and staging tools. */
function principalOf(header: string | undefined, token: string | undefined): Principal | undefined {
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (bearer) {
    const ticketUser = verifyUploadTicket(bearer);
    if (ticketUser === LOCAL_USER) return { userId: LOCAL_USER, clientId: UPLOAD_TICKET_CLIENT };
  }
  return authorized(header, token) ? { userId: LOCAL_USER, clientId: 'owner-token' } : undefined;
}

export function createHttpHandler(config: HttpConfig, options: { serveWebsite?: boolean; selfHosted?: SelfHostedConfig | null; fetchFirestore?: typeof fetch;
  firebaseKeys?: JWTVerifyGetKey } = {}) {
  const resources = loadContractResources();
  const website = options.serveWebsite ? loadWebsite() : undefined;
  const validation = createValidationService(config.validationSigningKey);
  const selfHostedConfig = options.selfHosted === undefined ? readSelfHostedConfig() : options.selfHosted ?? undefined;
  const local = selfHostedConfig ? createSelfHosted(selfHostedConfig, {
    ...(options.fetchFirestore ? { fetchService: options.fetchFirestore } : {}),
    ...(options.firebaseKeys ? { firebaseKeys: options.firebaseKeys } : {}),
    ...(config.documentationEncryptionKey ? { masterKey: config.documentationEncryptionKey } : {})
  }) : undefined;
  const ciphertextCache = createCiphertextCache({ redis: config.upstash });
  // Every server-side Firestore read goes through Redis when configured; the signing key seals entries so Redis sees only ciphertext.
  useFirestoreCache(createFirestoreCache({ secret: config.validationSigningKey, redis: config.upstash }));
  const managedOptions = { fetchService: options.fetchFirestore, masterKey: config.documentationEncryptionKey,
    cache: ciphertextCache, releaseCacheSigningKey: config.validationSigningKey };
  // Set per request: whether the caller presented the owner token (used by the encrypted documentation endpoint).
  const ownerRequests = new WeakSet<IncomingMessage>();
  const environmentKey = (name: 'GEMINI_API_KEY' | 'GROQ_API_KEY') => async () => process.env[name] || null;
  const documentationV3 = local ? createDocumentationV3({
    rpc: local.rpc,
    authenticate: (req, res, input) => local.v3Authenticate(req, res, input, ownerRequests.has(req)),
    preflight: req => local.v3Preflight(req),
    store: access => createV3FirestoreStore(access, options.fetchFirestore),
    allowedOrigins: new Set([...config.allowedOrigins, ...local.siteOrigins()]),
    cache: ciphertextCache,
    releaseCacheSigningKey: config.validationSigningKey,
    telemetry: createManagedTelemetry(managedOptions),
    issues: local.issues.reader,
    orbit: createOrbit({ managed: managedOptions, aiKey: environmentKey('GEMINI_API_KEY'), groqKey: environmentKey('GROQ_API_KEY'),
      groqModel: process.env.GROQ_MODEL }),
    profile: createProfileStats({ issuesOf: local.issues.ofReader, fetchService: options.fetchFirestore,
      masterKey: config.documentationEncryptionKey, aiKey: environmentKey('GEMINI_API_KEY') }),
    managed: (access, input) => handleManagedDocumentation(access, input, managedOptions)
  }) : undefined;
  const reportError = (error: Error) => console.error('MCP transport error:', error.name);
  // The owner (token holder) gets every project in projects.json; without projects only the guide and validation tools load.
  const mcp = createMcpHandler(({ authInfo }) => {
    const userId = authInfo?.extra?.userId;
    const signedIn = local && userId === LOCAL_USER;
    return createDocumentationServer(resources, validation, signedIn ? local.projects : undefined, options.fetchFirestore,
      signedIn ? { userId: LOCAL_USER, clientId: authInfo?.clientId ?? '' } : undefined);
  }, {
    legacy: 'stateless', responseMode: 'json', maxRequestBodySize: MAX_BODY_BYTES,
    maxSubscriptions: 0, onerror: reportError
  });
  const transport = toNodeHandler(mcp, { maxRequestBodySize: MAX_BODY_BYTES, onerror: reportError });
  const handle = async (req: HttpRequest, res: ServerResponse): Promise<void> => {
    const route = new URL(req.url ?? '/', 'http://localhost');
    const requestedAsset = route.pathname === '/api/mcp' && route.searchParams.get('documentationV3') !== '1' ? route.searchParams.get('websiteAsset') : null;
    const publicAsset = requestedAsset && /^\/v3\/documentation-[a-z0-9-]+\.js$/.test(requestedAsset) ? requestedAsset : undefined;
    const path = publicAsset ?? route.pathname;
    const encryptedRoute = path === '/api/documentation-v3' || path === '/api/mcp' && route.searchParams.get('documentationV3') === '1';
    res.setHeader('Cache-Control', encryptedRoute ? 'private, no-store' : 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!trustedHost(req.headers.host, config.allowedHosts)) return answer(res, 403, { error: 'Untrusted Host header.' });
    if (encryptedRoute) {
      if (!documentationV3) return answer(res, 503, { error: 'Encrypted documentation needs projects.json (or MCP_PROJECTS_JSON) on this server.' });
      if (req.headers.authorization && principalOf(req.headers.authorization, config.token)?.clientId === 'owner-token') ownerRequests.add(req);
      return documentationV3(req, res);
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.has(origin)) return answer(res, 403, { error: 'Untrusted Origin header.' });
    const site = website ?? (publicAsset ? loadWebsite() : undefined);
    const asset = site?.get(path);
    if (asset) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return answer(res, 405, { error: 'Method not allowed.' });
      }
      res.writeHead(200, { ...websiteHeaders, ...(publicAsset ? { 'Cache-Control': 'private, no-store' } : {}),
        'Content-Type': asset.contentType, 'Content-Length': asset.body.byteLength });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    if (path === '/health' || path === '/api/health') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return answer(res, 405, { error: 'Method not allowed.' });
      }
      return answer(res, 200, { status: 'ok', ...identity, mode: 'self-hosted',
        projects: selfHostedConfig ? selfHostedConfig.file.projects.length : 0, encryption: Boolean(config.documentationEncryptionKey) });
    }
    if (path !== '/mcp' && path !== '/api/mcp') return answer(res, 404, { error: 'Not found.' });
    const principal = principalOf(req.headers.authorization, config.token);
    if (!principal) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="documentation-workflow-mcp"');
      return answer(res, 401, { error: 'A valid MCP bearer token is required.' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return answer(res, 405, { error: 'Only stateless MCP POST requests are supported.' });
    }
    const contentType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return answer(res, 415, { error: 'Use application/json.' });
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      return answer(res, 413, { error: 'MCP request exceeds 10 MiB. Split validation records into smaller batches and use signed receipts for the final snapshot.' });
    }
    if (req.body !== undefined) {
      let serialized: string | undefined;
      try { serialized = JSON.stringify(req.body); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return answer(res, 400, { error: 'The pre-parsed request body must be JSON serializable.' });
      }
      if (serialized === undefined) return answer(res, 400, { error: 'Invalid pre-parsed JSON body.' });
      if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) return answer(res, 413, { error: 'MCP request exceeds 10 MiB. Split validation records into smaller batches and use signed receipts for the final snapshot.' });
    }
    await transport({
      method: 'POST',
      url: req.url ?? '/mcp',
      headers: req.headers,
      auth: { token: 'verified', clientId: principal.clientId, scopes: [], extra: { userId: principal.userId } },
      [Symbol.asyncIterator]: () => req[Symbol.asyncIterator]()
    }, res, req.body);
  };
  return { handle, close: mcp.close };
}
