import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { readValidationSigningKey } from './config.js';

// Upload tickets let a local script send record files for the signed-in user without the AI pasting
// record bodies into tool calls. A ticket is issued through the user's own MCP sign-in, lasts at most two
// hours, and only opens the validation and staging tools: it can never publish, promote or roll back.
export const UPLOAD_TICKET_CLIENT = 'upload-ticket';
export const UPLOAD_TICKET_TOOLS: ReadonlySet<string> = new Set(['validate_documentation', 'validate_documentation_snapshot', 'stage_documentation', 'validate_draft', 'check_published', 'save_code_notes', 'read_code_notes']);
const MAX_TTL_SECONDS = 2 * 60 * 60;
const PREFIX = 'dup_';
const content = z.strictObject({ v: z.literal(1), sub: z.string().uuid(), exp: z.number().int() });

let key: Buffer | undefined;
const ticketKey = () => key ??= createHmac('sha256', readValidationSigningKey()).update('documentation-upload-ticket-v1').digest();
const sign = (encoded: string) => createHmac('sha256', ticketKey()).update(encoded).digest();

export function issueUploadTicket(userId: string, ttlSeconds = MAX_TTL_SECONDS, now = Date.now()) {
  const expires = Math.floor(now / 1000) + Math.min(Math.max(ttlSeconds, 60), MAX_TTL_SECONDS);
  const encoded = Buffer.from(JSON.stringify({ v: 1, sub: userId, exp: expires })).toString('base64url');
  return { ticket: PREFIX + encoded + '.' + sign(encoded).toString('base64url'), expiresAt: new Date(expires * 1000).toISOString() };
}

/** The user a ticket was issued to, or undefined when it is malformed, forged or expired. */
export function verifyUploadTicket(token: string, now = Date.now()): string | undefined {
  if (!token.startsWith(PREFIX) || token.length > 512) return undefined;
  const [encoded, signature, extra] = token.slice(PREFIX.length).split('.');
  if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded + signature)) return undefined;
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== 32 || !timingSafeEqual(actual, sign(encoded))) return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return undefined; }
  const parsed = content.safeParse(decoded);
  if (!parsed.success || parsed.data.exp * 1000 <= now) return undefined;
  return parsed.data.sub;
}
