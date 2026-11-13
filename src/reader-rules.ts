// Reader content rules: what each outline part must contain so every reader's "mustExplain" checklist is met.
// The same table is sent to the AI with each outline part (designStructure) and enforced by validation
// (outline-conformance), so what the AI is told and what is checked can never drift apart.

import type { Reader } from './workflows.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RuleBlock { type?: string; text?: string; title?: string; label?: string; ordered?: boolean; items?: Json[]; code?: string;
  source?: string; value?: Json; audiences?: string[]; columns?: { key?: string; label?: string }[]; rows?: Record<string, Json>[]; blocks?: RuleBlock[] }

export const scenarioTypes = ['Success', 'Permission', 'Validation', 'Boundary', 'Conflict', 'Dependency failure'] as const;
const releaseTypes = ['New', 'Changed', 'Hotfix'];

interface Mention { label: string; pattern: RegExp }
export interface PartRule {
  serves: [Reader, string][];        // the reader requirement this part satisfies
  noSkip?: boolean;                  // "Not applicable" is refused: every documented item has this
  minWords?: number;                 // words in the whole part
  minItems?: number;                 // items in the part's first list
  itemWords?: number;                // words in every list item
  minRows?: number;                  // rows in the part's first table
  filled?: string[] | true;          // table columns that must be filled in every row (true: all)
  quoted?: string;                   // table column whose every cell quotes the exact message in quotation marks
  quote?: boolean;                   // the part quotes at least one exact message
  types?: { column: string; values: readonly string[]; all?: boolean };
  minCards?: number;
  arrows?: number;                   // connections in the part's diagram
  code?: boolean;                    // a non-empty code block
  json?: boolean;                    // a non-empty json value
  mention?: Mention[];               // each must appear somewhere in the part
  untested?: boolean;                // one list item starts "Not tested:"
  vague?: boolean;                   // no untestable wording
  noMetrics?: boolean;               // no invented percentages or growth claims
  synthetic?: boolean;               // only example email addresses and domains
  plain?: boolean;                   // no endpoints, table, field or setting names, or source files
}

const access: Mention = { label: 'who may do it (access, role or permission)', pattern: /\b(access|role|permission|admin|administrator|owner)s?\b/i };
const evidence: Mention = { label: 'the evidence engineering needs (IDs, time, screenshots or logs)', pattern: /\b(id|ids|time|timestamp|screenshot|screenshots|log|logs)\b/i };
const R = (reader: Reader, need: string): [Reader, string] => [reader, need];

