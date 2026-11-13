// Outline conformance: documentation must follow the structure designStructure prescribes, exactly.
// Sections, their fields, every article's parts (headings, order, block types, table columns, tab groups)
// and which readers see each part are enforced, not suggested. Any difference is an issue that names the
// article, what is wrong and the expected outline, so the AI rewrites that article and resends the whole
// documentation. The only escape is an explicit "Not applicable: <reason>" callout as a part's first block.

import { depthOf, outlineFor, templates, type Part } from './outlines.js';
import { checkArticle, checkPart, type RuleBlock } from './reader-rules.js';
import type { Reader } from './workflows.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Block { type?: string; level?: number; text?: string; title?: string; ordered?: boolean; group?: string;
  audiences?: string[]; columns?: { key?: string; label?: string }[]; blocks?: Block[] }
interface RecordData { key: string; page?: string; data?: { [key: string]: Json } }
export interface OutlineIssue { key: string; code: string; message: string }

type ExpectedPart = Part & { audiences?: Reader[] };
interface ActualPart { name: string; head: Block; body: Block[] }

const QUESTION = '__question';
const NOT_APPLICABLE = /^Not applicable:\s*\S+(?:\s+\S+){7,}/;
const readerList = (value: unknown): Reader[] => Array.isArray(value) ? value.filter((item): item is Reader => typeof item === 'string') as Reader[] : [];
const sameSet = (left: readonly string[] = [], right: readonly string[] = []) =>
  left.length === right.length && left.every(item => right.includes(item));
const describe = (part: ExpectedPart) => (part.block === 'question' && !part.count ? 'one question (details block titled with a real question ending in "?")'
  : part.heading + ' (' + part.block + (part.columns ? ': ' + part.columns.join(' | ') : '') + (part.audiences ? ', only for ' + part.audiences.join(', ') : '') + ')');
const nameOf = (part: ExpectedPart) => part.block === 'question' && !part.count ? QUESTION : part.heading;

/** Splits an article's top-level blocks into the parts it actually has, using the outline only to recognise details parts. */
function splitParts(blocks: Block[], expected: ExpectedPart[], faq: boolean) {
  const detailsParts = new Set(expected.filter(part => part.block === 'details').map(part => part.heading));
  const parts: ActualPart[] = [];
  const loose: Block[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2) parts.push({ name: block.text ?? '', head: block, body: [] });
    else if (block.type === 'details' && detailsParts.has(block.title ?? '')) {
      // A separate heading in front of a details part is one part written the wrong way, not two parts.
      const previous = parts.at(-1);
      if (previous && previous.name === block.title && previous.head.type === 'heading' && !previous.body.length) previous.body.push(block);
      else parts.push({ name: block.title!, head: block, body: [block] });
    }
    else if (block.type === 'details' && faq) parts.push({ name: QUESTION, head: block, body: [block] });
    else if (parts.length) parts.at(-1)!.body.push(block);
    else loose.push(block);
  }
  return { parts, loose };
}

