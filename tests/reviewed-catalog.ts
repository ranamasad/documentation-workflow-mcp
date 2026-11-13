import { designStructure, type Purpose } from '../src/authoring.js';
import { partRules } from '../src/reader-rules.js';
import type { Reader } from '../src/workflows.js';
import type { WireRecord } from '../src/validation.js';

export const sentence = 'The member opens the page, chooses the option and saves the change after checking their role and the current settings. ';
// Every generated sentence names a different item, so reviewed fixtures never trip DUPLICATE_CONTENT or BOILERPLATE.
let counter = 0;
const unique = () => 'The member opens screen ' + (++counter) + ', chooses option ' + counter + ' and saves the change after checking role ' + counter + ' and the current settings. ';
const prose = (sentences: number) => Array.from({ length: sentences }, unique).join('');
// Covers every "mention" rule (access, evidence, timeouts, retries, duplicates, limits) in plain words.
const mentions = 'Access needs the owner role; report the ID, time and logs; a timeout or retry never creates a duplicate and the maximum is one change.';

// Replaces every starter prompt with reviewed-looking prose, keeping the prescribed outline exactly.
function fill(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (!/\[write/i.test(value)) return value;
    if (/\?\]?$/.test(value)) return 'How does the member change the option?';
    // Titles and labels are short (256 characters at most); everything else is prose.
    return key === 'title' || key === 'label' ? 'Related article' : prose(5).trim();
  }
  if (Array.isArray(value)) return value.map(item => fill(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, fill(entry, name)]));
  return value;
}

type Block = Record<string, unknown> & { type?: string; level?: number; text?: string; title?: string; blocks?: Block[] };

// Gives each part the content its reader rule demands, as a careful author would.
function satisfy(section: string, heading: string, blocks: Block[]) {
  const rule = partRules[section]?.[heading];
  if (!rule) return;
  const visit = (block: Block) => {
    if (block.type === 'list') block.items = [mentions, ...Array.from({ length: Math.max(rule.minItems ?? 1, 2) }, () => unique().trim()),
      ...(rule.untested ? ['Not tested: nothing beyond the checks listed above.'] : [])];
    if (block.type === 'table') {
      const columns = block.columns as { key: string; label: string }[];
      const count = Math.max(rule.minRows ?? 1, rule.types?.all ? rule.types.values.length : 1, 3);
      block.rows = Array.from({ length: count }, (_, row) => Object.fromEntries(columns.map(column => [column.key,
        column.label === rule.types?.column ? rule.types.values[row % rule.types.values.length]! :
        column.label === rule.quoted ? 'The message "Access denied" appears.' : 'The member sees the saved change.'])));
    }
    if (block.type === 'diagram') block.source = 'flowchart LR\n  A[Screen] --> B[Service]\n  B --> C[Data]\n  C --> D[Result]';
    if (block.type === 'code') block.code = 'curl https://api.example.com/v1/items';
    if (block.type === 'json') block.value = { id: 1, name: 'Sample', owner: 'member@example.com' };
    if (block.type === 'callout' && rule.quote) block.text = prose(6) + 'The page then shows "Access denied" after the member saves.';
    block.blocks?.forEach(visit);
  };
  blocks.forEach(visit);
}

/** A complete catalog that follows the MCP's mandatory outline and reader rules, as reviewed documentation would. */
export function reviewedCatalog(readers: Reader[] = ['end-users'], purposes: Purpose[] = ['product-guide']): WireRecord[] {
  const records = designStructure({ appName: 'Acme', audiences: readers, purposes }).starter.map(source => {
    const record = fill(source) as WireRecord & { page: string; data: { blocks?: Block[] } };
    if (record.key === 'foundation') return record;
    let heading = '';
    let part: Block[] = [];
    const flush = () => { satisfy(record.page, heading, part); part = []; };
    for (const block of record.data.blocks ?? []) {
      if (block.type === 'heading' && block.level === 2) { flush(); heading = block.text ?? ''; }
      else if (block.type === 'details' && partRules[record.page]?.[block.title ?? ''] && heading !== block.title) { flush(); heading = block.title!; part.push(block); }
      else part.push(block);
    }
    flush();
    return record;
  });
  const feature = records.find(record => record.page === 'features');
  const companions = records.filter(record => ['guides', 'troubleshooting', 'architecture', 'api'].includes(record.page));
  for (const record of records.filter(item => item.key !== 'foundation')) {
    if (!['features', 'guides', 'troubleshooting', 'architecture', 'api', 'release-notes'].includes(record.page)) continue;
    const blocks = record.data.blocks as Block[];
    const target = record === feature ? companions[0] : feature ?? records.find(item => item.key !== 'foundation' && item !== record);
    const related = {id: 'reviewed-related', type: 'cards', items: [{title: target!.title,
      text: 'Read the companion article for this workflow and its responsibilities.', href: '#/' + target!.key}]};
    const existing = blocks.find(block => block.type === 'cards' && !block.audiences);
    if (existing) existing.items = related.items;
    else blocks.push(related);
    if (record === feature) (existing ?? related).items = companions.map(item => ({title: item.title,
      text: 'Companion instructions and implementation boundaries for the membership workflow.', href: '#/' + item.key}));
    if (record.page === 'release-notes') {
      (record.data.value as Record<string, unknown>).highlights = 'Documentation-only: clarify the existing member workflow without changing application behavior.';
    }
  }
  return records;
}

export function releaseNoteUpdate(records: WireRecord[], version: string): WireRecord[] {
  const foundation = structuredClone(records.find(record => record.key === 'foundation')!);
  const note = structuredClone(records.find(record => record.page === 'release-notes')!);
  const id = 'v' + version.replaceAll('.', '-');
  note.key = 'release-notes/' + id;
  note.title = 'Documentation ' + version;
  note.data.id = id;
  (note.data.value as Record<string, unknown>).version = version;
  const navigation = foundation.data.navigation as {entries: Record<string, unknown>[]};
  navigation.entries.push({id: 'release-' + id, tab: 'release-notes', group: '', key: note.key, label: note.title,
    href: '#/' + note.key, order: navigation.entries.length, visible: true, searchable: true});
  return [foundation, note];
}
