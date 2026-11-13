import { z } from 'zod';

const gitRef = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
  .refine(value => !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.') &&
    !value.split('/').some(part => part.endsWith('.lock')), 'Use a Git branch or tag name, not a local path or revision expression.');

export const sourceBaseline = z.strictObject({
  name: z.string().trim().min(1).max(120),
  repository: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
    .refine(value => !value.includes('..') && !value.includes('//') && !value.endsWith('/'), 'Use a stable repository identity without credentials or a local folder path.'),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'Use the full reviewed Git commit SHA, not HEAD, a branch or an abbreviated hash.'),
  branch: gitRef.optional(),
  tag: gitRef.optional()
});
export const sourceBaselines = z.array(sourceBaseline).min(1).max(12)
  .refine(items => new Set(items.map(item => item.repository)).size === items.length, 'Repository identities must be unique.')
  .refine(items => new Set(items.map(item => item.name)).size === items.length, 'Repository names must be unique.');
export type SourceBaseline = z.infer<typeof sourceBaseline>;

export const sourceBaselineRecord = z.strictObject({
  version: z.literal(1),
  projectId: z.uuid(),
  environment: z.enum(['development', 'beta', 'production']),
  releaseId: z.uuid(),
  repositories: sourceBaselines,
  recordedAt: z.iso.datetime(),
  recordedBy: z.string().min(1).max(320),
  updatedAt: z.iso.datetime().optional(),
  updatedBy: z.string().min(1).max(320).optional()
});
export type SourceBaselineRecord = z.infer<typeof sourceBaselineRecord>;

export function mergeSourceBaselines(previous: SourceBaseline[], reviewed: SourceBaseline[]): SourceBaseline[] {
  const result = new Map(previous.map(item => [item.repository, item]));
  for (const item of reviewed) {
    const old = previous.find(candidate => candidate.name === item.name);
    if (old && old.repository !== item.repository) throw new Error('Repository identity changed for ' + item.name + '; confirm the repository mapping instead of reusing its baseline.');
    result.set(item.repository, item);
  }
  return sourceBaselines.parse([...result.values()]);
}

export function addSourceBaselineTags(previous: SourceBaseline[], requested: SourceBaseline[]): SourceBaseline[] {
  const byRepository = new Map(requested.map(item => [item.repository, item]));
  if (requested.length !== previous.length) throw new Error('This release already has a different source baseline. Repository mappings cannot be replaced.');
  return sourceBaselines.parse(previous.map(item => {
    const next = byRepository.get(item.repository);
    if (!next || next.name !== item.name || next.commit !== item.commit || next.branch !== item.branch || (item.tag && next.tag !== item.tag)) {
      throw new Error('This release already has a different source baseline. Never overwrite reviewed commits or move documentation tags.');
    }
    return next.tag ? {...item, tag: next.tag} : item;
  }));
}