/** Rules per section and outline heading. A part absent from the readers' outline is not checked. */
export const partRules: Record<string, Record<string, PartRule>> = {
  features: {
    'Overview': { serves: [R('end-users', 'Goal and eligibility')], noSkip: true, minWords: 30 },
    'Linked features': { serves: [R('internal', 'Dependencies')], minCards: 1 },
    'Why it matters': { serves: [R('product-owners', 'Business problem and current outcome')], noSkip: true, minWords: 40, noMetrics: true },
    'Who can use it': { serves: [R('end-users', 'Goal and eligibility'), R('product-owners', 'Eligible roles and user journeys')], noSkip: true, minRows: 1, filled: true },
    'How it works': { serves: [R('developers', 'End-to-end flow'), R('internal', 'End-to-end components and data flow')], noSkip: true, arrows: 3 },
    'Step by step': { serves: [R('end-users', 'Exact steps and inputs'), R('product-owners', 'User journeys')], noSkip: true, minItems: 3 },
    'Settings and limits': { serves: [R('end-users', 'Limitations')], minRows: 1, filled: true },
    'Business rules': { serves: [R('product-owners', 'Implemented rules')], noSkip: true, minRows: 2, filled: true },
    'Frequently asked questions': { serves: [R('end-users', 'Validation, limitations and recovery')], noSkip: true },
    'Customer questions for support': { serves: [R('support', 'Customer symptoms, checks, recovery and escalation')], noSkip: true },
    'Current limitations': { serves: [R('product-owners', 'Limitations'), R('support', 'Known issues')], minItems: 1 },
    'Errors and edge cases': { serves: [R('end-users', 'Validation and recovery'), R('support', 'Customer symptoms and exact messages')], noSkip: true,
      minRows: 2, filled: true, quoted: 'What the user sees' },
    'Check these first': { serves: [R('support', 'Ordered diagnostic checks and safe recovery')], noSkip: true, minRows: 2, filled: true },
    'What happens in each scenario': { serves: [R('support', 'Failure paths'), R('internal', 'Contracts, data changes and failure paths')], noSkip: true, minRows: 3, filled: true },
    'Risks': { serves: [R('support', 'Known issues in plain words'), R('administrators', 'Limits, risks and escalation')], minRows: 1, filled: true, plain: true },
    'Known issues': { serves: [R('developers', 'Known bugs and risky code'), R('internal', 'Known risks')], minItems: 1 },
    'Acceptance criteria': { serves: [R('product-owners', 'Verifiable acceptance criteria')], noSkip: true, minItems: 3, itemWords: 6, vague: true },
    'Test scenarios': { serves: [R('testers', 'Success, permissions, validation, boundaries, conflicts and dependency failures')], noSkip: true,
      minRows: scenarioTypes.length, filled: true, types: { column: 'Type', values: scenarioTypes, all: true }, synthetic: true },
    'Regression checks': { serves: [R('testers', 'Regression impact and what remains untested')], noSkip: true, minItems: 2, untested: true },
    'Applications and services involved': { serves: [R('internal', 'End-to-end components')], noSkip: true, minCards: 1 },
    'External systems used': { serves: [R('support', 'External dependencies')], minCards: 1 },
    'Endpoints used': { serves: [R('developers', 'Contracts')], minCards: 1 },
    'Data and JSON': { serves: [R('developers', 'Typed request/response fields and examples')], json: true },
    'Database tables and objects': { serves: [R('developers', 'Data'), R('internal', 'Data changes')], minRows: 1, filled: true },
    'Events and background jobs': { serves: [R('developers', 'Events and dependencies')], minRows: 1, filled: true },
    'Technical details': { serves: [R('internal', 'Source evidence')], noSkip: true, minRows: 1, filled: true },
    'Related': { serves: [R('end-users', 'Where to read next')], minCards: 1 }
  },
  guides: {
    'Before you start': { serves: [R('end-users', 'Eligibility')], minItems: 1 },
    'Steps': { serves: [R('end-users', 'Exact steps and inputs')], noSkip: true, minItems: 3 },
    'Check that it worked': { serves: [R('end-users', 'Worked example and successful outcome')], noSkip: true, minItems: 1 },
    'If something goes wrong': { serves: [R('end-users', 'Validation, limitations and recovery')], noSkip: true, minRows: 1, filled: true, quoted: 'What the user sees' },
    'Example': { serves: [R('administrators', 'Worked example')], code: true },
    'Technical details': { serves: [R('support', 'What happens behind each step')], minRows: 1, filled: true }
  },
  troubleshooting: {
    'What you see': { serves: [R('support', 'Customer symptoms and exact messages')], noSkip: true, quote: true },
    'Likely causes': { serves: [R('support', 'Ordered diagnostic checks')], noSkip: true, minRows: 2, filled: true },
    'How to fix it': { serves: [R('support', 'Safe recovery')], noSkip: true, minItems: 2 },
    'When to escalate': { serves: [R('support', 'Escalation conditions and approved diagnostic evidence')], noSkip: true, minItems: 2, mention: [evidence] },
    'Technical details': { serves: [R('developers', 'Errors and code path')], minRows: 1, filled: true }
  },
  faq: {
    'About these questions': { serves: [R('end-users', 'Goal')], minWords: 10 },
    'Related': { serves: [R('end-users', 'Where to read next')], minCards: 1 }
  },
  errors: {
    'What it means': { serves: [R('support', 'Error meanings')], noSkip: true, minWords: 12 },
    'When it happens': { serves: [R('support', 'Customer symptoms')], noSkip: true, minItems: 1 },
    'How to fix it': { serves: [R('support', 'Safe recovery')], noSkip: true, minItems: 1 },
    'Technical details': { serves: [R('developers', 'Validation and errors')], minRows: 1, filled: true }
  },
  api: {
    'Overview': { serves: [R('support', 'API purpose')], noSkip: true, minWords: 20 },
    'Authentication and permissions': { serves: [R('developers', 'Exact authentication and authorization contracts')], noSkip: true, minRows: 1, filled: true },
    'Request fields': { serves: [R('developers', 'Typed request fields')], minRows: 1, filled: ['Field', 'In', 'Type', 'Required', 'Meaning'] },
    'Example request': { serves: [R('developers', 'Complete synthetic request example')], noSkip: true, code: true, synthetic: true },
    'Response fields': { serves: [R('developers', 'Typed response fields')], minRows: 1, filled: ['Field', 'Type', 'Always present', 'Meaning'] },
    'Example response': { serves: [R('developers', 'Complete synthetic response example')], noSkip: true, json: true, synthetic: true },
    'Errors': { serves: [R('support', 'Error meanings'), R('developers', 'Errors')], noSkip: true, minRows: 1, filled: ['Status', 'Message', 'Cause and fix'] },
    'Side effects': { serves: [R('developers', 'Data, events and dependencies')], minRows: 1, filled: true },
    'Used by': { serves: [R('support', 'Which features call it')], minCards: 1 },
    'Limits and behaviour': { serves: [R('developers', 'Limits, timeouts, retries and concurrency')], noSkip: true, minItems: 4, mention: [
      { label: 'timeouts', pattern: /\btime-?outs?\b/i },
      { label: 'retries', pattern: /\bretr(y|ies|ied)\b/i },
      { label: 'concurrency or idempotency (what happens on duplicate or parallel calls)', pattern: /\b(concurren\w*|idempoten\w*|duplicate\w*|parallel|race)\b/i },
      { label: 'rate limits, pagination or size limits', pattern: /\b(rate[- ]limit\w*|paginat\w*|page size|size limit|maximum|max\.?|limit)\b/i }] },
    'Technical details': { serves: [R('internal', 'Source evidence')], noSkip: true, minRows: 1, filled: true }
  },
  'test-scenarios': {
    'Goal': { serves: [R('testers', 'What the scenario proves')], noSkip: true, minWords: 15 },
    'Preconditions': { serves: [R('testers', 'Preconditions and synthetic test data')], noSkip: true, minItems: 1, synthetic: true },
    'Steps': { serves: [R('testers', 'Steps with observable expected results')], noSkip: true, minItems: 2 },
    'Expected results': { serves: [R('testers', 'Observable expected results')], noSkip: true, minItems: 1 },
    'Variations and edge cases': { serves: [R('testers', 'Permissions, validation, boundaries, conflicts and dependency failures')], noSkip: true,
      minRows: 2, filled: true, types: { column: 'Type', values: scenarioTypes }, synthetic: true },
    'Test data': { serves: [R('testers', 'Synthetic test data')], noSkip: true, code: true, synthetic: true }
  },
  architecture: {
    'Responsibility': { serves: [R('internal', 'Ownership')], noSkip: true, minWords: 20 },
    'How it fits': { serves: [R('internal', 'End-to-end components and data flow')], noSkip: true, arrows: 2 },
    'Interfaces': { serves: [R('developers', 'Compatibility boundaries')], noSkip: true, minRows: 1, filled: true },
    'Data': { serves: [R('internal', 'Data changes')], minRows: 1, filled: true },
    'Operations': { serves: [R('internal', 'Operational limits, recovery and rollback')], noSkip: true, minItems: 2 },
    'Source references': { serves: [R('internal', 'Dependencies, ownership and source evidence')], noSkip: true, minRows: 1, filled: true }
  },
  'external-systems': {
    'Overview': { serves: [R('support', 'External dependencies')], noSkip: true, minWords: 20 },
    'Features that use it': { serves: [R('support', 'Affected features')], noSkip: true, minCards: 1 },
    'How to check it is working': { serves: [R('administrators', 'Monitoring and failure diagnosis')], noSkip: true, minRows: 1, filled: true },
    'When it fails': { serves: [R('support', 'How to distinguish their failures')], noSkip: true, minRows: 1, filled: true },
    'Before you blame the API': { serves: [R('support', 'How to distinguish their failures')], noSkip: true, minItems: 2 },
    'Status page and contacts': { serves: [R('administrators', 'Escalation')], minRows: 1, filled: true },
    'Configuration': { serves: [R('administrators', 'Settings')], minRows: 1, filled: true },
    'Technical details': { serves: [R('developers', 'Dependencies')], minRows: 1, filled: true }
  },
  configuration: {
    'What it controls': { serves: [R('administrators', 'Settings and consequences')], noSkip: true, minWords: 15 },
    'Values': { serves: [R('administrators', 'Settings, defaults and consequences')], noSkip: true, minRows: 1, filled: true },
    'How to change it': { serves: [R('administrators', 'Prerequisites and least-privilege access')], noSkip: true, minItems: 2, mention: [access] },
    'Example': { serves: [R('developers', 'Example configuration')], code: true },
    'Side effects and risks': { serves: [R('administrators', 'Limits, risks and escalation')], noSkip: true, minWords: 10 }
  },
  runbooks: {
    'When to use this': { serves: [R('administrators', 'Failure diagnosis')], noSkip: true, minWords: 15 },
    'Before you start': { serves: [R('administrators', 'Prerequisites and least-privilege access')], noSkip: true, minItems: 2, mention: [access] },
    'Procedure': { serves: [R('administrators', 'Safe recovery')], noSkip: true, minItems: 3 },
    'Commands': { serves: [R('internal', 'Operational procedure')], code: true },
    'Verify': { serves: [R('administrators', 'Recovery with verification')], noSkip: true, minItems: 1 },
    'Roll back': { serves: [R('administrators', 'Safe backup, recovery and rollback')], noSkip: true, minItems: 1 }
  },
  'release-notes': {
    'Highlights': { serves: [R('product-owners', 'Release impact without invented metrics or roadmap claims')], noSkip: true, minWords: 10, noMetrics: true },
    'Changes': { serves: [R('testers', 'Regression impact')], noSkip: true, minRows: 1, filled: true, types: { column: 'Type', values: releaseTypes } },
    'Action needed': { serves: [R('administrators', 'What to do after the release')], noSkip: true, minWords: 3 },
    'Affected articles': { serves: [R('product-owners', 'Release impact')], minCards: 1 }
  },
  glossary: {
    'Definition': { serves: [R('end-users', 'Terms')], noSkip: true, minWords: 8 },
    'Example': { serves: [R('end-users', 'Terms in use')], minWords: 8 },
    'Related': { serves: [R('end-users', 'Where to read next')], minCards: 1 }
  }
};

