// Token estimate before documentation work starts, so the AI can tell the user the cost and offer compact depth.
// Calibrated on a real run: 3,364 source files / 357k lines across 3 repositories took about 7M tokens to read
// and became about 580 articles (about 20 tokens per source line read, about 1 article per 6 source files).
export interface EffortInput {
  sourceFiles: number; sourceLines: number; readers: number;
  depth?: 'standard' | 'compact' | undefined; changedFiles?: number | undefined; changedLines?: number | undefined;
  canRunCommands?: boolean | undefined;
}
const M = (tokens: number) => Math.round(tokens / 100_000) / 10 + 'M';
export function estimateEffort(input: EffortInput) {
  const update = input.changedFiles !== undefined || input.changedLines !== undefined;
  const readerFactor = 0.5 + 0.5 * Math.min(input.readers, 7) / 7;
  const perArticle = (depth: 'standard' | 'compact') => (depth === 'compact' ? 7_000 : 12_000) * readerFactor;
  const transport = (articles: number) => input.canRunCommands === false ? articles * 18_000 : articles * 300;
  const plan = (depth: 'standard' | 'compact') => {
    if (update) {
      const lines = input.changedLines ?? (input.changedFiles ?? 0) * 150;
      const articles = Math.max(3, Math.ceil((input.changedFiles ?? lines / 150) * 1.5));
      const reading = lines * 25 + articles * 4_000;
      const writing = articles * perArticle(depth);
      return { articles, reading, writing, transport: transport(articles), total: reading + writing + transport(articles) };
    }
    const articles = Math.max(30, Math.round(input.sourceFiles / 6));
    const reading = input.sourceLines * 20;
    const writing = articles * perArticle(depth);
    return { articles, reading, writing, transport: transport(articles), total: reading + writing + transport(articles) };
  };
  const chosen = input.depth ?? 'standard';
  const standard = plan('standard'), compact = plan('compact'), current = chosen === 'compact' ? compact : standard;
  const large = !update && (standard.articles > 150 || standard.total > 4_000_000);
  return {
    kind: update ? 'update' : 'new documentation',
    estimate: { articles: current.articles, readingCode: M(current.reading), writing: M(current.writing), sending: M(current.transport), total: M(current.total) },
    ...(chosen === 'standard' && large ? { compactAlternative: { total: M(compact.total), saves: Math.round((1 - compact.total / standard.total) * 100) + '%' } } : {}),
    recommendation: large && chosen === 'standard'
      ? 'Large project: tell the user this estimate and offer depth "compact" (fewer parts per article) before starting; reading the code is a one-time cost, and saved code notes make later updates small.'
      : update ? 'Tell the user this estimate. Read only changed files and the articles pages_for_files and related_articles return.'
      : 'Tell the user this estimate before starting.',
    notes: [
      'Estimates assume the hosted push-records.mjs script sends records' + (input.canRunCommands === false ? ' — this host cannot run commands, so records are pasted inline, which costs far more.' : '.'),
      'Long sessions may pause at usage limits; work resumes from files, so nothing is redone.'
    ]
  };
}
