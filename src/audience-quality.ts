import { depthLimits } from './outlines.js';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { Reader } from './workflows.js';

export const audienceTopics = ['features', 'guides', 'troubleshooting', 'faq', 'api', 'errors', 'test-scenarios',
  'release-notes', 'configuration', 'runbooks', 'architecture', 'external-systems'] as const;
export type AudienceTopic = typeof audienceTopics[number];

export const audienceRequirements: Record<Reader, { topics: AudienceTopic[]; mustExplain: string[] }> = {
  'end-users': {
    topics: ['features', 'guides', 'faq'],
    mustExplain: ['Goal and eligibility', 'Exact steps and inputs', 'Worked example and successful outcome', 'Validation, limitations and recovery']
  },
  support: {
    topics: ['features', 'guides', 'troubleshooting', 'faq', 'api', 'errors', 'external-systems'],
    mustExplain: ['Customer symptoms and exact messages', 'Ordered diagnostic checks and safe recovery',
      'API purpose, method/path, authentication, request/response fields and error meanings when APIs exist',
      'External dependencies and how to distinguish their failures', 'Escalation conditions and approved diagnostic evidence']
  },
  testers: {
    topics: ['features', 'test-scenarios', 'api', 'errors', 'release-notes'],
    mustExplain: ['Preconditions and synthetic test data', 'Steps with observable expected results',
      'Success, permissions, validation, boundaries, conflicts and dependency failures', 'Regression impact and what remains untested']
  },
  'product-owners': {
    topics: ['features', 'test-scenarios', 'release-notes'],
    mustExplain: ['Business problem and current outcome', 'Eligible roles and user journeys',
      'Verifiable acceptance criteria', 'Implemented rules, limitations and failure impact', 'Release impact without invented metrics or roadmap claims']
  },
  administrators: {
    topics: ['configuration', 'runbooks', 'troubleshooting'],
    mustExplain: ['Prerequisites and least-privilege access', 'Settings, defaults and consequences',
      'Monitoring and failure diagnosis', 'Safe backup, recovery and rollback with verification', 'Limits, risks and escalation']
  },
  developers: {
    topics: ['features', 'api', 'errors', 'architecture', 'configuration', 'external-systems'],
    mustExplain: ['Exact authentication and authorization contracts', 'Typed request/response field tables and complete synthetic examples',
      'Validation, errors, limits, timeouts, retries and concurrency', 'Data, events and dependencies', 'End-to-end flow and compatibility boundaries']
  },
  internal: {
    topics: ['features', 'architecture', 'api', 'configuration', 'runbooks', 'external-systems'],
    mustExplain: ['End-to-end components and data flow', 'Dependencies, ownership and source evidence',
      'Contracts, data changes and failure paths', 'Operational limits, recovery and rollback', 'Known risks, verified tests and coverage gaps']
  }
};

const reader = z.custom<Reader>(value => typeof value === 'string' && Object.hasOwn(audienceRequirements, value), 'Unknown reader');
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const audienceCoverageSchema = z.strictObject({
  version: z.literal(1),
  depth: z.enum(['standard', 'compact']).optional(),
  readers: z.array(reader).min(1).max(7).refine(unique, 'Readers must be unique'),
  sections: z.partialRecord(z.enum(audienceTopics), z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1).max(40).refine(unique)).optional(),
  notApplicable: z.array(z.strictObject({
    reader, topic: z.enum(audienceTopics), reason: z.string().trim().min(40).max(2000), confirmed: z.literal(true)
  })).max(84).default([])
});

export const audienceDepth = {
  articleWords: depthLimits.standard.articleWords, referenceWords: 80, faqWords: 150, structuredTypes: 2,
  rules: [
    'Minimums apply independently to the content each confirmed reader can actually see, not the combined article.',
    'Word counts are a floor, not a writing target. Cover every applicable item in that reader’s mustExplain checklist with source-backed facts.',
    'Use meaningful headings and at least two substantive structured block types for long articles; empty tables, cards and lists do not count.',
    'API articles need a visible field table; Developers and Internal Engineering also need a synthetic code or JSON example. QA scenario tables need preconditions, steps and expected outcomes.',
    'FAQ articles need at least three expandable questions, each with an answer of at least 25 words visible to the reader.',
    'Do not pad with repetition or invent endpoints, examples, ownership, procedures or test results.',
    'Never silently hide API documentation from Support when the product has APIs. Keep source-level internals in collapsed technical details.',
    'Omit a required topic only after verified non-applicability and explicit user confirmation; record the reason in audienceCoverage.notApplicable.'
  ]
};

export interface AudienceQualityIssue { key: string; code: string; message: string; reader?: Reader; topic?: AudienceTopic }
interface RecordData { key: string; page?: string; data?: { [key: string]: unknown } }
const renderer: { forReader(value: unknown, reader: Reader): boolean; searchText(docs: unknown, record: unknown, reader: Reader): string } =
  createRequire(import.meta.url)('../vendor/documentation-renderer.js');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const objects = (value: unknown) => Array.isArray(value) ? value.filter(object) : [];
