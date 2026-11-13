import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { createDocumentationV3, type V3Access } from '../src/documentation-v3.js';
import type { Issue } from '../src/issues.js';
import { computeProfileStats, createProfileStats, type ProfileVisit, type ProfileVote, type TitleStore } from '../src/profile-stats.js';

const DAY = 86_400_000;
const masterKey = Buffer.alloc(32, 61).toString('base64url');
const now = Date.parse('2026-11-02T12:00:00Z');
const me = 'reader-me', other = 'reader-other';
const access: V3Access = {
  projectId: '11111111-1111-4111-8111-111111111111', userId: null, name: 'Docs', role: 'none', email: 'me@example.com',
  readerUid: me, displayName: 'Me', administrator: false, environments: ['production'], firebaseProject: 'test-project', serviceAccountKey: 'test-only'
};
const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
const visit = (uid: string, route: string, daysAgo: number, activeMs: number, environment = 'production'): ProfileVisit =>
  ({ uid, environment, route, sessionId: 'session-' + daysAgo, openedAt: at(daysAgo), activeMs });
const vote = (uid: string, helpful: boolean, daysAgo: number, environment = 'production'): ProfileVote =>
  ({ uid, environment, helpful, updatedAt: at(daysAgo) });
function issue(uid: string, status: Issue['status'], daysAgo: number, environment: Issue['environment'] = 'production', type: Issue['type'] = 'issue'): Issue {
  return { id: crypto.randomUUID(), environment, type, status, title: 'Title', description: 'Description text', original: 'Original text', ai: false,
    page: null, reporter: { uid, email: uid + '@example.com', displayName: '' }, assignee: null, assignedBy: null, assignedAt: null,
    answer: status === 'answered' ? { text: 'Answer', by: 'dev@example.com', at: at(daysAgo) } : null,
    history: [{ kind: 'created', by: uid + '@example.com', at: at(daysAgo) }, ...(status === 'open' ? [{ kind: 'replied' as const, by: uid + '@example.com', at: at(daysAgo), text: 'More' }] : [])],
    createdAt: at(daysAgo), updatedAt: at(daysAgo) };
}

test('profile statistics count only the verified reader in authorized environments', () => {
  const stats = computeProfileStats({ uid: me, environments: ['production'], now, partial: false,
    visits: [visit(me, 'guides/a', 0, 40_000), visit(me, 'guides/a', 1, 10_000), visit(me, 'guides/b', 1, 20_000), visit(me, '_issues', 2, 90_000),
      visit(other, 'guides/c', 0, 900_000), visit(me, 'guides/d', 0, 900_000, 'beta')],
    votes: [vote(me, true, 3), vote(me, false, 4), vote(other, true, 1), vote(me, true, 1, 'beta')],
    issues: [issue(me, 'open', 5), issue(me, 'answered', 6, 'production', 'faq'), issue(other, 'open', 1), issue(me, 'open', 1, 'beta')] });
  assert.equal(stats.reading.activeMs, 160_000);
  assert.equal(stats.reading.articles, 1, 'Only guides/a reaches 30 seconds; site screens never count as articles.');
  assert.equal(stats.reading.activeDays, 3);
  assert.equal(stats.reading.streakDays, 3);
  assert.deepEqual(stats.issues, { created: 1, questions: 1, pending: 1, answered: 1, closed: 0, replies: 1 });
  assert.deepEqual(stats.feedback, { votes: 2, helpful: 1, notHelpful: 1 });
  assert.deepEqual(stats.scope.environments, ['production']);
  assert.deepEqual(stats.score.parts.map(part => part.points), [1, 10, 15, 50, 4]);
  assert.equal(stats.score.value, 80);
  assert.equal('level' in stats.score, false, 'The AI title is the only title; there are no levels.');
});

test('every score part is capped and only the 90-day window scores', () => {
  const visits = Array.from({ length: 120 }, (_, index) => visit(me, 'guides/' + index, index, 3_600_000));
  const stats = computeProfileStats({ uid: me, environments: ['production'], now, partial: true, visits,
    votes: Array.from({ length: 80 }, (_, index) => vote(me, true, index)), issues: Array.from({ length: 20 }, (_, index) => issue(me, 'answered', index)) });
  assert.deepEqual(stats.score.parts.map(part => part.points), [300, 250, 150, 200, 100]);
  assert.equal(stats.score.value, 1000);
  assert.equal(stats.score.max, 1000);
  assert.equal(stats.reading.articles, 120, 'Totals are all-time; only the score uses the window.');
  assert.equal(stats.reading.activeDays, 91);
  assert.equal(stats.partial, true);
  const old = computeProfileStats({ uid: me, environments: ['production'], now, partial: false,
    visits: [visit(me, 'guides/old', 200, 3_600_000)], votes: [vote(me, true, 200)], issues: [issue(me, 'answered', 200)] });
  assert.equal(old.score.value, 0);
  assert.equal(old.reading.streakDays, 0);
});

