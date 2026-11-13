import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Requests (MCP and the documentation API) may be up to 10 MiB. Responses stay at 3 MiB (MAX_TOOL_RESULT_BYTES).
export const VALIDATION_REQUEST_BYTES = 10 * 1024 * 1024;
const require = createRequire(import.meta.url);
export const wireRecord = z.strictObject({
  key: z.string(), page: z.string(), collection: z.string(), title: z.string(),
  data: z.record(z.string(), z.unknown())
});
export type WireRecord = z.infer<typeof wireRecord>;
interface Model {
  record(value: unknown): WireRecord;
  assemble(records: WireRecord[]): unknown;
  navigationRecords(records: { key: string; data?: Record<string, unknown> }[], required?: boolean, manifest?: Record<string, string>): void;
  manifest(value: unknown): Record<string, string>;
  json(value: unknown): string;
  isDynamic(value: unknown): boolean;
}
const model: Model = require('../vendor/documentation-model.js');
const contractVersion = z.object({ contractVersion: z.string() }).parse(
  JSON.parse(readFileSync(new URL('../contract/manifest.json', import.meta.url), 'utf8'))
).contractVersion;
export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ValidationIssue {
  code: string;
  message: string;
  index?: number;
}
/** Content format: 1 = legacy fixed categories, 2 = dynamic sections (data.schemaVersion 2). */
type Format = 1 | 2;
interface Revision {
  key: string;
  revision: string;
  path: string;
  schema: number;
  format: Format;
  bytes: number;
}
export interface ValidationReport {
  ok: boolean;
  schema: number;
  contractVersion: string;
  complete: boolean;
  count: number;
  revisions: Revision[];
  errors: string[];
  issues: ValidationIssue[];
  format?: Format;
  manifestHash?: string;
  manifest?: Record<string, string>;
}
interface ValidationOptions {
  complete?: boolean;
  originalPayloads?: string[];
  // Server-side checks of a staged draft are not one MCP request, so they may exceed the request size.
  maxBytes?: number;
}

function report(count: number, complete: boolean): ValidationReport {
  return { ok: false, schema: 1, contractVersion, complete, count, revisions: [], errors: [], issues: [] };
}

function issue(result: ValidationReport, code: string, message: string, index?: number): void {
  const prefix = index === undefined ? '' : 'Record ' + index + ': ';
  result.errors.push(prefix + message);
  result.issues.push({ code, message, ...(index === undefined ? {} : { index }) });
}

function modelError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.startsWith('Invalid documentation: ')) throw error;
  return error.message;
}

function manifestReport(result: ValidationReport): void {
  const manifest = Object.fromEntries(result.revisions.map(item => [item.key, item.revision]));
  model.manifest(manifest);
  result.manifest = manifest;
  result.manifestHash = sha256(model.json(Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b, 'en'))
  )));
}

const formatOf = (record: WireRecord): Format => model.isDynamic(record.data) ? 2 : 1;

// A snapshot is entirely v1 or entirely v2; the reader rejects mixtures and so must validation.
function checkFormats(result: ValidationReport): boolean {
  const formats = new Set(result.revisions.map(item => item.format));
  if (formats.size > 1) {
    issue(result, 'MIXED_SNAPSHOT', 'Snapshot mixes v1 (legacy) and v2 (dynamic sections) records. Use one format for the foundation and every article; never convert published v1 records implicitly.');
    return false;
  }
  const first = result.revisions[0];
  if (first) result.format = first.format;
  return true;
}

// V3 keeps the dynamic content schema; legacy records must be normalized before validation.
export const LEGACY_MESSAGE = 'This is legacy v1 content, not a valid v3 content draft. For published Firebase documentation, ask permission and use migrate_documentation_to_v3; review conversion findings before approveConversion:true. For an unpublished local snapshot only, convert_documentation_to_v2 remains the compatibility normalizer; validate its output before approved v3 publication. Never migrate silently.';
export function rejectLegacy(result: ValidationReport): ValidationReport {
  if (result.format === 1 || result.revisions.some(item => item.format === 1)) {
    issue(result, 'LEGACY_FORMAT', LEGACY_MESSAGE);
    result.ok = false;
  }
  return result;
}

function checkNavigation(foundation: WireRecord, keys: Set<string>): void {
  const navigation = z.object({ entries: z.array(z.object({ key: z.string() })) }).parse(foundation.data.navigation);
  for (const entry of navigation.entries) {
    if (entry.key !== 'foundation' && !keys.has(entry.key)) {
      throw new Error('Invalid documentation: Navigation points to a missing record: ' + entry.key);
    }
  }
}

