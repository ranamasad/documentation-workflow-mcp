import { pagesForFiles, relatedArticles } from './doc-graph.js';
import { z } from 'zod';
import type { ProjectStore } from './project-store.js';
import { createManagedDocumentation, readDocumentationEncryptionKey } from './managed-documentation.js';
import { wireRecord } from './validation.js';
import {
  createFirestoreReader, FirestoreAccessError, navigationEntries, openRelease, personalTokens, readArticles,
  searchEntries, serviceAccountTokens, type PublishedRelease
} from './firestore.js';

// Read-only access to a project's published documentation for any workspace member,
// including viewers (testers, product owners). Live from Firestore; nothing is copied.

export const readAccess = z.object({
  projectId: z.string().uuid(), name: z.string(), role: z.enum(['owner', 'admin', 'author', 'viewer']),
  firebaseProject: z.string().nullable(), firebaseApiKey: z.string().nullable(),
  environments: z.array(z.enum(['development', 'beta', 'production'])),
  mode: z.enum(['service-account', 'personal']).nullable(),
  serviceAccountKey: z.string().nullable(), personalRefreshToken: z.string().nullable()
});
export type ReadAccess = z.infer<typeof readAccess>;

export interface PublishedInput { project: string; workspace?: string | undefined; environment?: 'development' | 'beta' | 'production' | undefined }

async function open(store: ProjectStore, input: PublishedInput, fetchService: typeof fetch) {
  const access = await store.readAccess(input.project, input.workspace);
  if (!access.firebaseProject) throw new FirestoreAccessError(400, 'This project has no Firebase project ID yet. Add firebaseProject to the project in projects.json.');
  let tokens;
  if (access.mode === 'service-account') {
    if (!access.serviceAccountKey) throw new FirestoreAccessError(400, 'An owner or admin must upload the project\'s read-only service-account key under Projects.');
    tokens = serviceAccountTokens(access.serviceAccountKey, fetchService);
  } else if (access.mode === 'personal') {
    if (!access.firebaseApiKey) throw new FirestoreAccessError(400, 'This project needs its Firebase web API key for personal sign-in. An author can add it under Projects.');
    if (!access.personalRefreshToken) throw new FirestoreAccessError(401, 'Connect your Firebase sign-in for this project in the dashboard under Projects, then try again.');
    tokens = personalTokens(access.firebaseApiKey, access.personalRefreshToken, fetchService);
  } else {
    throw new FirestoreAccessError(400, 'Documentation access is not set up for this project. An owner or admin chooses a service account or personal sign-in under Projects.');
  }
  const environment = input.environment ?? access.environments[0];
  if (!environment || !access.environments.includes(environment)) {
    throw new FirestoreAccessError(403, 'You can read: ' + (access.environments.join(', ') || 'no environments') + '.');
  }
  const reader = createFirestoreReader(access.firebaseProject, tokens, fetchService);
  if (await reader.get('documentationV3Environments/' + environment)) {
    if (!readDocumentationEncryptionKey()) throw new FirestoreAccessError(503,
      'Server-managed encryption is not configured. Contract-v3 requires MCP_DOCUMENTATION_ENCRYPTION_KEY; old E2EE releases must be explicitly migrated.');
    if (access.mode !== 'service-account' || !access.serviceAccountKey) {
      throw new FirestoreAccessError(409, 'This encrypted environment requires a configured managed service-account key.');
    }
    const snapshot = await createManagedDocumentation({ ...access, firebaseProject: access.firebaseProject,
      serviceAccountKey: access.serviceAccountKey }, { fetchService }).read(environment);
    const records = snapshot.records.map(record => wireRecord.parse(record));
    const foundation = records.find(record => record.key === 'foundation');
    if (!foundation) throw new FirestoreAccessError(502, 'The encrypted release has no foundation.');
    const metadata = snapshot.metadata;
    const release: PublishedRelease = { environment, releaseId: snapshot.head!.releaseId,
      version: metadata?.version ?? '', tags: metadata?.tags ?? [], summary: metadata?.summary ?? '',
      operation: metadata?.operation ?? 'import', createdAt: null,
      manifest: Object.fromEntries(records.map(record => [record.key, record.key])), areaChanges: {} };
    return { access, reader, release, foundation, environment, records, format: 3 as const, sourceBaselines: snapshot.sourceBaselines };
  }
  const release = await openRelease(reader, environment);
  if (!release) throw new FirestoreAccessError(404, 'Nothing is published in ' + environment + ' yet.');
  const [foundation] = await readArticles(reader, release, ['foundation']);
  return { access, reader, release, foundation: foundation!, environment, records: undefined, format: undefined };
}

const releaseSummary = (release: PublishedRelease) => ({
  environment: release.environment, releaseId: release.releaseId, version: release.version, tags: release.tags,
  summary: release.summary, operation: release.operation, publishedAt: release.createdAt, articles: Object.keys(release.manifest).length - 1
});