const visible = (value: Record<string, unknown> | undefined, role: Reader) =>
  Boolean(value && value.visible !== false && renderer.forReader(value, role));
function visibleBlocks(value: unknown, role: Reader): Record<string, unknown>[] {
  return objects(value).filter(block => visible(block, role)).flatMap(block =>
    [block, ...(block.type === 'details' ? visibleBlocks(block.blocks, role) : [])]);
}
function fieldValue(value: unknown, path: unknown): unknown {
  return typeof path === 'string' ? path.split('.').reduce<unknown>((current, key) =>
    object(current) && Object.hasOwn(current, key) ? current[key] : undefined, value) : undefined;
}
function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0) &&
    (!Array.isArray(value) || value.length > 0) && (!object(value) || Object.keys(value).length > 0);
}
function substantive(block: Record<string, unknown>, role: Reader): boolean {
  switch (block.type) {
    case 'list': return Array.isArray(block.items) && block.items.some(item => typeof item === 'string' && item.trim());
    case 'table': return objects(block.rows).some(row =>
      objects(block.columns).some(column => column.visible !== false && hasValue(fieldValue(row, column.key))));
    case 'cards': return objects(block.items).some(item => item.visible !== false && typeof item.title === 'string' && item.title.trim().length > 0);
    case 'code': return typeof block.code === 'string' && block.code.trim().length > 0;
    case 'json': return hasValue(block.value);
    case 'fields': return Array.isArray(block.fields)
      ? objects(block.fields).some(field => field.visible !== false && hasValue(fieldValue(block.value, field.key)))
      : hasValue(block.value);
    case 'diagram': return typeof block.source === 'string' && block.source.trim().length > 0;
    case 'details': return objects(block.blocks).filter(child => visible(child, role)).some(child => child.type === 'paragraph' ?
      typeof child.text === 'string' && child.text.trim().length > 0 : substantive(child, role));
    case 'image': return typeof block.src === 'string' && typeof block.alt === 'string' && block.alt.trim().length > 0;
    case 'callout': return typeof block.text === 'string' && block.text.trim().length > 0;
    default: return false;
  }
}

