// Facts format: the AI sends the content of each outline part keyed by its heading, and the server builds the
// full record (ids, headings, groups, audiences, block shapes) from the same outline the checks enforce.
// This keeps template JSON out of the AI's output, which is most of a long article's size.
import { partBlocks } from './authoring.js';
import { depthOf, outlineFor, templates, type Part } from './outlines.js';
import type { Reader } from './workflows.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Block = Record<string, unknown>;
export interface FactsRecord { key: string; title: string; value?: Record<string, Json>; order?: number; summary?: string; facts: Record<string, Json> }

export const isFacts = (value: unknown): value is FactsRecord => Boolean(value) && typeof value === 'object' &&
  typeof (value as FactsRecord).key === 'string' && typeof (value as FactsRecord).facts === 'object' && !('data' in (value as object));

const str = (value: Json | undefined) => value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const list = (value: Json | undefined): Json[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const notApplicable = (value: Json | undefined) => typeof value === 'string' && /^not applicable:/i.test(value.trim());

function rows(value: Json | undefined, columns: { key: string; label: string }[]) {
  return list(value).map(row => Object.fromEntries(columns.map((column, index) => [column.key,
    str(Array.isArray(row) ? row[index] : row && typeof row === 'object' ? (row as Record<string, Json>)[column.label] ?? (row as Record<string, Json>)[column.key] : index === 0 ? row : '')])));
}
const cards = (value: Json | undefined) => list(value).map(card => Array.isArray(card)
  ? { title: str(card[0]), text: str(card[1]), href: str(card[2]) || '#/' }
  : { title: str((card as Record<string, Json>)?.title), text: str((card as Record<string, Json>)?.text), href: str((card as Record<string, Json>)?.href) || '#/' });

/** Fill one template block with the part's content. */
function fill(block: Block, content: Json | undefined): Block {
  const out: Block = { ...block };
  switch (block.type) {
    case 'paragraph': out.text = str(Array.isArray(content) ? content.join('\n\n') : content); break;
    case 'list': out.items = list(content).map(str); break;
    case 'table': out.rows = rows(content, block.columns as { key: string; label: string }[]); break;
    case 'cards': out.items = cards(content); break;
    case 'diagram': out.source = str(content); break;
    case 'json': out.value = content ?? {}; break;
    case 'code': out.code = str(content); break;
    case 'callout': out.text = str(content); break;
    case 'details': {
      const inner = (block.blocks as Block[])[0]!;
      out.blocks = [fill(inner, content)];
      break;
    }
  }
  return out;
}

function questions(part: Part & { audiences?: Reader[] }, index: number, content: Json | undefined, limit: Block): Block[] {
  const id = 'part-' + index;
  const heading = { id: id + '-heading', type: 'heading', level: 2, text: part.heading, ...limit, ...(part.group ? { group: part.group } : {}) };
  return [heading, ...list(content).map((item, n) => {
    const q = (item ?? {}) as Record<string, Json>;
    const qid = id + '-q' + n;
    const blocks: Block[] = part.block === 'support-question' ? [
      { id: qid + '-answer', type: 'paragraph', text: str(q.answer) },
      { id: qid + '-check', type: 'table', columns: [{ key: 'c0', label: 'Check' }, { key: 'c1', label: 'Where' }, { key: 'c2', label: 'What it tells you' }],
        rows: rows(q.checks, [{ key: 'c0', label: 'Check' }, { key: 'c1', label: 'Where' }, { key: 'c2', label: 'What it tells you' }]) },
      { id: qid + '-fix', type: 'list', ordered: true, items: list(q.fix).map(str) },
      { id: qid + '-escalate', type: 'callout', tone: 'warning', text: str(q.escalate) }]
      : [{ id: qid + '-answer', type: 'paragraph', text: str(q.answer) },
        ...(q.steps ? [{ id: qid + '-how', type: 'list', ordered: true, items: list(q.steps).map(str) }] : []),
        ...(q.helps ? [{ id: qid + '-helps', type: 'callout', tone: 'info', text: str(q.helps) }] : []),
        ...(q.link ? [{ id: qid + '-more', type: 'link', label: str((q.link as Record<string, Json>)?.label ?? 'Read the full article'), href: str((q.link as Record<string, Json>)?.href ?? q.link) }] : [])];
    return { id: qid, type: 'details', title: str(q.q ?? q.question), blocks: blocks.map(block => ({ ...block, ...limit })), ...limit };
  })];
}

/** Build a full record from a facts record, using the readers and depth the foundation declares. */
export function expandFacts(facts: FactsRecord, foundation: { data?: unknown } | undefined): Block {
  const section = facts.key.split('/')[0]!;
  const template = templates[section];
  const readers = ((foundation?.data as { audienceCoverage?: { readers?: Reader[] } } | undefined)?.audienceCoverage?.readers ?? []) as Reader[];
  const outline = outlineFor(section, readers, depthOf(foundation));
  const blocks: Block[] = facts.summary ? [{ id: 'summary', type: 'paragraph', text: facts.summary }] : [];
  outline.forEach((part, index) => {
    const content = facts.facts[part.heading];
    const limit = part.audiences ? { audiences: part.audiences } : {};
    if (part.block === 'question' || part.block === 'support-question') {
      if (notApplicable(content)) blocks.push(...partBlocks(part, index).slice(0, 1), { id: 'part-' + index + '-na', type: 'callout', tone: 'info', text: str(content), ...limit });
      else blocks.push(...questions(part, index, content, limit));
      return;
    }
    const template = partBlocks(part, index);
    if (notApplicable(content) && part.block !== 'details') {
      blocks.push(template[0]!, { id: 'part-' + index, type: 'callout', tone: 'info', text: str(content), ...limit });
      return;
    }
    blocks.push(...template.map(block => block.type === 'heading' ? block : fill(block, content)));
  });
  return {
    key: facts.key, page: section, collection: template?.collection ?? section, title: facts.title,
    data: { schemaVersion: 2, id: facts.key.slice(section.length + 1), value: facts.value ?? {}, order: facts.order ?? 0, blocks }
  };
}

/** Expand every facts record in a list; full records pass through unchanged. */
export function expandAll(records: unknown[], foundation?: { data?: unknown }): unknown[] {
  const base = foundation ?? records.find(record => (record as { key?: string } | null)?.key === 'foundation') as { data?: unknown } | undefined;
  return records.map(record => isFacts(record) ? expandFacts(record, base) : record);
}

/** Which headings a facts record should fill, for the given foundation (sent to the AI instead of the starter). */
export function factsTemplate(section: string, foundation: { data?: unknown } | undefined) {
  const readers = ((foundation?.data as { audienceCoverage?: { readers?: Reader[] } } | undefined)?.audienceCoverage?.readers ?? []) as Reader[];
  return outlineFor(section, readers, depthOf(foundation)).map(part => ({ heading: part.heading, block: part.block, ...(part.columns ? { columns: part.columns } : {}),
    ...(part.count ? { count: part.count } : {}), ...(part.audiences ? { audiences: part.audiences } : {}), write: part.write }));
}