export function createPublishedDocumentation(store: ProjectStore, fetchService: typeof fetch = fetch) {
  return {
    async overview(input: PublishedInput & { offset?: number | undefined; limit?: number | undefined }) {
      const { access, release, foundation, format, ...opened } = await open(store, input, fetchService);
      const data = foundation.data as { meta?: { appName?: string; subtitle?: string }; sections?: { id: string; collection: string; layout: string }[];
        navigation?: { tabs?: { id: string; label: string }[] } };
      const entries = navigationEntries(foundation);
      const offset = input.offset ?? 0, limit = input.limit ?? 200;
      const legacy = (foundation.data as { schemaVersion?: unknown }).schemaVersion !== 2;
      const publishedFormat = format ?? (legacy ? 1 : 2);
      return {
        project: access.name, readableEnvironments: access.environments, release: releaseSummary(release),
        ...(format === 3 ? {sourceBaselines: 'sourceBaselines' in opened ? opened.sourceBaselines : null} : {}),
        format: publishedFormat,
        ...(publishedFormat !== 3 ? {
          formatNotice: `This release uses legacy v${publishedFormat} rather than encrypted v3. For updates, audits or promotion, ask the user whether to migrate with migrate_documentation_to_v3. Read-only use may continue without migration. Only an owner/admin may migrate, after explicit approval; never silently rewrite Firebase or delete old history.`,
          migration: { targetFormat: 3, tool: 'migrate_documentation_to_v3', requiresApproval: true, requiresOwnerOrAdmin: true }
        } : {}),
        site: { name: data.meta?.appName ?? null, subtitle: data.meta?.subtitle ?? null },
        sections: (data.navigation?.tabs ?? []).map(tab => ({ id: tab.id, label: tab.label,
          ...(data.sections?.find(section => section.id === tab.id) ? { layout: data.sections.find(section => section.id === tab.id)!.layout } : {}) })),
        articles: entries.slice(offset, offset + limit),
        totalArticles: entries.length,
        ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {})
      };
    },
    async search(input: PublishedInput & { query: string; limit?: number | undefined }) {
      const { release, foundation, records } = await open(store, input, fetchService);
      const entries = navigationEntries(foundation);
      const query = input.query.toLowerCase().trim();
      const results = records ? entries.filter(entry => {
        const record = records.find(record => record.key === entry.key);
        return (entry.label + ' ' + entry.key + ' ' + JSON.stringify(record?.data)).toLowerCase().includes(query);
      }).slice(0, input.limit ?? 20) : searchEntries(entries, input.query, input.limit ?? 20);
      return {
        release: releaseSummary(release),
        results,
        note: records ? 'Search includes decrypted article content. Read matching articles for details.'
          : 'Matches article titles and keys. Read the most relevant articles with read_published_documentation for details.'
      };
    },
    /** Links, shared endpoints/messages and cited source files around one article (encrypted v3 releases). */
    async related(input: PublishedInput & { key: string; limit?: number | undefined }) {
      const { release, records } = await open(store, input, fetchService);
      if (!records) throw new FirestoreAccessError(409, 'Related articles need encrypted v3 documentation. Migrate this environment first, or use search_published_documentation.');
      const related = relatedArticles(records, input.key, input.limit ?? 25);
      if (!related) throw new FirestoreAccessError(404, 'Not published in ' + release.environment + ': ' + input.key);
      return { release: releaseSummary(release), ...related };
    },
    /** The articles whose Technical details cite each changed source file (encrypted v3 releases). */
    async pagesForFiles(input: PublishedInput & { files: string[] }) {
      const { release, records } = await open(store, input, fetchService);
      if (!records) throw new FirestoreAccessError(409, 'Mapping files to articles needs encrypted v3 documentation. Migrate this environment first, or search by feature name.');
      return { release: releaseSummary(release), ...pagesForFiles(records, input.files) };
    },
    async read(input: PublishedInput & { keys: string[] }) {
      const { reader, release, records: managed } = await open(store, input, fetchService);
      const records = managed ? input.keys.map(key => {
        const record = managed.find(record => record.key === key);
        if (!record) throw new FirestoreAccessError(404, 'Not published in ' + release.environment + ': ' + key);
        return record;
      }) : await readArticles(reader, release, input.keys);
      return {
        release: releaseSummary(release),
        articles: records.map(record => ({ key: record.key, section: record.page, title: record.title, content: record.data,
          lastChange: release.areaChanges[record.key] ? { version: release.areaChanges[record.key]!.version, tags: release.areaChanges[record.key]!.tags,
            summary: release.areaChanges[record.key]!.summary } : null }))
      };
    },
    async changes(input: PublishedInput) {
      const { release, foundation } = await open(store, input, fetchService);
      const labels = new Map(navigationEntries(foundation).map(entry => [entry.key, entry.label]));
      const changed = Object.entries(release.areaChanges).filter(([, change]) => change.releaseId === release.releaseId)
        .map(([key, change]) => ({ key, title: labels.get(key) ?? key, version: change.version, tags: change.tags, summary: change.summary,
          kind: change.before === '' ? 'added' : 'changed' }));
      return {
        release: releaseSummary(release),
        changes: changed,
        note: changed.length ? 'Read an article with read_published_documentation to see its full current content.'
          : 'This release has no per-article change notes; see the release summary.'
      };
    }
  };
}
