export interface RelationshipRecord {
  key: string;
  page?: string;
  data?: unknown;
}

interface RelationshipBlock {
  id?: string;
  type?: string;
  level?: number;
  text?: string;
  title?: string;
  audiences?: string[];
  blocks?: RelationshipBlock[];
  items?: unknown[];
  href?: string;
}

export interface RelationshipIssue { key: string; code: string; message: string }

const RELATED_SECTIONS = new Set(['features', 'guides', 'troubleshooting', 'architecture', 'api']);
const ARTICLE_LINK = /#\/([a-z][a-z0-9-]*\/[a-zA-Z0-9_-]+)(?![\w/-])/g;
const EXCEPTION = /^Not applicable:\s*\S+(?:\s+\S+){7,}/i;
const READERS = ['end-users', 'support', 'testers', 'product-owners', 'administrators', 'developers', 'internal'];
const BACKLINK_SECTIONS = new Set(['guides', 'troubleshooting', 'architecture', 'api']);

export const relationshipGuidance = 'Features, guides, troubleshooting, architecture and API articles need relevant reader-visible related links, with descriptions explaining the connection. Guides link to their feature and relevant recovery; troubleshooting links to the affected feature and recovery guide; architecture links to supported features/components; API references link to callers. Link feature-to-guide, feature-to-troubleshooting, feature-to-architecture and feature-to-API relationships both ways. No fixed card count or unrelated filler links. If no related article applies, use a visible callout with id "related-not-applicable" starting "Not applicable:" and a source-backed reason of at least eight words. This exception cannot waive an existing feature relationship. Validate against the merged site; batch receipts cannot prove backlinks to articles outside the batch.';

export function checkRelationships(records: RelationshipRecord[], existing: string[] = [], complete = false): RelationshipIssue[] {
  const issues: RelationshipIssue[] = [];
  const articles = records.filter(record => record.key !== 'foundation');
  const foundation = records.find(record => record.key === 'foundation')?.data as {
    audienceCoverage?: {readers?: string[]};
    navigation?: {tabs?: {id: string; audiences?: string[]; visible?: boolean}[]; entries?: {key: string; audiences?: string[]; visible?: boolean}[]};
  } | undefined;
  const readers = foundation?.audienceCoverage?.readers?.length ? foundation.audienceCoverage.readers : READERS;
  const known = new Set([...articles.map(record => record.key), ...(complete ? [] : existing)]);
  const section = (article: RelationshipRecord) => article.page ?? article.key.split('/')[0]!;
  const articleReaders = (article: RelationshipRecord) => {
    const tab = foundation?.navigation?.tabs?.find(item => item.id === section(article));
    const entry = foundation?.navigation?.entries?.find(item => item.key === article.key);
    return readers.filter(reader => tab?.visible !== false && entry?.visible !== false &&
      (!tab?.audiences?.length || tab.audiences.includes(reader)) && (!entry?.audiences?.length || entry.audiences.includes(reader)));
  };
  const byKey = new Map(articles.map(article => [article.key, article]));
  const allLinks = new Map<string, Map<string, Set<string>>>();
  const exceptions = new Map<string, Set<string>>();
  for (const article of articles) {
    const data = article.data as { blocks?: RelationshipBlock[] } | undefined;
    const links = new Map<string, Set<string>>();
    const waived = new Set<string>();
    const collect = (blocks: RelationshipBlock[], parentReaders: string[]) => {
      let partReaders = parentReaders;
      for (const block of blocks) {
        if (block.type === 'heading' && block.level === 2) partReaders = parentReaders.filter(reader => !block.audiences?.length || block.audiences.includes(reader));
        const visible = partReaders.filter(reader => !block.audiences?.length || block.audiences.includes(reader));
        if (block.type === 'details' && /technical|source/i.test(block.title ?? '')) continue;
        if (block.type === 'callout' && block.id === 'related-not-applicable') {
          if (EXCEPTION.test(block.text ?? '')) visible.forEach(reader => waived.add(reader));
          else issues.push({key: article.key, code: 'RELATED_EXCEPTION_INVALID', message: 'A related-article exception needs a specific source-backed reason of at least eight words after "Not applicable:".'});
        }
        const body = block.type === 'cards' ? (block.items ?? []).filter(item => {
          if (!item || typeof item !== 'object') return false;
          const card = item as {title?: string; text?: string};
          return typeof card.text === 'string' && card.text.trim().length > 0 && card.text.trim() !== card.title?.trim();
        }) : {text: block.text, href: block.type === 'link' ? block.href : undefined};
        for (const match of JSON.stringify(body).matchAll(ARTICLE_LINK)) {
          const target = match[1]!;
          if (target === article.key || !known.has(target)) continue;
          const targetArticle = byKey.get(target);
          const targetReaders = targetArticle ? articleReaders(targetArticle) : readers;
          const audience = links.get(target) ?? new Set<string>();
          visible.filter(reader => targetReaders.includes(reader)).forEach(reader => audience.add(reader));
          links.set(target, audience);
        }
        collect(block.blocks ?? [], visible);
      }
    };
    collect(data?.blocks ?? [], articleReaders(article));
    allLinks.set(article.key, links);
    exceptions.set(article.key, waived);
    if (!RELATED_SECTIONS.has(section(article))) continue;
    const missing = articleReaders(article).filter(reader => !waived.has(reader) && ![...links.values()].some(audience => audience.has(reader)));
    if (missing.length) issues.push({key: article.key, code: 'RELATED_ARTICLES_MISSING',
      message: 'Add meaningful related article links visible to: ' + missing.join(', ') + '. Navigation, title-only cards, self-links and source references do not count. ' + relationshipGuidance});
    if (['guides', 'troubleshooting'].includes(section(article)) && [...known].some(key => key.startsWith('features/'))) {
      const missingFeature = articleReaders(article).filter(reader => !waived.has(reader) &&
        ![...links].some(([key, audience]) => key.startsWith('features/') && audience.has(reader)));
      if (missingFeature.length) issues.push({key: article.key, code: 'RELATED_FEATURE_MISSING',
        message: 'Link to the feature this task or problem belongs to for ' + missingFeature.join(', ') + '. If this article genuinely has no product-feature relationship, use the specific related-not-applicable explanation instead of linking an unrelated feature.'});
    }
  }
  for (const article of articles) {
    for (const [targetKey, audience] of allLinks.get(article.key) ?? []) {
      const target = byKey.get(targetKey);
      if (!target || !audience.size) continue;
      const paired = section(article) === 'features' && BACKLINK_SECTIONS.has(section(target)) ||
        section(target) === 'features' && BACKLINK_SECTIONS.has(section(article));
      if (!paired) continue;
      const back = allLinks.get(targetKey)?.get(article.key);
      const missing = [...audience].filter(reader => !back?.has(reader));
      if (missing.length) issues.push({key: targetKey, code: 'RELATED_BACKLINK_MISSING',
        message: 'Link back to #/' + article.key + ' for ' + missing.join(', ') + ': this feature relationship is already declared by the other article.'});
      if ([...audience].some(reader => exceptions.get(targetKey)?.has(reader))) issues.push({key: targetKey, code: 'RELATED_EXCEPTION_CONFLICT',
        message: 'A no-related-articles exception conflicts with the existing feature relationship from #/' + article.key + '.'});
    }
  }
  return issues;
}