const ROADMAP = /\b(coming soon|on the roadmap|roadmap|will (soon )?be (added|supported|available|released|introduced)|planned for (a |the )?(future|next)|in a (future|later|upcoming) (release|version)|we plan to)\b/i;
const VAGUE = /\b(should work|works? (correctly|properly|fine|as expected)|properly|user[- ]friendly|intuitive|seamless(ly)?|fast|quickly|easily|etc\.?|and so on)\b/i;
const METRIC = /\b\d+(\.\d+)?\s?%|\b(increase|improve|reduce|boost|cut)[sd]? \w* ?by \d/i;
const EMAIL = /[\w.+-]+@([\w-]+\.)+[a-z]{2,}/gi;
const SAFE_DOMAIN = /@(([\w-]+\.)*example\.(com|org|net)|([\w-]+\.)*(invalid|test|localhost|example))$/i;
// Technical identifiers end users must not have to read: endpoints, snake_case and UPPER_CASE names, source files, paths.
const TECH = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+|(?:^|\s)\/v\d+\/[\w{}/:-]+|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[\w/-]+\.(ts|tsx|js|py|go|java|kt|swift|cs|rb|php)\b|\b[\w.-]+(?:\/[\w.-]+){2,}/;
const PLAIN_SECTIONS = new Set(['features', 'guides', 'faq', 'troubleshooting', 'errors', 'glossary']);