export function checkAudienceCoverage(records: RecordData[], foundation: RecordData | undefined,
  options: { required?: boolean; complete?: boolean } = {}) {
  const issues: AudienceQualityIssue[] = [];
  const plan = foundation?.data?.audienceCoverage;
  const summary = { checked: false, complete: options.complete === true, readers: [] as Reader[], articlesChecked: 0, topicsChecked: 0 };
  if (plan === undefined && !options.required) return { issues, summary };
  const parsed = audienceCoverageSchema.safeParse(plan);
  if (!parsed.success) {
    issues.push({ key: 'foundation', code: plan === undefined ? 'AUDIENCE_PLAN_REQUIRED' : 'INVALID_AUDIENCE_PLAN',
      message: plan === undefined
        ? 'Declare the user-confirmed readers in foundation.data.audienceCoverage before publication. Use the audienceGuide requirements; do not assume Support needs no API reference.'
        : 'Invalid audienceCoverage: ' + parsed.error.issues.slice(0, 5).map(issue => issue.path.join('.') + ': ' + issue.message).join('; ') });
    return { issues, summary };
  }
  const policy = parsed.data;
  summary.checked = true;
  summary.readers = policy.readers;
  const data = foundation!.data!;
  const sections = objects(data.sections);
  for (const topic of audienceTopics) {
    for (const id of policy.sections?.[topic] ?? []) if (!sections.some(section => section.id === id)) issues.push({
      key: 'foundation', code: 'INVALID_AUDIENCE_SECTION', topic,
      message: `Audience topic "${topic}" maps to unknown section "${id}". Use a declared section ID.`
    });
  }
  const nav = object(data.navigation) ? data.navigation : {};
  const tabs = objects(nav.tabs), groups = objects(nav.groups), entries = objects(nav.entries);
  const docs = { ...data, records, navigation: { ...nav, entries: entries.map(entry => ({ ...entry, searchable: true })) } };
  function canRead(record: RecordData, role: Reader) {
    const page = record.page ?? record.key.split('/')[0];
    const section = sections.find(item => item.id === page);
    const entry = entries.find(item => item.key === record.key);
    const tab = tabs.find(item => item.id === entry?.tab);
    return record.data?.visible !== false && visible(section, role) && visible(entry, role) && visible(tab, role) &&
      (!entry?.group || visible(groups.find(item => item.id === entry.group && item.tab === entry.tab), role));
  }
  const articles = records.filter(record => record.key !== 'foundation');
  for (const role of policy.readers) {
    for (const record of articles.filter(record => canRead(record, role))) {
      summary.articlesChecked++;
      const text = renderer.searchText(docs, record, role);
      const count = text.split(/\s+/).filter(Boolean).length;
      const blocks = visibleBlocks(record.data?.blocks, role);
      const page = record.page ?? record.key.split('/')[0]!;
      const topics = audienceTopics.filter(topic => (policy.sections?.[topic] ?? [topic]).includes(page));
      const faq = /faq|question/i.test(page) || topics.includes('faq');
      const long = topics.some(topic => !['faq', 'errors', 'release-notes'].includes(topic));
      const short = !long && (/faq|glossary|release|changelog|error|term/i.test(page) || topics.some(topic => ['faq', 'errors', 'release-notes'].includes(topic)));
      const minimum = !short ? (parsed.data.depth === 'compact' ? depthLimits.compact.articleWords : audienceDepth.articleWords) : faq ? audienceDepth.faqWords : audienceDepth.referenceWords;
      const add = (code: string, message: string) => issues.push({ key: record.key, reader: role, code, message: role + ': ' + message });
      if (count < minimum) add('AUDIENCE_TOO_THIN', `Only ${count} visible words; at least ${minimum} are needed here. Content hidden from this reader cannot satisfy their depth requirement.`);
      if (!short) {
        if (!blocks.some(block => block.type === 'heading')) add('AUDIENCE_NO_HEADINGS', 'Add meaningful visible headings for this reader.');
        const types = new Set(blocks.filter(block => substantive(block, role)).map(block => block.type));
        if (types.size < audienceDepth.structuredTypes) add('AUDIENCE_PLAIN_TEXT', 'Use at least two substantive structured block types, such as steps and an error table, visible to this reader.');
      }
      if (faq && blocks.filter(block => block.type === 'details' && typeof block.title === 'string' && block.title.trim().endsWith('?')).length < 3) {
        add('AUDIENCE_FAQ_INCOMPLETE', 'Provide at least three useful expandable questions this reader can see.');
      }
      if (faq) {
        for (const question of blocks.filter(block => block.type === 'details')) {
          const answer = renderer.searchText({ ...docs, sections: sections.map(section => ({ ...section, fields: [] })) },
            { ...record, title: '', data: { ...record.data, value: {}, blocks: question.blocks } }, role);
          if (answer.split(/\s+/).filter(Boolean).length < 25) {
            add('AUDIENCE_FAQ_THIN_ANSWER', 'Each expandable answer needs at least 25 words visible to this reader.');
          }
        }
      }
      if (topics.includes('api')) {
        if (!blocks.some(block => block.type === 'table' && substantive(block, role))) {
          add('AUDIENCE_API_FIELDS', 'Expose structured API request/response fields and error meanings, not just a method/path summary.');
        }
        if (['developers', 'internal'].includes(role) &&
            !blocks.some(block => ['code', 'json'].includes(String(block.type)) && substantive(block, role))) {
          add('AUDIENCE_API_EXAMPLE', 'Provide a complete synthetic request/response example this reader can see.');
        }
      }
      if (topics.includes('test-scenarios') && role === 'testers' &&
          !blocks.some(block => block.type === 'table' && objects(block.columns).filter(column => column.visible !== false).length >= 3 && substantive(block, role))) {
        add('AUDIENCE_TEST_SCENARIOS', 'Provide a visible scenario table with preconditions, steps and expected outcomes; distinguish proposed tests from executed results.');
      }
    }
  }
  if (!options.complete) return { issues, summary };
  const exemptions = new Set<string>();
  for (const exemption of policy.notApplicable) {
    const id = exemption.reader + ':' + exemption.topic;
    if (exemptions.has(id) || !policy.readers.includes(exemption.reader) ||
        !audienceRequirements[exemption.reader].topics.includes(exemption.topic) ||
        /\b(todo|tbd)\b|\[write|lorem ipsum/i.test(exemption.reason)) {
      issues.push({ key: 'foundation', code: 'INVALID_AUDIENCE_EXEMPTION', message: 'Invalid, duplicate or unsubstantiated non-applicability: ' + id });
    }
    exemptions.add(id);
  }
  for (const role of policy.readers) {
    for (const topic of audienceRequirements[role].topics) {
      summary.topicsChecked++;
      const ids = policy.sections?.[topic] ?? [topic];
      const candidates = articles.filter(record => ids.includes(record.page ?? record.key.split('/')[0]!));
      if (exemptions.has(role + ':' + topic)) {
        if (candidates.length) issues.push({ key: 'foundation', code: 'CONTRADICTORY_AUDIENCE_EXEMPTION', reader: role, topic,
          message: `${role}: ${topic} is documented in this project and cannot be declared non-applicable merely to hide it from this reader.` });
        continue;
      }
      if (!candidates.some(record => canRead(record, role))) issues.push({
        key: 'foundation', code: 'AUDIENCE_TOPIC_MISSING', reader: role, topic,
        message: `${role}: required topic "${topic}" has no reader-visible article. Write and expose it, map its custom section in audienceCoverage.sections, or obtain explicit approval for a source-backed non-applicability reason.`
      });
    }
  }
  return { issues, summary };
}