export function validateRecords(records: unknown, options: ValidationOptions = {}): ValidationReport {
  const result = report(Array.isArray(records) ? records.length : 0, options.complete ?? false);
  if (!Array.isArray(records) || !records.length || records.length > 2000) {
    issue(result, 'INVALID_INPUT', 'Expected a nonempty JSON array containing at most 2000 structured records.');
    return result;
  }
  const valid: WireRecord[] = [];
  const keys = new Set<string>();
  let bytes = 0;
  records.forEach((value: unknown, index) => {
    const parsed = wireRecord.safeParse(value);
    if (!parsed.success) {
      issue(result, 'INVALID_RECORD', 'Expected exactly key,page,collection,title,data; data must be a JSON object and the other fields strings.', index);
      return;
    }
    let record: WireRecord;
    try { record = model.record(value); }
    catch (error) {
      issue(result, 'INVALID_RECORD', modelError(error), index);
      return;
    }
    if (keys.has(record.key)) {
      issue(result, 'DUPLICATE_KEY', 'Duplicate record key: ' + record.key, index);
      return;
    }
    keys.add(record.key);
    const payload = options.originalPayloads?.[index] ?? model.json(record);
    const length = Buffer.byteLength(payload, 'utf8');
    if (length > 700000) {
      issue(result, 'INVALID_RECORD', 'Original revision payload exceeds the 700000-byte safety bound.', index);
      return;
    }
    bytes += length;
    const revision = sha256(payload);
    result.revisions.push({ key: record.key, revision, path: 'documentationRevisions/' + revision, schema: 1, format: formatOf(record), bytes: length });
    valid.push(record);
  });
  if (bytes > (options.maxBytes ?? VALIDATION_REQUEST_BYTES)) issue(result, 'TOO_LARGE', 'Split documentation into smaller batches; each MCP request must fit within 10 MiB including its JSON envelope.');
  if (!result.errors.length) checkFormats(result);
  if (result.complete && !result.errors.length) {
    try {
      model.assemble(valid);
      model.navigationRecords(valid, true);
      const foundation = valid.find(record => record.key === 'foundation');
      if (!foundation) throw new Error('Invalid documentation: published release has no foundation');
      checkNavigation(foundation, keys);
      manifestReport(result);
    } catch (error) { issue(result, 'INVALID_SNAPSHOT', modelError(error)); }
  }
  result.ok = result.errors.length === 0;
  return result;
}

export function validateText(text: string, options: ValidationOptions = {}): ValidationReport {
  let records: unknown;
  try { records = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const result = report(0, options.complete ?? false);
    issue(result, 'INVALID_JSON', 'Invalid JSON input.');
    return result;
  }
  return validateRecords(records, options);
}

