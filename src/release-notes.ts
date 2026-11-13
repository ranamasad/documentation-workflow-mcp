interface ReleaseRecord { key: string; page?: string; data?: unknown }
export interface ReleaseNoteIssue { key: string; code: string; message: string }

export const releaseNoteGuidance = 'Every publication version needs a release-notes article with matching value.version. Preserve previous release entries, describe only this version and link its affected articles. State "Documentation-only" when application behavior is unchanged, or "Application changes" when implemented product behavior changed. Links to feature documentation do not imply a feature change.';

export function checkReleaseNotes(records: ReleaseRecord[], version?: string): ReleaseNoteIssue[] {
  if (!version) return [];
  const releases = records.filter(record => (record.page ?? record.key.split('/')[0]) === 'release-notes');
  const matches = releases.filter(record => (record.data as {value?: {version?: unknown}} | undefined)?.value?.version === version);
  if (!matches.length) return [{key: 'snapshot', code: 'RELEASE_NOTES_MISSING', message: 'No release-note entry matches publication version ' + version + '. ' + releaseNoteGuidance}];
  if (matches.length > 1) return [{key: 'snapshot', code: 'RELEASE_NOTES_DUPLICATE', message: 'More than one release-note article declares version ' + version + '. Keep one entry for this version.'}];
  const record = matches[0]!;
  const data = record.data as {blocks?: unknown[]; value?: {highlights?: string}};
  const issues: ReleaseNoteIssue[] = [];
  const scopeText: string[] = [data.value?.highlights ?? ''];
  const links = new Set<string>();
  const known = new Set(records.map(item => item.key));
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      scopeText.push(value);
      for (const match of value.matchAll(/#\/([a-z][a-z0-9-]*\/[a-zA-Z0-9_-]+)(?![\w/-])/g)) {
        if (match[1] !== record.key && known.has(match[1]!)) links.add(match[1]!);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(data.blocks);
  if (!/\bdocumentation[- ]only\b|\bapplication changes\b/i.test(scopeText.join('\n'))) issues.push({key: record.key, code: 'RELEASE_NOTES_SCOPE',
    message: 'Explicitly state "Documentation-only" or "Application changes" and explain the actual scope. The validator cannot infer whether application code changed.'});
  if (!links.size) issues.push({key: record.key, code: 'RELEASE_NOTES_LINKS', message: 'Link to the articles affected by this version; a self-link or site navigation is not an affected-article link.'});
  return issues;
}