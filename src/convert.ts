import { createRequire } from 'node:module';
import { validateRecords, wireRecord, type ValidationReport, type WireRecord } from './validation.js';

const require = createRequire(import.meta.url);
interface ConversionReport {
  format: 2;
  foundation: boolean;
  articles: number;
  sections: string[];
  unmapped: { key: string; field: string; dropped?: boolean }[];
  brokenLinks: { key: string; target: string }[];
  droppedNavigation: { id: string; href: string; reason: string }[];
  warnings: string[];
}
interface Converter {
  convertSnapshot(records: WireRecord[]): { records: WireRecord[]; report: ConversionReport };
  convertBatch(foundation: WireRecord, records?: WireRecord[], includeFoundation?: boolean): { records: WireRecord[]; report: ConversionReport };
}
// The website's own converter is the single source of truth for v1 → v2 mapping.
const converter: Converter = require('../vendor/documentation-convert.js');

export interface ConversionInput {
  foundation: unknown;
  records?: unknown[] | undefined;
  payloads?: string[] | undefined;
  complete?: boolean | undefined;
  includeFoundation?: boolean | undefined;
}
export interface ConversionResult {
  ok: boolean;
  errors: string[];
  records: WireRecord[];
  report?: ConversionReport;
  validation?: ValidationReport;
  nextAction: string;
}

function parse(value: unknown, label: string): WireRecord {
  let input = value;
  if (typeof value === 'string') {
    try { input = JSON.parse(value); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(label + ' is not valid JSON.');
    }
  }
  const parsed = wireRecord.safeParse(input);
  if (!parsed.success) throw new Error(label + ' must be a record {key,page,collection,title,data}.');
  return parsed.data;
}

/** Convert v1 records to v2 in request memory, then validate the result with the normal hosted rules. */
export function convertDocumentation(input: ConversionInput): ConversionResult {
  const failed = (message: string): ConversionResult => ({ ok: false, errors: [message], records: [],
    nextAction: 'Fix the input and call convert_documentation_to_v2 again. Nothing was converted or published.' });
  if (input.records !== undefined && input.payloads !== undefined) return failed('Supply at most one of records or payloads.');
  let foundation: WireRecord;
  let articles: WireRecord[];
  try {
    foundation = parse(input.foundation, 'foundation');
    articles = (input.payloads ?? input.records ?? []).map((item, index) => parse(item, 'Record ' + index));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failed(error.message);
  }
  if (foundation.key !== 'foundation') return failed('foundation must be the v1 foundation record (key "foundation").');
  if (foundation.data.schemaVersion === 2) return failed('This content already uses the dynamic schema, so no content normalization is needed. A published legacy release can still migrate to encrypted v3 with migrate_documentation_to_v3 after approval.');
  let converted: { records: WireRecord[]; report: ConversionReport };
  try {
    converted = input.complete ? converter.convertSnapshot([foundation, ...articles.filter(record => record.key !== 'foundation')])
      : converter.convertBatch(foundation, articles, input.includeFoundation ?? articles.length === 0);
  } catch (error) {
    if (!(error instanceof Error) || !/^Invalid (documentation|conversion)/.test(error.message)) throw error;
    return failed(error.message);
  }
  const validation = validateRecords(converted.records, { complete: Boolean(input.complete) });
  return {
    ok: validation.ok, errors: validation.errors, records: converted.records, report: converted.report, validation,
    nextAction: !validation.ok ? 'The converted records failed validation; report the errors. Do not publish.' :
      input.complete ? 'Show the conversion report (sections, unmapped fields, broken links) and obtain approval. This output is normalized content, NOT an encrypted v3 release. For published Firebase documentation, use the approved migrate_documentation_to_v3 workflow instead of replacing it with a plaintext apply. For a new local snapshot, validate it with validate_documentation, then publish with format:3, expected:"empty" and explicit owner/admin approval. Never silently overwrite an existing release.' :
        'Converted one batch. Convert the remaining batches with the same foundation (includeFoundation once), validate each batch with validate_documentation, then confirm the whole snapshot with validate_documentation_snapshot.'
  };
}
