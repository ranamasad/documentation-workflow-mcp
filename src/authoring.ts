import { createRequire } from 'node:module';
import { z } from 'zod';
import { audienceGuide, audienceProfiles, readerSections, resolveReaders, type Audience, type Reader } from './workflows.js';
import { LEGACY_MESSAGE, sha256, validateRecords, type WireRecord } from './validation.js';
import { TECHNICAL, outlineFor, templates, type Depth, type Part } from './outlines.js';
import { describeRule, partRules } from './reader-rules.js';
import { relationshipGuidance } from './relationships.js';

const require = createRequire(import.meta.url);
interface Discovery {
  identity(manifest: Record<string, string>, hash: (text: string) => Promise<string> | string): Promise<string>;
  validateEnvelope(path: string, value: unknown): { schema: number; manifestHash: string; count: number; shards?: { id: string; hash: string; count: number }[]; payload?: string };
  search(entries: DiscoveryEntry[], query: string, limit?: number): (DiscoveryEntry & { score: number; matchedTerms: string[] })[];
}
interface DiscoveryEntry {
  key: string; revision: string; title: string; page: string; summary: string; terms: string[];
  termsTruncated?: boolean; outgoing: string[]; incoming: string[];
}
interface Model {
  metadata(value: unknown): void;
  manifest(value: unknown): Record<string, string>;
  isDynamic(value: unknown): boolean;
}
const discovery: Discovery = require('../vendor/documentation-discovery.js');
const model: Model = require('../vendor/documentation-model.js');
const capabilities = require('../vendor/documentation-schema.js').contract as { blockTypes: string[]; limits: Record<string, number> };

export const purposes = ['support-handbook', 'product-guide', 'admin-guide', 'api-reference', 'release-notes', 'test-handbook', 'internal-architecture'] as const;
export type Purpose = typeof purposes[number];


const purposeSections: Record<Purpose, string[]> = {
  'support-handbook': ['troubleshooting', 'errors', 'guides', 'faq', 'runbooks', 'glossary'],
  'product-guide': ['features', 'guides', 'troubleshooting', 'faq', 'glossary'],
  'admin-guide': ['configuration', 'runbooks', 'troubleshooting', 'faq'],
  'api-reference': ['api', 'errors', 'glossary'],
  'release-notes': ['release-notes'],
  'test-handbook': ['test-scenarios', 'features'],
  'internal-architecture': ['architecture', 'runbooks', 'glossary']
};


