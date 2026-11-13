// Code notes: what the AI learned from a project's source, sealed by this server before storage
// (AES-256-GCM, bound to project and area) so the database never sees them. Saved only with the user's consent.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readValidationSigningKey } from './config.js';

let notesKey: Buffer | undefined;
const sealKey = () => notesKey ??= createHmac('sha256', readValidationSigningKey()).update('documentation-code-notes-seal-v1').digest();

export function sealNotes(project: string, area: string, notes: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(), iv).setAAD(Buffer.from(project.toLowerCase() + ':' + area));
  const body = Buffer.concat([cipher.update(gzipSync(notes)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openNotes(project: string, area: string, payload: string): string | undefined {
  try {
    const bytes = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', sealKey(), bytes.subarray(0, 12)).setAAD(Buffer.from(project.toLowerCase() + ':' + area));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return gunzipSync(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])).toString('utf8');
  } catch { return undefined; }
}
