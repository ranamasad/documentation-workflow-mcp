// Relations inside published documentation, computed from the articles themselves (no extra storage):
// links between articles, shared endpoints and messages, and the source files each article cites in its
// "Technical details". Updates use them to find every article a change touches without reading them all.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface GraphRecord { key: string; title?: string; page?: string; data?: unknown }

const LINK = /#\/([a-z0-9-]+\/[a-z0-9-]+)/g;
const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-./{}:]+)/g;
const QUOTED = /"([^"\n]{12,120})"/g;
const SOURCE = /(?:^|[\s(`'"])((?:[\w.@-]+\/)+[\w.@-]+\.(?:ts|tsx|js|mjs|swift|kt|java|py|go|rb|cs|m|h))\b/g;

function texts(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => texts(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => texts(item, out));
  return out;
}
/** The text of "Technical details" / source blocks, where articles cite the files they were written from. */
function technical(value: unknown, inside = false, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => technical(item, inside, out));
  else if (value && typeof value === 'object') {
    const block = value as { type?: string; title?: string; blocks?: Json };
    const here = inside || block.type === 'details' && /technical|source/i.test(block.title ?? '');
    if (here) out.push(...texts(value));
    else Object.values(value).forEach(item => technical(item, false, out));
  }
  return out;
}
const all = (pattern: RegExp, text: string, group = 1) => [...text.matchAll(pattern)].map(match => match[group]!);

export interface ArticleFacts { key: string; title: string; links: Set<string>; endpoints: Set<string>; messages: Set<string>; sources: Set<string> }

export function articleFacts(record: GraphRecord): ArticleFacts {
  const data = record.data as { blocks?: unknown; value?: unknown } | undefined;
  const body = texts([data?.blocks, data?.value]).join('\n');
  return {
    key: record.key, title: record.title ?? record.key,
    links: new Set(all(LINK, JSON.stringify(data ?? {})).filter(target => target !== record.key)),
    endpoints: new Set([...body.matchAll(ENDPOINT)].map(match => match[1] + ' ' + match[2]!.replace(/[.,;:)]+$/, ''))),
    messages: new Set(all(QUOTED, body).map(message => message.trim()).filter(message => /[a-z]/i.test(message) && !message.includes('/'))),
    sources: new Set(all(SOURCE, technical(data?.blocks).join('\n')))
  };
}

const brief = (facts: ArticleFacts, extra: Record<string, unknown> = {}) => ({ key: facts.key, title: facts.title, ...extra });

/** Articles that link to this one, that it links to, and that share its endpoints, messages or source files. */
export function relatedArticles(records: GraphRecord[], key: string, limit = 25) {
  const facts = records.filter(record => record.key !== 'foundation').map(articleFacts);
  const self = facts.find(item => item.key === key);
  if (!self) return undefined;
  const others = facts.filter(item => item.key !== key);
  const overlap = (field: 'endpoints' | 'messages' | 'sources') => others
    .map(item => ({ item, shared: [...item[field]].filter(value => self[field].has(value)) }))
    .filter(entry => entry.shared.length).sort((a, b) => b.shared.length - a.shared.length).slice(0, limit)
    .map(entry => brief(entry.item, { shared: entry.shared.slice(0, 5) }));
  const byKey = new Map(facts.map(item => [item.key, item]));
  return {
    article: brief(self),
    linksTo: [...self.links].slice(0, limit).map(target => byKey.get(target) ? brief(byKey.get(target)!) : { key: target, missing: true }),
    linkedFrom: others.filter(item => item.links.has(key)).slice(0, limit).map(item => brief(item)),
    sameEndpoints: overlap('endpoints'),
    sameMessages: overlap('messages'),
    sameSourceFiles: overlap('sources')
  };
}

/** For each changed source file, the articles whose "Technical details" cite it (matched by path suffix). */
export function pagesForFiles(records: GraphRecord[], paths: string[]) {
  const facts = records.filter(record => record.key !== 'foundation').map(articleFacts);
  const clean = (path: string) => path.replace(/^\.?\//, '');
  const matches = (cited: string, changed: string) => cited === changed || cited.endsWith('/' + changed) || changed.endsWith('/' + cited);
  const files = paths.map(path => {
    const changed = clean(path);
    const pages = facts.filter(item => [...item.sources].some(cited => matches(clean(cited), changed))).map(item => brief(item));
    return { file: path, pages };
  });
  const keys = [...new Set(files.flatMap(file => file.pages.map(page => page.key)))];
  return {
    files: files.filter(file => file.pages.length),
    notDocumented: files.filter(file => !file.pages.length).map(file => file.file),
    articlesToReview: keys.length,
    next: keys.length
      ? 'Read these articles (read_published_documentation, 10 at a time) and call related_articles on each feature among them to find linked guides, errors and FAQ that may also need changes.'
      : 'No article cites these files. Search by feature name, endpoint or message (search_published_documentation), or this may be new behaviour that needs new articles.'
  };
}