export function textOf(blocks: RuleBlock[]): string {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  for (const block of blocks) {
    add(block.text); add(block.title); add(block.label); add(block.items); add(block.rows); add(block.code); add(block.source);
    if (block.type === 'json') add(JSON.stringify(block.value ?? null));
    if (block.blocks) out.push(textOf(block.blocks));
  }
  return out.join('\n');
}
const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
function find(blocks: RuleBlock[], type: string): RuleBlock | undefined {
  for (const block of blocks) {
    if (block.type === type) return block;
    const inner = block.blocks ? find(block.blocks, type) : undefined;
    if (inner) return inner;
  }
  return undefined;
}
const itemText = (item: Json) => typeof item === 'string' ? item : JSON.stringify(item ?? '');
const cell = (table: RuleBlock, label: string, row: Record<string, Json>) => {
  const key = (table.columns ?? []).find(column => column.label === label)?.key;
  const value = key === undefined ? undefined : row[key];
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
};
const QUOTED = /["“”«»]\s*\S[^"“”«»]*["“”«»]/;

/** What the AI is told for one part; the same text names the rule when it is broken. */
export function describeRule(rule: PartRule): string[] {
  const must: string[] = [];
  if (rule.noSkip) must.push('required: "Not applicable" is refused');
  if (rule.minWords) must.push('at least ' + rule.minWords + ' words');
  if (rule.minItems) must.push('at least ' + rule.minItems + ' list items' + (rule.itemWords ? ', each at least ' + rule.itemWords + ' words' : ''));
  if (rule.minRows) must.push('at least ' + rule.minRows + ' table rows');
  if (rule.filled) must.push(rule.filled === true ? 'every table cell filled' : 'columns ' + rule.filled.join(', ') + ' filled in every row');
  if (rule.quoted) must.push('every "' + rule.quoted + '" cell quotes the exact message in quotation marks');
  if (rule.quote) must.push('quote the exact message the reader sees in quotation marks');
  if (rule.types) must.push('column ' + rule.types.column + ' uses only ' + rule.types.values.join(', ') + (rule.types.all ? ', with one row for each (a type that cannot happen: Expected result "Not applicable: <reason>")' : ''));
  if (rule.minCards) must.push('at least ' + rule.minCards + ' card');
  if (rule.arrows) must.push('a diagram with at least ' + rule.arrows + ' connections');
  if (rule.code) must.push('a non-empty code block');
  if (rule.json) must.push('a complete non-empty JSON example');
  for (const mention of rule.mention ?? []) must.push('mention ' + mention.label);
  if (rule.untested) must.push('one item starting "Not tested:" naming what is not covered (or "Not tested: nothing known")');
  if (rule.vague) must.push('checkable statements only: no "works correctly", "properly", "user-friendly", "fast", "etc."');
  if (rule.noMetrics) must.push('no percentages or invented growth claims');
  if (rule.synthetic) must.push('synthetic data only: emails at example.com, .invalid or .test');
  if (rule.plain) must.push('plain words: no endpoints, table, field or setting names, or source files');
  return must;
}

/** Content issues for one part of an article; `body` holds the part's blocks after its heading. */
export function checkPart(section: string, heading: string, body: RuleBlock[], add: (code: string, message: string) => void) {
  const rule = partRules[section]?.[heading];
  if (!rule) return;
  const need = rule.serves.map(([reader, what]) => reader + ': ' + what).join('; ');
  const fail = (message: string) => add('READER_REQUIREMENT', '"' + heading + '" ' + message + ' (needed for ' + need + ').');
  const first = body[0];
  if (first?.type === 'callout' && /^Not applicable:/.test(first.text ?? '')) {
    if (rule.noSkip) fail('cannot be marked "Not applicable": every ' + section + ' article must have it');
    return;
  }
  const text = textOf(body);
  if (rule.minWords && words(text) < rule.minWords) fail('needs at least ' + rule.minWords + ' words; it has ' + words(text));
  if (rule.minItems || rule.untested || rule.itemWords) {
    const items = (find(body, 'list')?.items ?? []).map(itemText);
    if (rule.minItems && items.length < rule.minItems) fail('needs at least ' + rule.minItems + ' list items; it has ' + items.length);
    if (rule.itemWords && items.some(item => words(item) < rule.itemWords!)) fail('needs every item to be a full statement of at least ' + rule.itemWords + ' words');
    if (rule.untested && !items.some(item => /^Not tested:/.test(item.trim()))) fail('needs one item starting "Not tested:" that names what is not covered');
  }
  const table = rule.minRows || rule.filled || rule.quoted || rule.types ? find(body, 'table') : undefined;
  if (rule.minRows || rule.filled || rule.quoted || rule.types) {
    const rows = table?.rows ?? [];
    if (!table || rows.length < (rule.minRows ?? 1)) fail('needs a table with at least ' + (rule.minRows ?? 1) + ' rows; it has ' + rows.length);
    if (table && rule.filled) {
      const columns = rule.filled === true ? (table.columns ?? []).map(column => column.label ?? '') : rule.filled;
      const empty = columns.filter(label => rows.some(row => !cell(table, label, row) || /^(…|\.\.\.|-|—|n\/a)$/i.test(cell(table, label, row))));
      if (empty.length) fail('has empty or placeholder cells in ' + empty.join(', ') + '; fill every row');
    }
    if (table && rule.quoted && rows.some(row => !QUOTED.test(cell(table, rule.quoted!, row)))) {
      fail('must quote the exact message in quotation marks in every "' + rule.quoted + '" cell');
    }
    if (table && rule.types && !(table.columns ?? []).some(column => column.label === rule.types!.column)) {
      fail('needs a ' + rule.types.column + ' column with ' + rule.types.values.join(', '));
    } else if (table && rule.types) {
      const values = rows.map(row => cell(table, rule.types!.column, row));
      const unknown = [...new Set(values.filter(value => !rule.types!.values.includes(value)))];
      if (unknown.length) fail('uses unknown ' + rule.types.column + ' values: ' + unknown.join(', ') + '. Use only ' + rule.types.values.join(', '));
      const missing = rule.types.all ? rule.types.values.filter(value => !values.includes(value)) : [];
      if (missing.length) fail('needs a row for each ' + rule.types.column + '; missing ' + missing.join(', ') + ' (a type that cannot happen gets Expected result "Not applicable: <reason>")');
    }
  }
  if (rule.quote && !QUOTED.test(text)) fail('must quote the exact message the reader sees in quotation marks');
  if (rule.minCards && ((find(body, 'cards')?.items ?? []) as Json[]).length < rule.minCards) fail('needs at least ' + rule.minCards + ' card');
  if (rule.arrows) {
    const source = find(body, 'diagram')?.source ?? '';
    const connections = (source.match(/-{1,2}>{1,2}|==>|-\.->|---/g) ?? []).length;
    if (connections < rule.arrows) fail('needs a diagram with at least ' + rule.arrows + ' connections between components; it has ' + connections);
  }
  if (rule.code && !(find(body, 'code')?.code ?? '').split('\n').some(line => line.trim() && !/^\s*(#|\/\/)/.test(line))) fail('needs a non-empty code block');
  if (rule.json) {
    const value = find(body, 'json')?.value;
    if (value === undefined || value === null || (typeof value === 'object' && !Object.keys(value).length)) fail('needs a complete non-empty JSON example');
  }
  for (const mention of rule.mention ?? []) if (!mention.pattern.test(text)) fail('must mention ' + mention.label);
  if (rule.vague) {
    const vague = (find(body, 'list')?.items ?? []).map(itemText).find(item => VAGUE.test(item));
    if (vague) fail('must be checkable; "' + vague.slice(0, 80) + '" uses vague wording ("' + vague.match(VAGUE)![0] + '")');
  }
  if (rule.noMetrics && METRIC.test(text)) fail('must not state percentages or growth claims the code cannot prove ("' + text.match(METRIC)![0] + '")');
  if (rule.plain && TECH.test(text)) fail('must be in plain words; "' + text.match(TECH)![0] + '" belongs in a part for developers');
  if (rule.synthetic) {
    const real = (text.match(EMAIL) ?? []).filter(address => !SAFE_DOMAIN.test(address));
    if (real.length) fail('must use synthetic data only; replace ' + [...new Set(real)].slice(0, 3).join(', ') + ' with addresses at example.com, .invalid or .test');
  }
}

/** Article-wide reader rules: no roadmap promises anywhere, and plain language in what end users see. */
export function checkArticle(section: string, blocks: RuleBlock[], readers: Reader[], add: (code: string, message: string) => void) {
  const all = textOf(blocks);
  const roadmap = all.match(ROADMAP);
  if (roadmap) add('READER_REQUIREMENT', 'Document what the code does today, not plans: remove "' + roadmap[0] + '" (needed for product-owners: no roadmap claims).');
  if (!readers.includes('end-users') || !PLAIN_SECTIONS.has(section)) return;
  const visible = blocks.filter(block => !block.audiences || block.audiences.includes('end-users'))
    .filter(block => !['code', 'json', 'diagram'].includes(block.type ?? '') && !(block.type === 'details' && /technical|source/i.test(block.title ?? '')));
  const technical = textOf(visible).match(TECH);
  if (technical) add('READER_REQUIREMENT', 'End users see "' + technical[0] + '": endpoints, table, field and environment names and source files belong in a part for technical readers only (needed for end-users: plain language).');
}
