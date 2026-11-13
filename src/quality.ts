// Editorial quality checks on top of structural validation. Structural validation proves the website can
// render a record; these checks catch documentation that renders but is not useful: thin plain-text pages,
// leftover template text, empty fields shown as "Not provided", source evidence leaking to readers,
// icons the website cannot resolve and links to articles that do not exist. Issues are returned to the AI to fix before asking for approval, and
// publish_documentation refuses drafts that still have them.

import { depthLimits, depthOf } from './outlines.js';
import { checkAudienceCoverage, type AudienceQualityIssue } from './audience-quality.js';
import { checkOutlineConformance } from './outline-conformance.js';
import { checkRelationships } from './relationships.js';
import { checkReleaseNotes } from './release-notes.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Block { id?: string; type?: string; text?: string; items?: Json[]; columns?: { key: string }[]; rows?: Record<string, Json>[];
  code?: string; source?: string; title?: string; blocks?: Block[]; value?: Json; label?: string; icon?: string }
interface DocRecord { key: string; page?: string; title?: string; data?: { [key: string]: Json } }
export interface QualityIssue extends AudienceQualityIssue {}

// Reference-style sections are naturally short; everything else must explain the topic in depth.
const SHORT = /faq|glossary|release|changelog|error|term/i;
const PLACEHOLDER = /\[(write|describe|list|add|replace|todo|tbd)\b|replace this example|lorem ipsum|\btodo\b|\btbd\b/i;
const EVIDENCE = /(^|\n)\s*(evidence|sources?|source references?)\s*:/i;
// An internal route, alone or inside text: #/section or #/section/id.
const ROUTE = /(?:^|[\s("'\[])#\/([a-z][a-z0-9-]{0,63})(?:\/([a-zA-Z0-9_-]{1,120}))?(?![\w/-])/g;
// Technical identifiers that belong in a table, not in running text: "POST /v1/items", "/v1/items/{id}",
// snake_case tables and fields, and UPPER_CASE error codes.
const TECH_TOKEN = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+|(?:^|\s)\/v\d+\/[\w{}/:-]+|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const SOURCE_PATH = /\b(src|lib|app|assets|scripts|tests?)\/[\w./-]+\.(ts|tsx|js|jsx|mjs|py|go|rb|java|kt|swift|cs|php)\b/;

function walk(blocks: Block[] | undefined, visit: (block: Block, depth: number) => void, depth = 0) {
  for (const block of blocks ?? []) {
    visit(block, depth);
    if (block.type === 'details') walk(block.blocks, visit, depth + 1);
  }
}
function texts(block: Block): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  add(block.text); add(block.items); add(block.rows); add(block.title); add(block.label);
  if (block.type === 'cards') add(block.items);
  return out;
}
const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
function iconRefs(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) value.forEach(item => iconRefs(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'icon' && typeof entry === 'string' && !/^https:/.test(entry)) out.add(entry);
      else iconRefs(entry, out);
    }
  }
}
function routes(value: unknown, out: Set<string>) {
  if (typeof value === 'string') for (const match of value.matchAll(ROUTE)) out.add(match[1]! + (match[2] ? '/' + match[2] : ''));
  else if (Array.isArray(value)) value.forEach(item => routes(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => routes(item, out));
}

// Padding checks. Word and item minimums are low on purpose; these stop an AI from meeting them with copies.
const normal = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const BOILERPLATE_ARTICLES = 8;   // the same long sentence on this many articles is a template, not documentation
function repetitionIssues(list: DocRecord[]): QualityIssue[] {
  const found: QualityIssue[] = [];
  const articles = list.filter(item => item.key !== 'foundation');
  // 1. The same list or long paragraph twice on one page (for example "Steps" copying "Before you start").
  for (const item of articles) {
    const seen = new Map<string, string>();
    const repeated = new Set<string>();
    walk((item.data?.blocks ?? []) as Block[], block => {
      const text = block.type === 'list' && Array.isArray(block.items) && block.items.length >= 2 ? JSON.stringify(block.items.map(entry => normal(String(entry))))
        : (block.type === 'paragraph' || block.type === 'callout') && typeof block.text === 'string' && block.text.length >= 80 ? normal(block.text) : '';
      if (!text) return;
      if (seen.has(text)) repeated.add(seen.get(text)!); else seen.set(text, String(block.id ?? block.type));
    });
    if (repeated.size) found.push({ key: item.key, code: 'DUPLICATE_CONTENT', message: 'The same content appears more than once on this page (first at ' +
      [...repeated].slice(0, 5).join(', ') + '). Each part must say something different; write it from the code or mark the part "Not applicable: <reason>".' });
  }
  // 2. The same long sentence on many pages, after removing each page's own title: template filler.
  if (articles.length >= BOILERPLATE_ARTICLES) {
    const pagesBySentence = new Map<string, Set<string>>();
    const sample = new Map<string, string>();
    for (const item of articles) {
      const title = normal(item.title ?? '');
      // Source references legitimately repeat (many endpoints share one controller), so skip technical details.
      const all: Block[] = [];
      const collect = (blocks: Block[]) => { for (const block of blocks) {
        if (block.type === 'details' && /technical|source/i.test(String(block.title ?? ''))) continue;
        all.push(block); collect((block.blocks ?? []) as Block[]);
      } };
      collect((item.data?.blocks ?? []) as Block[]);
      for (const sentence of all.flatMap(block => texts({ ...block, blocks: [] } as Block)).join('\n').split(/(?<=[.!?])\s+|\n+/)) {
        if (sentence.length < 60 || /^[\w.@/-]+(\.(ts|js|swift|json|kt|py))?["'.]*$/.test(sentence.trim())) continue;
        const skeleton = title.length > 3 ? normal(sentence).split(title).join('X') : normal(sentence);
        if (!pagesBySentence.has(skeleton)) { pagesBySentence.set(skeleton, new Set()); sample.set(skeleton, sentence.trim()); }
        pagesBySentence.get(skeleton)!.add(item.key);
      }
    }
    const perPage = new Map<string, string[]>();
    for (const [skeleton, pages] of pagesBySentence) {
      if (pages.size < BOILERPLATE_ARTICLES) continue;
      for (const key of pages) perPage.set(key, [...(perPage.get(key) ?? []), sample.get(skeleton)!]);
    }
    for (const [key, sentences] of perPage) found.push({ key, code: 'BOILERPLATE', message: 'Generic text repeated across ' + BOILERPLATE_ARTICLES +
      '+ articles: "' + sentences[0]!.slice(0, 160) + '"' + (sentences.length > 1 ? ' (and ' + (sentences.length - 1) + ' more)' : '') +
      '. Remove it; write facts specific to this article instead. Short and true is better than long and generic.' });
  }
  return found;
}

/**
 * Quality issues for structured v2 records. The foundation, when included, supplies icons, section fields and
 * the navigation that lists every article. `existing` lists article keys already published that this draft keeps.
 */
export function qualityReport(records: unknown[], foundation?: DocRecord, existing?: string[],
  options: { requireAudienceCoverage?: boolean; complete?: boolean; maxIssues?: number; publicationVersion?: string } = {}) {
  const list = records.filter((item): item is DocRecord => Boolean(item) && typeof item === 'object' && typeof (item as DocRecord).key === 'string');
  const base = list.find(item => item.key === 'foundation') ?? foundation;
  const data = base?.data as { icons?: { [name: string]: string }; sections?: { id: string; fields?: { key: string; label?: string }[] }[];
    navigation?: { tabs?: { id: string; label: string }[]; groups?: { id: string; tab: string; label: string }[]; entries?: { key: string }[] } } | undefined;
  const issues: QualityIssue[] = [];
  const add = (key: string, code: string, message: string) => issues.push({ key, code, message });

  if (data) {
    const known = new Set(Object.keys(data.icons ?? {}));
    const used = new Set<string>();
    iconRefs(data.navigation, used); iconRefs(data.sections, used);
    for (const item of list) iconRefs(item.data?.blocks, used);
    const missing = [...used].filter(name => !known.has(name));
    if (missing.length) add('foundation', 'UNKNOWN_ICON', 'Icons used but not declared in foundation.icons (the website shows a warning banner): ' + missing.slice(0, 20).join(', ') +
      '. Add each as "name": "https://api.iconify.design/lucide/<name>.svg" or use a declared name.');
    for (const group of data.navigation?.groups ?? []) {
      const tab = data.navigation?.tabs?.find(item => item.id === group.tab);
      if (tab && tab.label.trim().toLowerCase() === group.label.trim().toLowerCase()) {
        add('foundation', 'DUPLICATE_NAVIGATION', 'Navigation group "' + group.label + '" repeats its section name, so the sidebar shows it twice. Put entries directly under the section (group "") or give the group a distinct name.');
      }
    }
  }

  for (const item of list) {
    if (item.key === 'foundation') continue;
    const section = item.key.split('/')[0] ?? '';
    const blocks = (item.data?.blocks ?? []) as Block[];
    const all: Block[] = [];
    walk(blocks, block => all.push(block));
    const content = all.flatMap(texts).join('\n');
    const value = (item.data?.value ?? {}) as { [key: string]: Json };
    const valueText = JSON.stringify(value);
    const total = words(content) + words(valueText.replace(/[{}"[\],:]/g, ' '));
    const short = SHORT.test(section);
    const types = new Set(all.map(block => block.type));

    if (PLACEHOLDER.test(content) || PLACEHOLDER.test(valueText)) add(item.key, 'PLACEHOLDER', 'Template text is still present. Replace every placeholder with real content from the code.');
    if (EVIDENCE.test(content)) add(item.key, 'EVIDENCE_IN_CONTENT', 'Evidence notes ("Evidence: …") are for review, not for readers. Remove them; for technical readers, put file and symbol references in a "Technical details" details block.');
    else if (SOURCE_PATH.test(content) && !all.some(block => block.type === 'details' && /technical|source|implementation|developer/i.test(block.title ?? ''))) {
      add(item.key, 'SOURCE_PATH_IN_CONTENT', 'Source file paths appear in the main text. Move them into a details block titled "Technical details" so non-technical readers are not confused.');
    }
    if (/faq|question/i.test(section)) {
      const questions = all.filter(block => block.type === 'details');
      const asked = questions.filter(block => (block.title ?? '').trim().endsWith('?'));
      if (asked.length < 3) add(item.key, 'FAQ_FORMAT', 'FAQ articles group at least 3 questions on one topic. Write each question as a details block whose title is the question (ending with "?") and whose blocks hold the answer, so readers expand it.');
      const thinAnswers = asked.filter(block => words((block.blocks ?? []).flatMap(texts).join(' ')) < 25).map(block => block.title);
      if (thinAnswers.length) add(item.key, 'FAQ_THIN_ANSWER', 'These answers are too short: ' + thinAnswers.slice(0, 5).join(' | ') + '. Give the direct answer, the steps, how it helps the reader and a link to the full article.');
      if (all.some(block => block.type === 'paragraph' && /\?\s*$/.test((block.text ?? '').trim()))) add(item.key, 'FAQ_PLAIN_QUESTION', 'A question is written as a plain paragraph. Make it a details block (title = question, blocks = answer).');
    }
    const minimum = /faq|question/i.test(section) ? 150 : short ? 80 : depthLimits[depthOf(base)].articleWords;
    if (total < minimum) add(item.key, 'TOO_THIN', 'Only about ' + total + ' words. ' + (short ? 'Give a complete answer with an example and links to related articles.' :
      'Cover the topic fully, following its section\'s article outline for your readers (for example overview, who can use it, step-by-step use, settings and limits, errors and edge cases, and the parts your readers need such as test scenarios, acceptance criteria or technical details).'));
    if (!short) {
      if (!types.has('heading')) add(item.key, 'NO_HEADINGS', 'Add heading blocks (level 2/3) so the article has sections and an "On this page" outline.');
      const structured = [...types].filter(type => type && !['heading', 'paragraph'].includes(type));
      if (structured.length < 2) add(item.key, 'PLAIN_TEXT_ONLY', 'The article is mostly plain paragraphs. Use structured blocks: ordered lists for steps, tables for settings/errors/scenarios, code or json for technical examples, callouts for warnings, diagrams for flows.');
    }
    const technicalProse = all.filter(block => ['paragraph', 'callout'].includes(block.type ?? '')).map(block => block.text ?? '')
      .filter(text => (text.match(TECH_TOKEN) ?? []).length >= 2 || /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//.test(text));
    if (technicalProse.length) add(item.key, 'TECHNICAL_PROSE', 'Endpoints, tables, fields or codes are written as a paragraph: "' + technicalProse[0]!.slice(0, 120) +
      '…". Put them in a table so readers can scan them, for example Step | Endpoint | What happens, or Table | Fields | Why.');
    const longest = all.filter(block => block.type === 'paragraph').reduce((max, block) => Math.max(max, (block.text ?? '').length), 0);
    if (longest > 900) add(item.key, 'WALL_OF_TEXT', 'A paragraph has ' + longest + ' characters. Split it, and turn sequences into lists and comparisons into tables.');
    if (/\d\.\s+\S[^\n]*\s\d\.\s+\S/.test(all.filter(block => block.type === 'paragraph').map(block => block.text ?? '').join('\n'))) {
      add(item.key, 'INLINE_STEPS', 'Numbered steps are written inside a paragraph ("1. … 2. …"). Use a list block with ordered: true.');
    }
    const declared = data?.sections?.find(entry => entry.id === section)?.fields ?? [];
    const empty = declared.filter(field => {
      const path = field.key.replace(/^value\./, '').split('.');
      let current: Json | undefined = value;
      for (const part of path) current = current && typeof current === 'object' && !Array.isArray(current) ? (current as { [key: string]: Json })[part] : undefined;
      return current === undefined || current === null || current === '';
    });
    if (empty.length) add(item.key, 'EMPTY_FIELDS', 'Fields shown as "Not provided" on the website: ' + empty.map(field => field.label ?? field.key).join(', ') +
      '. Fill them from the code, or remove the field from the section if it does not apply.');
  }

  // Every internal link must reach an article or section. Without a foundation or the published keys a
  // batch cannot know the rest of the documentation, so only complete knowledge is checked.
  if (data || existing) {
    const articles = new Set([...list.map(item => item.key), ...(data?.navigation?.entries ?? []).map(entry => entry.key), ...(existing ?? [])]);
    articles.delete('foundation');
    const sections = new Set([...(data?.sections ?? []).map(section => section.id), ...[...articles].map(key => key.split('/')[0]!)]);
    for (const item of list) {
      if (item.key === 'foundation') continue;
      const found = new Set<string>();
      routes(item.data?.blocks, found); routes(item.data?.value, found);
      const missing = [...found].filter(target => target.includes('/') ? !articles.has(target) : !sections.has(target));
      if (missing.length) add(item.key, 'BROKEN_LINK', 'Links to documentation that does not exist: ' + missing.slice(0, 20).map(target => '#/' + target).join(', ') +
        '. Write each missing article (for example the API reference article for every endpoint a feature uses) and list it in navigation, or remove the link.');
    }
  }
  issues.push(...repetitionIssues(list));
  issues.push(...checkReleaseNotes(list, options.publicationVersion));
  issues.push(...checkRelationships(base && !list.includes(base) ? [base, ...list] : list,
    [...(existing ?? []), ...(data?.navigation?.entries ?? []).map(entry => entry.key)], options.complete === true));
  const audience = checkAudienceCoverage(list, base, { required: options.requireAudienceCoverage === true, complete: options.complete === true });
  issues.push(...audience.issues);
  // The prescribed structure is mandatory: outline issues block publication like any other quality issue.
  const outline = checkOutlineConformance(list, base);
  issues.push(...outline);
  return {
    ok: issues.length === 0,
    issues: issues.slice(0, options.maxIssues ?? 200),
    audienceCoverage: audience.summary,
    guidance: issues.length ? ['Fix every quality issue, then validate again. Do not ask the user to approve publishing while quality issues remain.',
      ...(outline.length ? ['The structure is mandatory. Rewrite every article named in an OUTLINE_ issue so it matches its outline exactly (OUTLINE_EXPECTED lists it), then send the complete documentation again with validate_documentation (complete: true).'] : [])] : []
  };
}