export const writingRules = [
  relationshipGuidance,
  'Every published version needs a release-notes article whose value.version matches that version. Keep older entries as history. Describe only this release, link affected articles and state Documentation-only (application behavior unchanged) or Application changes (added, changed or fixed product behavior). Updating a feature article does not itself mean its application feature changed.',
  'Never pad. Word and item minimums are low floors: a short, true section passes. Do not repeat a list or paragraph under another heading, do not reuse one sentence across articles, and never generate articles from a shared template; validation rejects DUPLICATE_CONTENT and BOILERPLATE. If a part has no facts in the code, write "Not applicable: <reason from the code>".',
  'Detailed, not summarised: each feature, guide, runbook, API or architecture article explains the topic fully (typically 400–1500 words) using its outline. Short sections (FAQ, glossary, errors, release notes) still give complete answers with an example.',
  'Use the right block for the content: ordered lists for steps, tables for settings, roles, errors and test scenarios, code blocks for commands, requests and configuration, json for payloads, diagrams (Mermaid) for flows, callouts for warnings and prerequisites, cards for related articles. Never write numbered steps inside a paragraph.',
  'Be specific: exact screen labels, button names, field names, defaults, limits, error messages (verbatim), roles and permissions, API paths, status codes and data fields, all taken from the code.',
  'Write each article for its readers and follow the outline returned for them: testers get test scenarios (happy path, permissions, validation errors, edge cases with preconditions, steps, expected result and priority) and regression checks; product owners get why it matters, acceptance criteria and current limitations; support gets escalation details and answers for customers; end users get tasks without technical detail. Link every feature to its guides and troubleshooting articles.',
  'Readers first, then engineers: plain-language explanation at the top of each article, then the technical parts of the outline (endpoints used, data and JSON with field tables, database tables, events, dependencies), with source references in a details block titled "Technical details". Never put "Evidence:" notes or file paths in the main text.',
  'Tables, not paragraphs, for technical facts: endpoints, request and response fields, database tables, events, status and error codes, settings and source files always go in a table (for example Step | Endpoint | What happens). Validation reports TECHNICAL_PROSE when a paragraph lists them.',
  'Every internal link (#/section/id) must reach an article in the documentation; validation reports BROKEN_LINK otherwise and publishing refuses it. When a feature uses an endpoint, write that endpoint\'s API reference article in the same draft and link both ways (feature "Endpoints used", API "Used by"). Do the same for linked settings, tables and events, or name them without a link.',
  'Write for each reader: an outline part with "audiences" is shown on the website only to those readers (signed-in support sees support parts, testers see tester parts; website admins see everything). Put the same "audiences" on the part\'s heading and on every block of that part. Never write "(for testers)" in a heading.',
  'Long feature and API articles are split into tabs by the "group" on each level-2 heading (Overview, How to use, Questions, Problems, Testing, Technical). Keep the group from the outline on every part heading so readers open only the part they need.',
  'Linked features go at the top of each feature ("Linked features" cards, saying how each is linked). Every third-party service (email, payments, maps, identity, storage, analytics) gets its own External systems article, and each feature\'s "Check these first" table lists its external systems before its API endpoints and data, so support rules them out first.',
  'Every feature has questions: "Frequently asked questions" for end users (short answers with steps) and "Customer questions for support" in depth (answer to give, what to check, how to fix, when to escalate). Each question is a details block titled with the question.',
  'FAQ: one article per topic (for example "Access and sign-in"). Every question is a details block whose title is the question, ending with "?", in the words readers use. Its answer starts with the direct answer, then the steps if the reader must act, how it helps them, and a link to the full article. Never write questions and answers as plain paragraphs.',
  'Use icons only from foundation.icons, and keep navigation free of repeated names.'
];