function validatePayloads(payloads: string[], complete = false): ValidationReport {
  const records: unknown[] = [];
  for (const [index, payload] of payloads.entries()) {
    try { records.push(JSON.parse(payload)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const result = report(payloads.length, complete);
      issue(result, 'INVALID_JSON', 'Invalid original revision JSON payload.', index);
      return result;
    }
  }
  return validateRecords(records, { complete, originalPayloads: payloads });
}

const receiptContent = z.strictObject({
  schema: z.literal(1), contractVersion: z.literal(contractVersion),
  key: z.string().min(1).max(160), revision: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.union([z.literal(1), z.literal(2)]),
  bytes: z.number().int().min(1).max(700000)
});
export interface ValidationReceipt {
  key: string;
  revision: string;
  format: Format;
  bytes: number;
  token: string;
}
export interface HostedValidationReport extends ValidationReport {
  receipts: ValidationReceipt[];
  nextAction: string;
  limitations: string[];
}
export interface ValidationService {
  records(input: { records?: unknown[] | undefined; payloads?: string[] | undefined; complete?: boolean | undefined }): HostedValidationReport;
  snapshot(foundation: unknown, receipts: string[]): HostedValidationReport;
}

export function createValidationService(signingKey: string): ValidationService {
  if (signingKey.length < 32 || /\s/.test(signingKey)) throw new Error('Validation signing key must contain at least 32 characters and no whitespace.');
  const sign = (encoded: string) => createHmac('sha256', signingKey).update('documentation-validation-v1\0' + encoded).digest();
  const seal = ({ key, revision, format, bytes }: Revision): ValidationReceipt => {
    const content = { schema: 1, contractVersion, key, revision, format, bytes };
    const encoded = Buffer.from(JSON.stringify(content)).toString('base64url');
    return { key, revision, format, bytes, token: encoded + '.' + sign(encoded).toString('base64url') };
  };
  function unseal(token: string): z.infer<typeof receiptContent> | undefined {
    if (token.length > 2048) return undefined;
    const parts = token.split('.');
    if (parts.length !== 2) return undefined;
    const [encoded, signature] = parts;
    if (!encoded || !signature || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return undefined;
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== 32 || actual.toString('base64url') !== signature || !timingSafeEqual(actual, sign(encoded))) return undefined;
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return undefined;
    }
    const parsed = receiptContent.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  }
  function finish(result: ValidationReport): HostedValidationReport {
    return {
      ...result,
      receipts: result.ok ? result.revisions.map(seal) : [],
      nextAction: !result.ok ? 'Fix every reported issue and call hosted validation again. Do not publish.' :
        result.complete ? 'Compare the reviewed outgoing manifest with this validated manifest, preserve the exact payload bytes, obtain approval and verify Firebase publishing capabilities. This report does not authorize writes.' :
          'These records passed structural validation, not full-snapshot validation. Validate remaining record batches, then call validate_documentation_snapshot with the final foundation and all non-foundation receipt tokens.',
      limitations: [
        'Draft documentation is processed in server memory; the application does not intentionally save or log payloads. Hosting and AI-client data policies still apply.',
        'Validation checks the renderer/storage structural contract, not factual code behavior, all semantic cross-links, Firebase access, metadata/transaction capabilities, or human approval.',
        'Receipts attest only to these hashes. A separate publisher must preserve and verify the exact reviewed payload bytes; the MCP cannot prevent writes through another server.',
        'Revalidate changed records. Receipts from a different deployment signing key, or before key rotation, cannot be combined.'
      ]
    };
  }
  return {
    records(input) {
      if ((input.records === undefined) === (input.payloads === undefined)) {
        const result = report(0, input.complete ?? false);
        issue(result, 'INVALID_INPUT', 'Supply exactly one of records (new structured drafts) or payloads (original revision JSON strings).');
        return finish(result);
      }
      return finish(rejectLegacy(input.payloads !== undefined ? validatePayloads(input.payloads, input.complete) :
        validateRecords(input.records, { complete: input.complete ?? false })));
    },
    snapshot(foundationInput, receipts) {
      const result = typeof foundationInput === 'string' ? validatePayloads([foundationInput]) : validateRecords([foundationInput]);
      result.complete = true;
      if (!result.ok) return finish(rejectLegacy(result));
      const foundation = wireRecord.parse(typeof foundationInput === 'string' ? JSON.parse(foundationInput) : foundationInput);
      if (foundation.key !== 'foundation') {
        issue(result, 'INVALID_SNAPSHOT', 'The final snapshot requires the foundation record, not an article.');
      }
      if (receipts.length > 1999) issue(result, 'INVALID_SNAPSHOT', 'A complete snapshot supports at most 2000 records including foundation.');
      const keys = new Set(['foundation']);
      if (!result.errors.length) {
        for (const [index, token] of receipts.entries()) {
          const receipt = unseal(token);
          if (!receipt) { issue(result, 'INVALID_RECEIPT', 'Receipt is invalid or signed by a different key. Revalidate its original record.', index); continue; }
          if (keys.has(receipt.key)) { issue(result, 'DUPLICATE_KEY', 'Duplicate record key: ' + receipt.key, index); continue; }
          keys.add(receipt.key);
          result.revisions.push({ key: receipt.key, revision: receipt.revision, bytes: receipt.bytes, schema: 1, format: receipt.format, path: 'documentationRevisions/' + receipt.revision });
        }
        if (!result.errors.length && checkFormats(result)) {
          try {
            const manifest = Object.fromEntries(result.revisions.map(item => [item.key, item.revision]));
            model.navigationRecords([foundation], true, manifest);
            checkNavigation(foundation, keys);
            manifestReport(result);
          } catch (error) { issue(result, 'INVALID_SNAPSHOT', modelError(error)); }
        }
      }
      result.count = result.revisions.length;
      result.ok = result.errors.length === 0;
      return finish(rejectLegacy(result));
    }
  };
}