test('profile service requires a website reader and reuses a cached summary', async () => {
  let reads = 0, clock = now;
  const service = createProfileStats({ masterKey, now: () => clock, titleStore: () => memoryTitles().store,
    telemetryOf: async () => { reads++; return { visits: [visit(me, 'guides/a', 0, 60_000)], votes: [], truncated: false }; },
    issuesOf: async () => ({ issues: [issue(me, 'open', 0)], truncated: false }) });
  await assert.rejects(service({ ...access, readerUid: undefined } as unknown as V3Access), /verified website reader/);
  const first = await service(access) as { stats: { reading: { articles: number } } };
  assert.equal(first.stats.reading.articles, 1);
  await service(access);
  assert.equal(reads, 1);
  clock += 6 * 60_000;
  await service(access);
  assert.equal(reads, 2);
});

function memoryTitles() {
  const saved = new Map<string, unknown>();
  const store: TitleStore = { async get(path) { return saved.get(path) ?? null; }, async put(path, data) { saved.set(path, data); } };
  return { saved, store };
}

test('Gemini writes the profile title from numbers and the team only; it is saved sealed and reused until the score band, main activity or team changes', async () => {
  const titles = memoryTitles();
  const asked: Record<string, string | number>[] = [];
  let clock = now, visits = [visit(me, 'guides/a', 0, 60_000)];
  const service = createProfileStats({ masterKey, now: () => clock, aiKey: async () => 'gemini-key', titleStore: () => titles.store,
    writeTitle: async (key, activity) => { assert.equal(key, 'gemini-key'); asked.push(activity); return { title: 'Curious Mind', tagline: 'Reads with purpose.' }; },
    telemetryOf: async () => ({ visits, votes: [], truncated: false }), issuesOf: async () => ({ issues: [], truncated: false }) });
  const first = await service({ ...access, team: 'Support' }) as { stats: { profile: Record<string, unknown> } };
  assert.deepEqual(first.stats.profile, { title: 'Curious Mind', tagline: 'Reads with purpose.', source: 'gemini', team: 'Support' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.team, 'Support', 'The title fits the reader\'s team.');
  assert.doesNotMatch(JSON.stringify(asked[0]), /me@example|reader-me|Me\b|guides/, 'Gemini sees activity numbers, never identity or routes.');
  const sealed = JSON.stringify([...titles.saved.values()]);
  assert.doesNotMatch(sealed, /Curious Mind/, 'The saved title is encrypted.');
  assert.doesNotMatch([...titles.saved.keys()].join(), /reader-me/, 'The storage path does not reveal the reader.');
  clock += 10 * 60_000;
  await service({ ...access, team: 'Support' });
  assert.equal(asked.length, 1, 'An unchanged score band, main activity and team reuse the saved title.');
  visits = Array.from({ length: 40 }, (_, index) => visit(me, 'guides/' + index, index % 30, 600_000));
  clock += 10 * 60_000;
  await service({ ...access, team: 'Support' });
  assert.equal(asked.length, 2, 'A new score band asks Gemini again.');
  clock += 10 * 60_000;
  await service({ ...access, team: 'Testers' });
  assert.equal(asked.length, 3, 'A new team asks Gemini again.');
  assert.equal(asked[2]!.team, 'Testers');
});

test('without a Gemini key the profile gets a rule-based title for its main activity', async () => {
  const service = createProfileStats({ masterKey, now: () => now, titleStore: () => memoryTitles().store, aiKey: async () => null,
    writeTitle: async () => assert.fail('No key, no Gemini call'),
    telemetryOf: async () => ({ visits: [], votes: [], truncated: false }),
    issuesOf: async () => ({ issues: [issue(me, 'open', 1), issue(me, 'open', 2)], truncated: false }) });
  const result = await service(access) as { stats: { profile: Record<string, unknown> } };
  assert.deepEqual(result.stats.profile, { title: 'Sharp Eye', tagline: 'Spots problems and asks the questions that improve the docs.', source: 'rules', team: null });
});

test('gateway serves profile statistics only to website credentials', async () => {
  let calls = 0;
  const handler = createDocumentationV3({
    allowedOrigins: new Set(), rpc: async () => { throw new Error('Unexpected RPC'); },
    authenticate: async () => access,
    profile: async identity => { calls++; assert.equal(identity.readerUid, me); return { stats: { ok: true } }; }
  });
  const call = async (body: unknown) => {
    const req = Object.assign(Readable.from([]), { method: 'POST', headers: { 'content-type': 'application/json' }, body }) as IncomingMessage & { body: unknown };
    let status = 0, output: unknown;
    const res = { setHeader() {}, writeHead(value: number) { status = value; }, end(text: string) { output = JSON.parse(text); } };
    await handler(req, res as unknown as ServerResponse);
    return { status, output };
  };
  const body = { action: 'profile.stats', siteToken: 'dsite_' + 'a'.repeat(43) };
  assert.deepEqual(await call(body), { status: 200, output: { stats: { ok: true } } });
  assert.equal((await call({ action: 'profile.stats' })).status, 403);
  assert.equal((await call({ ...body, uid: 'someone-else' })).status, 400, 'A caller cannot choose whose statistics to read.');
  assert.equal(calls, 1);
});
