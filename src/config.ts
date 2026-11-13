import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readDocumentationEncryptionKey } from './managed-documentation.js';

export interface HttpConfig {
  token?: string;
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
  validationSigningKey: string;
  upstash?: { url: string; token: string };
  documentationEncryptionKey?: string;
}

export function readValidationSigningKey(env: NodeJS.ProcessEnv = process.env, required = false): string {
  const key = env.MCP_VALIDATION_SIGNING_KEY;
  if (!key) {
    if (required) throw new Error('Remote MCP requires a private MCP_VALIDATION_SIGNING_KEY for stateless validation receipts. Never share this key with clients.');
    return randomBytes(32).toString('hex');
  }
  if (key.length < 32 || /\s/.test(key)) throw new Error('MCP_VALIDATION_SIGNING_KEY must contain at least 32 characters and no whitespace.');
  if (key === env.MCP_BEARER_TOKEN) throw new Error('Use a different private validation signing key, not the shared client bearer token.');
  return key;
}

/** Where this MCP is reachable, for links the AI downloads (the record upload script). */
export function publicUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MCP_PUBLIC_URL) return env.MCP_PUBLIC_URL.replace(/\/$/, '');
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL;
  return 'http://127.0.0.1:' + (env.PORT ?? '4318');
}

function split(value: string | undefined): string[] {
  return (value ?? '').split(',').map(part => part.trim()).filter(Boolean);
}

/**
 * The Redis REST endpoint and read-write token. Prefers the variables the Vercel Storage (Upstash) integration
 * creates, KV_REST_API_URL and KV_REST_API_TOKEN, and falls back to UPSTASH_REDIS_REST_URL/TOKEN set by hand.
 * KV_REST_API_READ_ONLY_TOKEN cannot write the cache, and KV_URL/REDIS_URL are TCP addresses, so neither is used.
 */
export function redisRestEnv(env: NodeJS.ProcessEnv = process.env): { url: string | undefined; token: string | undefined } {
  return env.KV_REST_API_URL || env.KV_REST_API_TOKEN
    ? { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN }
    : { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env, remote = false): HttpConfig {
  const { url: redisUrl, token: redisToken } = redisRestEnv(env);
  let upstash: HttpConfig['upstash'];
  if (redisUrl || redisToken) {
    if (!redisUrl || !redisToken) throw new Error('Configure both KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN).');
    const url = new URL(redisUrl);
    if (url.protocol !== 'https:' || url.origin !== redisUrl || url.username || url.password || /\s/.test(redisToken)) {
      throw new Error('Upstash requires an exact HTTPS origin and a non-whitespace token.');
    }
    upstash = { url: redisUrl, token: redisToken };
  }
  const requireToken = remote || env.VERCEL === '1' || env.NODE_ENV === 'production';
  const token = env.MCP_BEARER_TOKEN || undefined;
  if (token !== undefined && (token.length < 32 || /\s/.test(token))) {
    throw new Error('MCP_BEARER_TOKEN must contain at least 32 characters and no whitespace.');
  }
  if (requireToken && !token) throw new Error('A remote MCP requires MCP_BEARER_TOKEN. Generate one with: openssl rand -hex 32');
  const hosts = split(env.MCP_ALLOWED_HOSTS);
  if (requireToken) {
    for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
      if (env[key]) hosts.push(env[key]);
    }
  } else hosts.push('localhost', '127.0.0.1', '[::1]');
  for (const host of hosts) {
    if (host !== '[::1]' && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) {
      throw new Error('MCP_ALLOWED_HOSTS must contain exact hostnames without schemes, ports, paths or wildcards.');
    }
  }
  if (!hosts.length) throw new Error('Configure at least one trusted MCP hostname.');
  const origins = split(env.MCP_ALLOWED_ORIGINS);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths.');
    }
  }
  return {
    ...(env.MCP_DOCUMENTATION_ENCRYPTION_KEY ? { documentationEncryptionKey: readDocumentationEncryptionKey(env)! } : {}),
    ...(upstash ? { upstash } : {}),
    ...(token ? { token } : {}),
    allowedHosts: new Set(hosts.map(host => host.toLowerCase())),
    allowedOrigins: new Set(origins),
    validationSigningKey: readValidationSigningKey(env, requireToken)
  };
}

export function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  if (!header?.startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}

export function trustedHost(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!header || !/^(?:[a-z0-9.-]+|\[::1\])(?::[0-9]{1,5})?$/i.test(header)) return false;
  try { return allowed.has(new URL('http://' + header).hostname.toLowerCase()); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}