/** Starter blocks for one outline part. `audiences` limits them to some readers on the website. */
export function partBlocks(part: Part & { audiences?: Reader[] }, index: number): Record<string, unknown>[] {
  const limit = part.audiences ? { audiences: part.audiences } : {};
  return partBody(part, index).map(block => ({ ...block, ...limit,
    ...(part.group && block.type === 'heading' && block.level === 2 ? { group: part.group } : {}) }));
}
function partBody(part: Part, index: number): Record<string, unknown>[] {
  const id = 'part-' + index;
  const prompt = '[Write: ' + part.write + '.]';
  const heading = { id: id + '-heading', type: 'heading', level: 2, text: part.heading };
  const columns = (part.columns ?? ['Item', 'Details']).map((label, order) => ({ key: 'c' + order, label }));
  const row = Object.fromEntries(columns.map((column, order) => [column.key, order === 0 ? prompt : '…']));
  const body: Record<string, Record<string, unknown>> = {
    paragraph: { type: 'paragraph', text: prompt },
    list: { type: 'list', items: [prompt] },
    steps: { type: 'list', ordered: true, items: [prompt] },
    table: { type: 'table', columns, rows: [row] },
    code: { type: 'code', language: 'bash', code: '# ' + prompt },
    json: { type: 'json', value: { example: prompt } },
    diagram: { type: 'diagram', source: 'flowchart LR\n  A["' + part.write.replace(/"/g, "'").slice(0, 60) + '"] --> B["[Write]"]' },
    callout: { type: 'callout', tone: 'warning', text: prompt },
    cards: { type: 'cards', items: [{ title: '[Write: related article]', text: prompt, href: '#/' }] },
    // Details hold a table when the part names columns, so technical facts are never one long paragraph.
    details: { type: 'details', title: part.heading, blocks: [part.columns ? { id: id + '-inner', type: 'table', columns, rows: [row] } : { id: id + '-inner', type: 'paragraph', text: prompt }] }
  };
  if (part.block === 'support-question' || part.block === 'question' && part.count) {
    const detailed = part.block === 'support-question';
    return [heading, ...Array.from({ length: part.count ?? 1 }, (_, n) => ({ id: id + '-q' + n, type: 'details',
      title: '[Write: a question ' + (detailed ? 'customers ask support' : 'users ask') + ' about this feature, in their words?]', blocks: detailed ? [
        { id: id + '-q' + n + '-answer', type: 'paragraph', text: '[Write: the answer to give the customer, in plain words.]' },
        { id: id + '-q' + n + '-check', type: 'table', columns: [{ key: 'c0', label: 'Check' }, { key: 'c1', label: 'Where' }, { key: 'c2', label: 'What it tells you' }],
          rows: [{ c0: '[Write: what support checks first.]', c1: '…', c2: '…' }] },
        { id: id + '-q' + n + '-fix', type: 'list', ordered: true, items: ['[Write: the steps support takes or tells the customer to take.]'] },
        { id: id + '-q' + n + '-escalate', type: 'callout', tone: 'warning', text: '[Write: when to escalate and the details engineering needs.]' }] : [
        { id: id + '-q' + n + '-answer', type: 'paragraph', text: '[Write: the direct answer in one or two sentences.]' },
        { id: id + '-q' + n + '-how', type: 'list', ordered: true, items: ['[Write: the exact steps, with screen and button names.]'] },
        { id: id + '-q' + n + '-helps', type: 'callout', tone: 'info', text: '[Write: how this helps the reader.]' }] }))];
  }
  if (part.block === 'question') {
    return [{ id, type: 'details', title: part.heading, blocks: [
      { id: id + '-answer', type: 'paragraph', text: '[Write: the direct answer in one or two sentences.]' },
      { id: id + '-how', type: 'list', ordered: true, items: ['[Write: the exact steps, with screen and button names, if the reader has to do something.]'] },
      { id: id + '-helps', type: 'callout', tone: 'info', text: '[Write: how this helps the reader, or what it means for their work.]' },
      { id: id + '-more', type: 'link', label: '[Write: the full article]', href: '#/' }] }];
  }
  return part.block === 'details' ? [{ id, ...body.details! }] : [heading, { id, ...body[part.block]! }];
}

const audienceBlocks: Record<Reader, string[]> = {
  'end-users': ['paragraph', 'list', 'callout', 'image', 'cards', 'details', 'link'],
  support: ['paragraph', 'list', 'callout', 'table', 'details', 'cards', 'link'],
  testers: ['paragraph', 'table', 'list', 'code', 'callout', 'details', 'link'],
  'product-owners': ['paragraph', 'list', 'table', 'callout', 'cards', 'diagram', 'link'],
  administrators: ['paragraph', 'list', 'table', 'callout', 'code', 'details', 'link'],
  developers: ['paragraph', 'code', 'table', 'json', 'diagram', 'callout', 'link'],
  internal: ['paragraph', 'diagram', 'table', 'code', 'list', 'details', 'link']
};
const readerNames: Record<Reader, string> = { 'end-users': 'end users', support: 'support', testers: 'testers', 'product-owners': 'product owners',
  administrators: 'administrators', developers: 'developers', internal: 'the engineering team' };
const nameList = (list: Reader[]) => list.length < 2 ? list.map(item => readerNames[item]).join('') :
  list.slice(0, -1).map(item => readerNames[item]).join(', ') + ' and ' + readerNames[list.at(-1)!];

const iconUrl = (name: string) => 'https://api.iconify.design/lucide/' + name + '.svg';

// `audiences` lists every reader (or "everyone"); `audience` is the older single choice, still accepted.
export interface StructureRequest { appName: string; audiences?: Audience[] | undefined; audience?: Audience | undefined; purposes: Purpose[]; sections?: string[] | undefined;
  /** compact: fewer parts, questions and words per article for large projects or tight token budgets. */
  depth?: Depth | undefined }

/** Propose a complete, valid v2 starting structure: foundation plus one example article per section. */
export function designStructure(request: StructureRequest) {
  const selection = request.audiences?.length ? request.audiences : request.audience ? [request.audience] : [];
  const chosenReaders = resolveReaders(selection);
  const requested = [...request.purposes.flatMap(purpose => purposeSections[purpose]), ...chosenReaders.flatMap(reader => readerSections[reader]), ...(request.sections ?? []), 'release-notes'];
  // Technical readers see each feature's endpoints, which link to the API reference, so it must exist.
  if (requested.includes('features') && chosenReaders.some(reader => TECHNICAL.includes(reader))) requested.push('api');
  // Features name the third-party services they rely on; anyone but end users gets the External systems section.
  if (requested.includes('features') && chosenReaders.some(reader => reader !== 'end-users')) requested.push('external-systems');
  const ids = [...new Set(requested)]
    .filter(id => Object.hasOwn(templates, id)).slice(0, 40);
  const chosen = ids.map(id => templates[id]!);
  const today = new Date().toISOString().slice(0, 10);
  const icons = Object.fromEntries(chosen.map(item => [item.icon, iconUrl(item.icon)]));
  const articles: WireRecord[] = chosen.map(item => ({
    key: item.id + '/' + item.example.id, page: item.id, collection: item.collection, title: item.example.title,
    data: { schemaVersion: 2, id: item.example.id, value: item.example.value, order: 0,
      blocks: [{ id: 'summary', type: 'paragraph', text: '[Write: a two or three sentence summary of this ' + item.label.toLowerCase() + ' article for ' + nameList(chosenReaders) + '.]' },
        ...outlineFor(item.id, chosenReaders, request.depth).flatMap(partBlocks)] }
  }));
  const foundation: WireRecord = {
    key: 'foundation', page: 'foundation', collection: '', title: 'Overview, navigation and shared documentation',
    data: {
      schemaVersion: 2,
      audienceCoverage: { version: 1, ...(request.depth === 'compact' ? { depth: 'compact' as const } : {}), readers: chosenReaders, notApplicable: [] },
      meta: { appName: request.appName, subtitle: 'Documentation', createdBy: 'Documentation Workflow MCP', updatedBy: 'Documentation Workflow MCP', updated: today },
      icons,
      startPage: chosen[0]!.id,
      sections: chosen.map((item, order) => ({
        id: item.id, collection: item.collection, layout: item.layout, sort: item.sort, order,
        fields: item.fields.map((field, index) => ({ ...field, order: index })),
        blocks: [{ id: 'intro', type: 'paragraph', text: item.describe }]
      })),
      navigation: {
        // A section only some readers need is hidden from the others (never the start page).
        tabs: chosen.map((item, order) => {
          const audience = item.for && order > 0 ? chosenReaders.filter(reader => item.for!.includes(reader)) : [];
          return { id: item.id, label: item.label, overviewLabel: item.label + ' overview', icon: item.icon,
            href: order === 0 ? '#/' : '#/' + item.id, order, visible: true, expanded: order === 0,
            ...(audience.length && audience.length < chosenReaders.length ? { audiences: audience } : {}) };
        }),
        // Entries sit directly under their section; add groups only to split a long section into distinct named parts.
        groups: [],
        entries: articles.map((article, order) => ({ id: article.page + '-' + String(article.data.id), tab: article.page, group: '',
          key: article.key, label: article.title, href: '#/' + article.key, order, visible: true, searchable: true }))
      }
    }
  };
  const records = [foundation, ...articles];
  const check = validateRecords(records, { complete: true });
  if (!check.ok) throw new Error('Internal structure template failed validation: ' + check.errors.join('; '));
  return {
    format: 2,
    publicationFormat: 3,
    readers: chosenReaders.map(reader => ({ id: reader, label: audienceProfiles[reader].label })),
    audienceGuide: audienceGuide(selection),
    purposes: request.purposes,
    sections: chosen.map(item => ({ id: item.id, label: item.label, collection: item.collection, layout: item.layout, sort: item.sort, fields: item.fields, purpose: item.describe })),
    recommendedBlocks: [...new Set(chosenReaders.flatMap(reader => audienceBlocks[reader]))],
    articleOutlines: Object.fromEntries(chosen.map(item => [item.id, outlineFor(item.id, chosenReaders, request.depth).map(part => ({ heading: part.heading, block: part.block, write: part.write,
      ...(partRules[item.id]?.[part.heading] ? { must: describeRule(partRules[item.id]![part.heading]!) } : {}),
      ...(part.group ? { group: part.group } : {}), ...(part.columns ? { columns: part.columns } : {}), ...(part.count ? { count: part.count } : {}), ...(part.audiences ? { audiences: part.audiences } : {}) }))])),
    writingRules,
    supportedBlocks: capabilities.blockTypes,
    rules: [
      'Show this proposal to the user and agree which of these sections the project needs before writing content. The sections, their ids, collections, layouts and fields are mandatory: never rename, add or change them; validation rejects any difference (OUTLINE_ issues).',
      'Every article is SECTION/ID with data {schemaVersion: 2, id, value: {...}, order?, blocks?}; its section must be declared and navigation.entries must list it. format:2 describes compatible content only; publicationFormat:3 is the recommended encrypted transport. Do not rename schemaVersion to 3.',
      'Icons: add names to foundation.icons pointing at https://api.iconify.design/<set>/<name>.svg and reference those names. Do not use other icon URLs.',
      'Keep audienceCoverage.readers aligned with the readers the user confirmed. Required topics are in audienceGuide.readers[].requirements. For custom section IDs, map each required topic in audienceCoverage.sections. Ask before adding an approved, source-backed notApplicable entry; never invent missing APIs or procedures.',
      'Validate what each reader can actually see. A long engineering-only section cannot satisfy Support or Product Owner depth. Include Support-readable API contracts and errors when APIs exist; source-level implementation can remain restricted.',
      'Write for the readers listed in readers, following audienceGuide. Write one article per real item, each following its section\'s articleOutline (headings and block types), which already holds only the parts these readers need. Replace every [Write: …] prompt and example value with evidence from the code. The outline is mandatory: use every part, with its exact heading, order, group, audiences, first block type and table columns, and meet every rule in each part\'s "must" list (counts, filled cells, quoted messages, required mentions, synthetic data); validation enforces each one (READER_REQUIREMENT); put extra detail inside the part (level-3 headings allowed). When a part truly does not apply, keep its heading and start it with a callout "Not applicable: <the reason, from the code>"; a part whose must list says "required" can never be skipped. Remove sections the project does not need. Do not invent behavior.',
      'Fill every declared field in each article\'s value; an empty field shows "Not provided" on the website. Do not add, remove or rename fields.',
      'Validate with validate_documentation (complete: true) and fix every structural and quality issue before review. After explicit owner/admin approval, initialize a new encrypted environment with publish_documentation format:3 and expected:"empty". For a published legacy environment, first offer the approved migrate_documentation_to_v3 workflow; never silently replace it.'
    ],
    limits: capabilities.limits,
    starter: records
  };
}

// ---- Discovery helpers: pure functions over data the AI read through Firebase MCP ----

const manifestShape = z.record(z.string(), z.string());

export async function discoveryPlan(manifest: Record<string, string>) {
  model.manifest(manifestShape.parse(manifest));
  const manifestHash = await discovery.identity(manifest, sha256);
  const root = 'documentationDiscovery/' + manifestHash;
  return {
    manifestHash,
    root,
    shardPathTemplate: root + '/shards/{id}',
    steps: [
      'Read the root document at `root` through Firebase MCP. If it does not exist, the release has no discovery index: ask an administrator to run the approved index command; do not download every revision.',
      'Read only the shard documents listed in root.shards (path shardPathTemplate with each id).',
      'Call search_discovery with the manifest, the root data and the shards (split across calls if over 10 MiB).',
      'Fetch and verify the selected immutable revisions before editing. Discovery metadata is not source evidence.'
    ]
  };
}

export interface SearchInput {
  manifest: Record<string, string>;
  root: unknown;
  shards: { id: string; data: unknown }[];
  query: string;
  limit?: number | undefined;
}

/** Verify the supplied shards against the root and manifest, then rank lexical matches. */
export async function searchDiscovery(input: SearchInput) {
  model.manifest(manifestShape.parse(input.manifest));
  const manifestHash = await discovery.identity(input.manifest, sha256);
  const rootPath = 'documentationDiscovery/' + manifestHash;
  const root = discovery.validateEnvelope(rootPath, input.root);
  const keys = Object.keys(input.manifest).sort((a, b) => a.localeCompare(b, 'en'));
  const decode = (links: unknown): string[] => {
    if (!Array.isArray(links)) throw new Error('Invalid documentation discovery: invalid adjacency list');
    return links.map(value => {
      if (typeof value === 'string' && !Object.hasOwn(input.manifest, value)) return value;
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= keys.length) throw new Error('Invalid documentation discovery: invalid adjacency ordinal');
      return keys[value as number]!;
    });
  };
  const descriptors = new Map((root.shards ?? []).map(shard => [shard.id, shard]));
  const seen = new Set<string>();
  const entries: DiscoveryEntry[] = [];
  for (const shard of input.shards) {
    const descriptor = descriptors.get(shard.id);
    if (!descriptor) throw new Error('Invalid documentation discovery: shard ' + shard.id + ' is not listed in this root');
    if (seen.has(shard.id)) throw new Error('Invalid documentation discovery: duplicate shard ' + shard.id);
    seen.add(shard.id);
    const data = discovery.validateEnvelope(rootPath + '/shards/' + shard.id, shard.data);
    if (sha256(data.payload ?? '') !== descriptor.hash) throw new Error('Invalid documentation discovery: corrupt shard ' + shard.id);
    const values: unknown = JSON.parse(data.payload ?? '');
    if (!Array.isArray(values) || values.length !== descriptor.count) throw new Error('Invalid documentation discovery: shard count mismatch ' + shard.id);
    for (const value of values as Record<string, unknown>[]) {
      const entry = { ...value, outgoing: decode(value.outgoing), incoming: decode(value.incoming) } as DiscoveryEntry;
      if (typeof entry.key !== 'string' || input.manifest[entry.key] !== entry.revision) {
        throw new Error('Invalid documentation discovery: entry does not match the manifest revision');
      }
      entries.push(entry);
    }
  }
  const results = discovery.search(entries, input.query, input.limit ?? 20).map(item => ({
    key: item.key, revision: item.revision, title: item.title, section: item.page, summary: item.summary,
    score: item.score, matchedTerms: item.matchedTerms, outgoing: item.outgoing, incoming: item.incoming
  }));
  const total = root.shards?.length ?? 0;
  return {
    manifestHash,
    coverage: { shardsSearched: seen.size, shardsTotal: total, complete: seen.size === total },
    results,
    note: seen.size === total
      ? 'Lexical candidates only. No match is not proof a feature is new; confirm scope with the user and fetch the real revisions before editing.'
      : 'Partial search: send the remaining shards in further calls and merge results before concluding anything.'
  };
}

// ---- Change plans in the docs-site CLI format (diff/apply/promote) ----

const environment = z.enum(['development', 'beta', 'production']);
const releaseId = z.string().regex(/^[a-f0-9-]{36}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const areaChange = z.strictObject({ tags: z.array(z.string()), summary: z.string() });
const applyPlan = z.strictObject({
  environment, expected: z.union([z.literal('empty'), releaseId]),
  version: z.string(), tags: z.array(z.string()), summary: z.string(),
  areaChanges: z.record(z.string(), areaChange).optional(),
  expectedRevisions: z.record(z.string(), z.union([z.literal('absent'), revision])),
  records: z.array(z.unknown()).min(1).max(2000),
  remove: z.array(z.string()).optional(),
  acknowledgeMissing: z.boolean().optional()
});
const promotePlan = z.strictObject({
  environment, source: environment, expectedSource: releaseId, expected: z.union([z.literal('empty'), releaseId]),
  version: z.string(), tags: z.array(z.string()), summary: z.string(), areaChanges: z.record(z.string(), areaChange).optional()
});

export interface PlanReport {
  ok: boolean;
  operation: 'apply' | 'promote' | 'unknown';
  issues: string[];
  stats?: { new: number; changed: number; removed: number };
  format?: 1 | 2 | undefined;
  nextAction: string;
}

/**
 * Check a change plan offline before the user runs the docs-site `diff`.
 * baseline (optional): the current release manifest {key: revision} read through Firebase MCP.
 * baselineFormat (optional): 1 or 2, from the published foundation (data.schemaVersion 2 = 2).
 */
export function validateChangePlan(plan: unknown, baseline?: Record<string, string>, baselineFormat?: 1 | 2): PlanReport {
  const issues: string[] = [];
  const done = (operation: PlanReport['operation'], extra: Partial<PlanReport> = {}): PlanReport => ({
    ok: issues.length === 0, operation, issues, ...extra,
    nextAction: issues.length ? 'Fix every issue, then validate the plan again.'
      : 'Run the docs-site diff with this plan, review the exact differences with an administrator, and only then apply with approval.'
  });
  const meta = (value: { version: string; tags: string[]; summary: string; areaChanges?: Record<string, { tags: string[]; summary: string }> | undefined }) => {
    try { model.metadata(value); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    for (const [key, fields] of Object.entries(value.areaChanges ?? {})) {
      try { model.metadata({ ...fields, version: value.version }); }
      catch (error) { issues.push('areaChanges.' + key + ': ' + (error instanceof Error ? error.message : String(error))); }
    }
  };
  if (plan && typeof plan === 'object' && 'source' in plan) {
    const parsed = promotePlan.safeParse(plan);
    if (!parsed.success) { issues.push('Promotion plan shape: ' + parsed.error.issues.map(item => item.path.join('.') + ' ' + item.message).join('; ')); return done('promote'); }
    if (!['development:beta', 'development:production', 'beta:production'].includes(parsed.data.source + ':' + parsed.data.environment)) {
      issues.push('Only Development→Beta, Development→Production or Beta→Production promotions are supported.');
    }
    meta(parsed.data);
    return done('promote');
  }
  const parsed = applyPlan.safeParse(plan);
  if (!parsed.success) {
    issues.push('Apply plan shape: ' + parsed.error.issues.map(item => item.path.join('.') + ' ' + item.message).join('; '));
    return done('unknown');
  }
  const value = parsed.data;
  meta(value);
  const records = validateRecords(value.records, { complete: value.expected === 'empty' });
  issues.push(...records.errors);
  if (records.format === 1) issues.push(LEGACY_MESSAGE);
  const recordKeys = records.revisions.map(item => item.key);
  const remove = value.remove ?? [];
  if (new Set(remove).size !== remove.length || remove.includes('foundation') || remove.some(key => recordKeys.includes(key))) {
    issues.push('remove must list unique existing article keys, never foundation or records being replaced.');
  }
  for (const key of [...recordKeys, ...remove]) {
    if (!Object.hasOwn(value.expectedRevisions, key)) issues.push('expectedRevisions is missing ' + key + ' (use "absent" for new records).');
  }
  for (const key of Object.keys(value.areaChanges ?? {})) {
    if (!recordKeys.includes(key)) issues.push('areaChanges may refer only to records in this plan: ' + key);
  }
  if (value.expected === 'empty') {
    if (remove.length) issues.push('An initial publication to an empty environment cannot remove records.');
    for (const key of recordKeys) if (value.expectedRevisions[key] !== 'absent') issues.push('Initial publication requires "absent" for ' + key);
  }
  const foundation = (value.records as WireRecord[]).find(record => record?.key === 'foundation');
  if (foundation && remove.length) {
    const entries = (foundation.data?.navigation as { entries?: { key: string }[] } | undefined)?.entries ?? [];
    for (const key of remove) if (entries.some(entry => entry.key === key)) issues.push('Remove ' + key + ' from foundation navigation in the same plan.');
  }
  if (baseline) {
    try { model.manifest(baseline); } catch (error) { issues.push('baseline: ' + (error instanceof Error ? error.message : String(error))); }
    for (const key of [...recordKeys, ...remove]) {
      const expectedRevision = value.expectedRevisions[key];
      const current = baseline[key] ?? 'absent';
      if (expectedRevision !== undefined && expectedRevision !== current) issues.push('Revision conflict for ' + key + ': plan expects ' + expectedRevision + ', baseline has ' + current + '. Reread and review again.');
    }
    for (const key of remove) if (!Object.hasOwn(baseline, key)) issues.push('Cannot remove ' + key + ': it is not in the baseline release.');
    // Changing format is an explicit migration: every published record must be replaced or removed.
    if (baselineFormat && records.format && records.format !== baselineFormat) {
      const untouched = Object.keys(baseline).filter(key => !recordKeys.includes(key) && !remove.includes(key));
      if (untouched.length) issues.push('The plan uses format ' + records.format + ' but the published release is format ' + baselineFormat + '. A format change must replace or remove every existing record; untouched: ' + untouched.slice(0, 10).join(', ') + (untouched.length > 10 ? '…' : ''));
    }
  }
  const stats = {
    new: recordKeys.filter(key => value.expectedRevisions[key] === 'absent').length,
    changed: recordKeys.filter(key => value.expectedRevisions[key] && value.expectedRevisions[key] !== 'absent').length,
    removed: remove.length
  };
  return done('apply', { stats, format: records.format });
}