function checkBody(key: string, part: ExpectedPart, actual: ActualPart, add: (code: string, message: string) => void) {
  const where = '"' + (part.block === 'question' && !part.count ? actual.head.title : part.heading) + '"';
  const blocks = actual.body;
  // Who sees the part: the heading and every block of the part carry exactly the outline's audiences.
  for (const block of [actual.head, ...blocks.filter(block => block !== actual.head)]) {
    if (!sameSet(block.audiences, part.audiences)) {
      add('OUTLINE_AUDIENCES', where + ' must be visible to ' + (part.audiences ? 'only ' + part.audiences.join(', ') : 'every reader') +
        ': set "audiences" to ' + (part.audiences ? JSON.stringify(part.audiences) : 'nothing (remove it)') + ' on its heading and on every block of the part.');
      break;
    }
  }
  if (actual.head.type === 'heading' && (actual.head.group ?? '') !== (part.group ?? '')) {
    add('OUTLINE_GROUP', where + ' heading must have group ' + (part.group ? '"' + part.group + '"' : 'unset') + ' so it appears under the right tab.');
  }
  if (part.block === 'details' && actual.head.type === 'heading') {
    add('OUTLINE_BLOCK_TYPE', where + ' must be a single details block titled "' + part.heading + '", without a separate heading in front of it.');
    return;
  }
  const first = part.block === 'details' ? actual.head : blocks[0];
  if (first?.type === 'callout' && NOT_APPLICABLE.test(first.text ?? '')) return;
  if (part.block === 'question' && !part.count) {
    if (!/\?\s*$/.test(actual.head.title ?? '') || /\[write/i.test(actual.head.title ?? '')) add('OUTLINE_QUESTIONS', where + ' must be titled with a real reader question ending in "?".');
    return;
  }
  if (part.block === 'question' || part.block === 'support-question') {
    const questions = blocks.filter(block => block.type === 'details' && /\?\s*$/.test(block.title ?? ''));
    if (questions.length < (part.count ?? 1) || questions.length !== blocks.length) {
      add('OUTLINE_QUESTIONS', where + ' must contain only question blocks (details titled with a question ending in "?"), at least ' + (part.count ?? 1) + '.');
    }
    if (part.block === 'support-question') for (const question of questions) {
      const inner = question.blocks ?? [];
      const table = inner.find(block => block.type === 'table');
      if (inner[0]?.type !== 'paragraph' || !table || !sameOrder(labels(table), ['Check', 'Where', 'What it tells you']) ||
          !inner.some(block => block.type === 'list' && block.ordered === true) || !inner.some(block => block.type === 'callout')) {
        add('OUTLINE_QUESTIONS', 'Support question "' + question.title + '" must hold, in this order: the answer (paragraph), a table Check | Where | What it tells you, the fix steps (ordered list) and when to escalate (callout).');
      }
    }
    return;
  }
  const expectedType = part.block === 'steps' ? 'list' : part.block;
  if (!first || first.type !== expectedType || (part.block === 'steps' && first.ordered !== true) || (part.block === 'list' && first.ordered === true)) {
    add('OUTLINE_BLOCK_TYPE', where + ' must start with a ' + (part.block === 'steps' ? 'numbered list (list with ordered: true)' : part.block === 'list' ? 'bulleted list' : part.block + ' block') +
      (first ? ', not ' + (first.type === 'list' ? (first.ordered ? 'a numbered list' : 'a bulleted list') : 'a ' + first.type + ' block') : ', but it is empty') +
      '. If the part truly does not apply, start it with a callout "Not applicable: <the reason, from the code>".');
    return;
  }
  if (part.columns) {
    const table = part.block === 'details' ? (first.blocks ?? []).find(block => block.type === 'table') : first;
    if (!table || !sameOrder(labels(table), part.columns)) {
      add('OUTLINE_COLUMNS', where + ' table must have exactly these columns: ' + part.columns.join(' | ') + (table ? ' (found ' + labels(table).join(' | ') + ')' : '') + '.');
    }
  }
}
const labels = (table: Block) => (table.columns ?? []).map(column => column.label ?? '');
const sameOrder = (left: string[], right: string[]) => left.length === right.length && left.every((item, index) => item === right[index]);

/** Outline issues for a complete or batched set of records; the foundation supplies the confirmed readers. */
export function checkOutlineConformance(records: RecordData[], foundation: RecordData | undefined): OutlineIssue[] {
  const issues: OutlineIssue[] = [];
  const data = foundation?.data as { audienceCoverage?: { readers?: unknown }; sections?: { id: string; collection?: string; layout?: string; fields?: { key: string }[] }[];
    navigation?: { tabs?: { id: string; order?: number; audiences?: string[] }[] } } | undefined;
  const readers = readerList(data?.audienceCoverage?.readers);
  if (!data || !readers.length) return issues;
  const foundationIssue = (code: string, message: string) => issues.push({ key: 'foundation', code, message });

  for (const section of data.sections ?? []) {
    const template = templates[section.id];
    if (!template) {
      foundationIssue('OUTLINE_UNKNOWN_SECTION', 'Section "' + section.id + '" is not one of the prescribed sections (' + Object.keys(templates).join(', ') + '). Move its articles into a prescribed section.');
      continue;
    }
    const keys = (section.fields ?? []).map(field => field.key.replace(/^value\./, ''));
    if (section.collection !== template.collection || section.layout !== template.layout || !sameOrder(keys, template.fields.map(field => field.key))) {
      foundationIssue('OUTLINE_SECTION_CHANGED', 'Section "' + section.id + '" must keep collection "' + template.collection + '", layout "' + template.layout +
        '" and exactly the fields ' + template.fields.map(field => field.key).join(', ') + ' in that order.');
    }
  }
  // A section only some readers need is hidden from the others, except the first tab (the start page).
  const tabs = [...(data.navigation?.tabs ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  tabs.forEach((tab, index) => {
    const template = templates[tab.id];
    if (!template) return;
    const audience = template.for && index > 0 ? readers.filter(reader => template.for!.includes(reader)) : [];
    const expected = audience.length && audience.length < readers.length ? audience : undefined;
    if (!sameSet(tab.audiences, expected)) foundationIssue('OUTLINE_TAB_AUDIENCE', 'Navigation tab "' + tab.id + '" must be visible to ' +
      (expected ? 'only ' + expected.join(', ') + ': set audiences to ' + JSON.stringify(expected) : 'every reader: remove its audiences') + '.');
  });

  for (const record of records) {
    if (record.key === 'foundation') continue;
    const section = record.page ?? record.key.split('/')[0]!;
    const template = templates[section];
    if (!template) continue;
    const add = (code: string, message: string) => issues.push({ key: record.key, code, message });
    const value = record.data?.value;
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    const extra = keys.filter(key => !template.fields.some(field => field.key === key));
    if (extra.length) add('OUTLINE_FIELDS', 'Value has fields the section does not declare: ' + extra.join(', ') + '. Use only ' + template.fields.map(field => field.key).join(', ') + '.');

    const expected = outlineFor(section, readers, depthOf(foundation));
    const { parts, loose } = splitParts((record.data?.blocks ?? []) as Block[], expected, section === 'faq');
    if (loose.length > 1 || (loose.length === 1 && (loose[0]!.type !== 'paragraph' || loose[0]!.audiences))) {
      add('OUTLINE_LOOSE_BLOCK', 'Only one summary paragraph, visible to every reader, may come before the first part. Move the other blocks into the part they belong to.');
    }
    const expectedNames = expected.map(nameOf);
    const actualNames = parts.map(part => part.name);
    const questionsNeeded = expectedNames.filter(name => name === QUESTION).length;
    const questionsFound = actualNames.filter(name => name === QUESTION).length;
    const missing = [...new Set(expectedNames.filter(name => name !== QUESTION && !actualNames.includes(name)))];
    const extra2 = [...new Set(actualNames.filter(name => name !== QUESTION && !expectedNames.includes(name)))];
    const repeated = [...new Set(actualNames.filter((name, index) => name !== QUESTION && actualNames.indexOf(name) !== index))];
    if (missing.length) add('OUTLINE_MISSING_PART', 'Missing parts: ' + missing.join(', ') + '. Every part is required; start a part that truly does not apply with a callout "Not applicable: <the reason, from the code>".');
    if (extra2.length) add('OUTLINE_EXTRA_PART', 'Parts not in the outline: ' + extra2.join(', ') + '. Rename each to the outline heading it belongs to or move its content into that part (use level-3 headings inside a part).');
    if (repeated.length) add('OUTLINE_EXTRA_PART', 'Parts appear more than once: ' + repeated.join(', ') + '.');
    if (questionsFound < questionsNeeded) add('OUTLINE_QUESTIONS', 'At least ' + questionsNeeded + ' questions are required; found ' + questionsFound + '.');
    const order = actualNames.filter((name, index) => expectedNames.includes(name) && actualNames.indexOf(name) === index);
    const wanted = [...new Set(expectedNames)].filter(name => order.includes(name));
    if (!sameOrder(order.filter(name => name !== QUESTION), wanted.filter(name => name !== QUESTION))) {
      add('OUTLINE_ORDER', 'Parts are out of order. Use: ' + wanted.filter(name => name !== QUESTION).join(' → ') + '.');
    }
    for (const part of parts) {
      const outline = expected.find(item => nameOf(item) === part.name);
      if (!outline) continue;
      checkBody(record.key, outline, part, add);
      // What each reader needs from this part: counts, filled cells, quoted messages, required mentions.
      if (part.name !== QUESTION) checkPart(section, outline.heading, part.body as RuleBlock[], add);
    }
    checkArticle(section, (record.data?.blocks ?? []) as RuleBlock[], readers, add);
    if (issues.some(issue => issue.key === record.key && issue.code.startsWith('OUTLINE_'))) {
      add('OUTLINE_EXPECTED', 'Rewrite this article to this outline, in order: ' + expected.map(describe).join(' → ') + '.');
    }
  }
  return issues;
}
