import assert from 'node:assert/strict';
import test from 'node:test';
import type { V3Access } from '../src/documentation-v3.js';
import { DocumentationV3Error } from '../src/documentation-v3.js';
import { generateKeyPairSync } from 'node:crypto';
import { CLOSED_FILES_MS, createIssues, createIssueStore, cronAuthorized, geminiPolisher, geminiWriter, groqPolisher, groqWriter, plainIssue, type IssueStore, type PolishRequest } from '../src/issues.js';

const masterKey = Buffer.alloc(32, 7).toString('base64url');
const projectId = '22222222-2222-4222-8222-222222222222';
const base: V3Access = {
  projectId, userId: null, name: 'Docs', role: 'none', email: 'tester@example.com', readerUid: 'tester-uid', displayName: 'Tess',
  administrator: false, environments: ['development'], firebaseProject: 'test-project', serviceAccountKey: 'test-only'
};
const member = (email: string, role: V3Access['role'], environments: V3Access['environments'] = ['development', 'beta']): V3Access =>
  ({ ...base, userId: '33333333-3333-4333-8333-333333333333', email, role, environments, administrator: ['owner', 'admin'].includes(role) });

function fixture(options: { aiKey?: string | null; generated?: { title: string; description: string } | null;
  generate?: Parameters<typeof createIssues>[0]['generate']; fallback?: Parameters<typeof createIssues>[0]['fallback']; polish?: Parameters<typeof createIssues>[0]['polish']; polishFallback?: Parameters<typeof createIssues>[0]['polishFallback']; groqKey?: string; teamEmails?: (body: unknown) => string[]; people?: { email: string; name: string | null }[] } = {}) {
  const documents = new Map<string, { data: unknown; version: string }>();
  const parts = new Map<string, unknown>();
  let clock = 0;
  const store: IssueStore = {
    async get(path) { return documents.get(path) ?? null; },
    async write(path, data, version, changes) {
      const current = documents.get(path);
      if ((current?.version ?? null) !== version) throw new DocumentationV3Error(409, 'race');
      documents.set(path, { data, version: 'v' + ++clock });
      for (const part of changes?.set ?? []) parts.set(part.path, part.data);
      for (const part of changes?.remove ?? []) parts.delete(part);
    },
    async remove(path, version, removed) {
      if (documents.get(path)?.version !== version) throw new DocumentationV3Error(409, 'race');
      documents.delete(path);
      for (const part of removed ?? []) parts.delete(part);
    },
    async readPart(path) { return parts.get(path) ?? null; },
    async list() { return [...documents].map(([path, entry]) => ({ path, data: entry.data })); }
  };
  const members: Record<string, V3Access> = {
    owner: member('owner@example.com', 'owner'), dev: member('dev@example.com', 'author'),
    other: member('other@example.com', 'author'), viewer: member('viewer@example.com', 'viewer', ['beta'])
  };
  const generatedFor: string[] = [];
  const pending: Promise<unknown>[] = [];
  const issues = createIssues({
    masterKey, store: () => store, now: () => Date.UTC(2026, 9, 23) + clock * 1000,
    background: task => { pending.push(task); },
    ...(options.fallback ? { fallback: options.fallback } : {}),
    ...(options.polish ? { polish: options.polish } : {}),
    ...(options.polishFallback ? { polishFallback: options.polishFallback } : {}),
    generate: options.generate ?? (async (key, report) => { generatedFor.push(key + ':' + report.text); return options.generated === undefined ? { title: 'Login button does nothing', description: 'Tapping Login on the sign-in page has no effect.' } : options.generated; }),
    async rpc(name, body) {
      const input = body as Record<string, string>;
      if (name === 'mcp_issue_ai_key') return options.aiKey === undefined ? 'gemini-test-key-000000000000' : options.aiKey;
      if (name === 'mcp_issue_groq_key') return options.groqKey ?? null;
      if (name === 'mcp_issue_team_emails' && options.teamEmails) return options.teamEmails(body);
      if (name === 'mcp_issue_assignees') return ['dev@example.com', 'other@example.com', 'owner@example.com'];
      if (name === 'mcp_issue_people' && options.people) return options.people;
      if (name === 'mcp_v3_access') return members[input.member === 'owner' ? 'owner' : input.member!]!;
      throw new Error('Unexpected RPC ' + name);
    }
  });
  /** Wait for Gemini's write-ups that run after issues.create has answered. */
  const settled = async () => { while (pending.length) await pending.shift(); };
  return { issues, documents, parts, generatedFor, settled };
}

test('a reader raises an issue that Gemini writes up afterwards; it is sealed in Firestore', async () => {
  const { issues, documents, generatedFor, settled } = fixture();
  const created = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue',
    text: 'login button not working when i tap it nothing happens',
    page: { route: '#/guides/login', title: 'Signing in', excerpt: 'Signing in\nTap Login after entering your email.' } }) as { issue: Record<string, unknown> };
  // The reader is answered at once with their own words; the page text stays on the server.
  assert.equal(created.issue.title, 'login button not working when i tap it nothing happens');
  assert.deepEqual(created.issue.page, { route: '#/guides/login', title: 'Signing in' });
  assert.equal(created.issue.mine, true);
  assert.equal(created.issue.status, 'open');
  await settled();
  assert.deepEqual(generatedFor, ['gemini-test-key-000000000000:login button not working when i tap it nothing happens']);
  const [written] = (await issues.member('owner', null, 'Docs').list()).issues;
  assert.equal(written!.title, 'Login button does nothing');
  assert.equal(written!.ai, true);
  assert.equal(written!.aiPending, false);
  assert.equal(written!.page?.excerpt, 'Signing in\nTap Login after entering your email.');
  const [stored] = [...documents.values()];
  const raw = JSON.stringify(stored!.data);
  assert.doesNotMatch(raw, /login button|tester@example\.com|Signing in/);
  assert.match([...documents.keys()][0]!, /^documentationV3Issues\/22222222-2222-4222-8222-222222222222\/issues\/[0-9a-f-]{36}$/);
});

test('without a Gemini key or when Gemini fails, the reader\'s own words are used', async () => {
  for (const options of [{ aiKey: null }, { generated: null }]) {
    const { issues, generatedFor, settled } = fixture(options);
    await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'faq',
      text: 'How do I reset a user password? The admin panel has no button for it.' });
    await settled();
    const [issue] = (await issues.member('owner', null, 'Docs').list()).issues;
    assert.equal(issue!.title, 'How do I reset a user password?');
    assert.match(issue!.description, /admin panel/);
    assert.equal(issue!.ai, false);
    assert.equal(issue!.aiPending, options.aiKey === null ? undefined : false);
    assert.equal(generatedFor.length, options.aiKey === null ? 0 : 1);
  }
  assert.equal(plainIssue({ environment: 'development', type: 'issue', text: 'x'.repeat(150) }).title.length, 98);
});

test('owners assign, the assignee answers, and readers then see the answer', async () => {
  const { issues } = fixture();
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  const owner = issues.member('owner', null, 'Docs');
  const dev = issues.member('dev', null, 'Docs');
  const other = issues.member('other', null, 'Docs');

  await assert.rejects(dev.update({ id: issue.id, assignee: 'dev@example.com' }), /owners and admins assign/);
  await assert.rejects(owner.update({ id: issue.id, assignee: 'stranger@example.com' }), /owner, admin or author/);
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });

  const mine = await dev.list({ status: 'unanswered', assigned: 'me' });
  assert.equal(mine.issues.length, 1);
  assert.equal(mine.issues[0]!.reporter.email, 'tester@example.com');
  assert.equal(mine.aiConfigured, true);
  assert.equal(mine.groqConfigured, false);
  assert.equal((await other.list({ assigned: 'me' })).issues.length, 0);

  await assert.rejects(other.update({ id: issue.id, answer: 'Not mine' }), /assigned person/);
  const answered = await dev.update({ id: issue.id, answer: 'Exports skip archived rows. Untick "Hide archived" first.' });
  assert.equal(answered.issue.status, 'answered');
  assert.equal(answered.issue.answer?.by, 'dev@example.com');

  const otherReader = { ...base, readerUid: 'someone-else', email: 'po@example.com' };
  const seen = await issues.reader(otherReader, { action: 'issues.list', environment: 'development' }) as { issues: Record<string, unknown>[] };
  assert.equal(seen.issues.length, 1);
  assert.equal(seen.issues[0]!.mine, false);
  assert.equal(seen.issues[0]!.original, undefined);
  assert.equal(seen.issues[0]!.reporter, 'Tess');
  assert.equal(seen.issues[0]!.assignee, 'dev@example.com');
  assert.equal((seen.issues[0]!.answer as { by: string }).by, 'dev@example.com');

  await dev.update({ id: issue.id, status: 'closed' });
  assert.equal((await issues.reader(otherReader, { action: 'issues.list', environment: 'development' }) as { issues: unknown[] }).issues.length, 0);
});

test('readers see only their own open issues, and only in their environments', async () => {
  const { issues } = fixture();
  await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'Private report from the tester.' });
  const other = { ...base, readerUid: 'someone-else' };
  assert.equal((await issues.reader(other, { action: 'issues.list', environment: 'development' }) as { issues: unknown[] }).issues.length, 0);
  await assert.rejects(issues.reader(base, { action: 'issues.list', environment: 'production' }), /Environment access denied/);
  await assert.rejects(issues.reader(base, { action: 'issues.create', environment: 'production', type: 'issue', text: 'Report in production.' }), /Environment access denied/);
  // A viewer limited to Beta does not see Development issues.
  assert.equal((await issues.member('viewer', null, 'Docs').list()).issues.length, 0);
});

test('owners and admins see every issue; other members only the ones assigned to them', async () => {
  const { issues } = fixture({ people: [{ email: 'dev@example.com', name: 'Dana Dev' }, { email: 'owner@example.com', name: null }] });
  const first = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The first report from the tester.' }) as { issue: { id: string } };
  await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The second report from the tester.' });
  const owner = issues.member('owner', null, 'Docs');
  const dev = issues.member('dev', null, 'Docs');
  await owner.update({ id: first.issue.id, assignee: 'dev@example.com' });

  const all = await owner.list({ assigned: 'anyone' });
  assert.equal(all.issues.length, 2);
  assert.deepEqual(all.assignees, ['dev@example.com', 'owner@example.com']);
  assert.deepEqual(all.names, { 'dev@example.com': 'Dana Dev' });
  assert.equal((await owner.list({ assigned: 'unassigned' })).issues.length, 1);
  // The assigned filter is ignored for members: they always get exactly their own issues.
  for (const assigned of ['anyone', 'unassigned', 'me'] as const) {
    assert.deepEqual((await dev.list({ assigned })).issues.map(issue => issue.id), [first.issue.id]);
  }
  const [note] = (await dev.notifications()).notifications;
  assert.equal(note!.event.kind, 'assigned');
  assert.equal(note!.event.by, 'owner@example.com');
});

test('the Gemini writer sends the report as data and validates the answer', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const write = geminiWriter(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"Crash on save","description":"The app closes when saving a draft."}' }] } }] }));
  });
  assert.deepEqual(await write('key-123', { environment: 'development', type: 'issue', text: 'app crash when i save draft' }),
    { title: 'Crash on save', description: 'The app closes when saving a draft.' });
  assert.match(calls[0]!.url, /models\/gemini-3\.5-flash:generateContent$/);
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'], 'key-123');
  const failing = geminiWriter(async () => new Response('{"candidates":[{"content":{"parts":[{"text":"not json"}]}}]}'));
  assert.equal(await failing('key', { environment: 'development', type: 'issue', text: 'something happened here' }), null);
});

test('the write-up rules cover pasted emails and attachments, and Gemini gets one more try when busy', async () => {
  let calls = 0;
  let instruction = '';
  const write = geminiWriter(async (_url, init) => {
    calls += 1;
    instruction = JSON.parse(String(init!.body)).systemInstruction.parts[0].text;
    return calls === 1 ? new Response('{"error":{"message":"overloaded"}}', { status: 503 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"Acme enters View only mode","description":"What happened: Acme entered View only mode."}' }] } }] }));
  });
  const report = { environment: 'production', type: 'issue', text: 'Acme went into View only mode by itself, see screenshot attached.' } as const;
  assert.equal((await write('key', report))?.title, 'Acme enters View only mode');
  assert.equal(calls, 2);
  assert.match(instruction, /pasted email/);
  assert.match(instruction, /see screenshot attached/);
  assert.match(instruction, /signatures/);
  assert.match(instruction, /serial numbers/);
  assert.match(instruction, /never invent/);

  let rejected = 0;
  const badKey = geminiWriter(async () => { rejected += 1; return new Response('{}', { status: 403 }); });
  assert.equal(await badKey('key', report), null);
  assert.equal(rejected, 1, 'A rejected key is not worth another try.');
});

test('Groq writes the issue up with the workspace key when Gemini fails', async () => {
  const seen: { url: string; authorization: string; system: string }[] = [];
  const write = groqWriter(async (url, init) => {
    const body = JSON.parse(String(init!.body));
    seen.push({ url: String(url), authorization: (init!.headers as Record<string, string>).Authorization!, system: body.messages[0].content });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Crash on save","description":"The app closes when saving."}' } }] }));
  }, 'test-model');
  assert.deepEqual(await write('groq-key', { environment: 'beta', type: 'issue', text: 'app crash when i save draft' }),
    { title: 'Crash on save', description: 'The app closes when saving.' });
  assert.match(seen[0]!.url, /api\.groq\.com/);
  assert.equal(seen[0]!.authorization, 'Bearer groq-key');
  assert.match(seen[0]!.system, /see screenshot attached/);

  const { issues, settled } = fixture({ generated: null, groqKey: 'groq-key', fallback: async () => ({ title: 'Written by Groq', description: 'Groq wrote this description.' }) });
  await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' });
  await settled();
  const stored = (await issues.member('owner', null, 'Docs').list({ status: 'all', assigned: 'anyone' })).issues[0]!;
  assert.equal(stored.title, 'Written by Groq');
  assert.equal(stored.ai, true);
  assert.equal(stored.original, 'The export button downloads an empty file.');
  assert.equal(stored.aiPending, false);
});

test('the reader never waits for Gemini; the dashboard shows the write-up when it is ready', async () => {
  let finish!: (value: { title: string; description: string }) => void;
  const { issues, settled } = fixture({ generate: () => new Promise(resolve => { finish = resolve; }) });
  const created = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue',
    text: 'The invoice total ignores the discount code.' }) as { issue: { title: string } };
  assert.equal(created.issue.title, 'The invoice total ignores the discount code');
  const owner = issues.member('owner', null, 'Docs');
  assert.equal((await owner.list()).issues[0]!.aiPending, true);
  finish({ title: 'Discount code not applied to invoice total', description: 'The invoice total does not subtract the discount code.' });
  await settled();
  const [issue] = (await owner.list()).issues;
  assert.equal(issue!.title, 'Discount code not applied to invoice total');
  assert.equal(issue!.aiPending, false);
  assert.deepEqual(issue!.history.map(event => event.kind), ['created']);
});

test('owners and admins edit an issue; the reporter sees the correction and keeps their own words', async () => {
  const { issues, settled } = fixture({ aiKey: null });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  const owner = issues.member('owner', null, 'Docs');
  const dev = issues.member('dev', null, 'Docs');
  await settled();

  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  await assert.rejects(dev.update({ id: issue.id, title: 'Mine now' }), /owners and admins edit/);
  await assert.rejects(dev.update({ id: issue.id, environment: 'beta' }), /owners and admins edit/);
  await assert.rejects(owner.update({ id: issue.id, title: '   ' }));

  const edited = await owner.update({ id: issue.id, title: 'Export is empty', description: 'Exports contain no rows.', environment: 'beta', type: 'faq' });
  assert.equal(edited.issue.title, 'Export is empty');
  assert.equal(edited.issue.description, 'Exports contain no rows.');
  assert.equal(edited.issue.environment, 'beta');
  assert.equal(edited.issue.type, 'faq');
  assert.equal(edited.issue.original, 'The export button downloads an empty file.');
  assert.equal(edited.issue.assignee, 'dev@example.com');
  const last = edited.issue.history.at(-1)!;
  assert.equal(last.kind, 'edited');
  assert.equal(last.by, 'owner@example.com');
  assert.match(last.text!, /title, description, environment \(development to beta\), type/);

  // Saving the same values records nothing.
  const same = await owner.update({ id: issue.id, title: 'Export is empty' });
  assert.equal(same.issue.history.length, edited.issue.history.length);

  // The assignee hears about it; the reporter sees the corrected issue in its new environment, without the edit in their history.
  assert.ok((await dev.notifications()).notifications.some(note => note.event.kind === 'edited'));
  const reader = { ...base, environments: ['development', 'beta'] } as typeof base;
  assert.equal((await issues.reader(reader, { action: 'issues.list', environment: 'development' }) as { issues: unknown[] }).issues.length, 0);
  const seen = (await issues.reader(reader, { action: 'issues.list', environment: 'beta' }) as { issues: { title: string; original: string; history: { kind: string }[] }[] }).issues[0]!;
  assert.equal(seen.title, 'Export is empty');
  assert.equal(seen.original, 'The export button downloads an empty file.');
  assert.ok(!seen.history.some(event => event.kind === 'edited'));
});

test('an edit made while Gemini is writing is not overwritten by the write-up', async () => {
  let finish!: (value: { title: string; description: string }) => void;
  const { issues, settled } = fixture({ generate: () => new Promise(resolve => { finish = resolve; }) });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  const owner = issues.member('owner', null, 'Docs');
  const edited = await owner.update({ id: issue.id, title: 'Written by the owner' });
  assert.equal(edited.issue.aiPending, false);
  finish({ title: 'Written by Gemini', description: 'Gemini description of the problem.' });
  await settled();
  const stored = (await owner.list()).issues[0]!;
  assert.equal(stored.title, 'Written by the owner');
  assert.equal(stored.ai, false);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(700 * 1024, 7)]);
async function reportWithFile(issues: ReturnType<typeof fixture>['issues'], reader = base) {
  const { issue } = await issues.reader(reader, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  const attached = await issues.reader(reader, { action: 'issues.attach', environment: 'development', id: issue.id, name: 'shot.png', type: 'image/png', data: PNG.toString('base64') }) as { issue: { attachments: { id: string; name: string; size: number }[] } };
  return { id: issue.id, file: attached.issue.attachments[0]! };
}

test('someone in the reporter\'s team attaches a large screenshot in several parts', async () => {
  const { issues, settled } = fixture({ aiKey: null, teamEmails: () => ['tester@example.com', 'mate@example.com'] });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const mate = { ...base, readerUid: 'mate-uid', email: 'mate@example.com', team: 'Support' };
  const screenshot = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1_500_000, 7)]);
  await issues.reader(mate, { action: 'issues.attach', environment: 'development', id: issue.id, name: 'screenshot.png', type: 'image/png', data: screenshot.toString('base64') });
  const owner = issues.member('owner', null, 'Docs');
  const file = (await owner.list()).issues[0]!.attachments![0]!;
  assert.equal(file.parts, 3);
  assert.ok((await owner.attachment({ id: issue.id, attachment: file.id })).bytes.equals(screenshot));
});

test('everyone on an issue attaches and opens its files; a file alone answers a question', async () => {
  const { issues, settled } = fixture({ aiKey: null, teamEmails: body => (body as { reader_email: string }).reader_email === 'stranger@example.com' ? [] : ['tester@example.com', 'mate@example.com'] });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const upload = { id: issue.id, name: 'dev.png', type: 'image/png', data: png.toString('base64') };
  const mate = { ...base, readerUid: 'mate-uid', email: 'mate@example.com', displayName: 'Maya', team: 'Support' };
  const stranger = { ...base, readerUid: 'stranger-uid', email: 'stranger@example.com', team: 'Other' };
  const owner = issues.member('owner', null, 'Docs');
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  await owner.update({ id: issue.id, request: 'Which browser?' });

  // A developer attaches for a reporter who cannot.
  await assert.rejects(issues.member('other', null, 'Docs').attach(upload), /Only the assigned person/);
  const developer = await issues.member('dev', null, 'Docs').attach(upload);
  const file = developer.issue.attachments![0]!;
  assert.equal(file.by, 'dev@example.com');
  assert.equal(developer.issue.status, 'needs_info', 'A developer\'s file does not answer their own question.');

  // The reporter and their team open it; nobody else does.
  const open = { action: 'issues.attachment', environment: 'development', id: issue.id, attachment: file.id };
  for (const reader of [base, mate]) {
    const read = await issues.reader(reader, open) as { name: string; data: string };
    assert.equal(read.name, 'dev.png');
    assert.equal(read.data, png.toString('base64'));
  }
  await assert.rejects(issues.reader(stranger, open), /No such attachment/);
  await assert.rejects(issues.reader({ ...mate, environments: ['beta'] }, open), /No such attachment/);

  // A file with no text is a message of its own and answers the question.
  const reply = await issues.reader(base, { action: 'issues.attach', environment: 'development', ...upload, name: 'mine.png' }) as { issue: { status: string; attachments: { name: string; by: string }[]; history: { kind: string; text?: string; file?: string }[] } };
  assert.equal(reply.issue.status, 'open');
  assert.deepEqual(reply.issue.attachments.map(item => [item.name, item.by]), [['dev.png', 'dev@example.com'], ['mine.png', 'you']]);
  const event = reply.issue.history.at(-1)!;
  assert.equal(event.kind, 'attached');
  assert.equal(event.text, 'mine.png');
  assert.ok(event.file);
  const team = (await issues.reader(mate, { action: 'issues.list', environment: 'development' }) as { issues: { teamFiles: { name: string; by: string }[]; conversation: { kind: string; by: string }[] }[] }).issues[0]!;
  assert.deepEqual(team.teamFiles.map(item => [item.name, item.by]), [['dev.png', 'dev@example.com'], ['mine.png', 'Tess']]);
  // The fixture's workspace members share the display name Tess.
  assert.deepEqual(team.conversation.filter(item => item.kind === 'attached').map(item => item.by), ['Tess', 'Tess']);

  await owner.update({ id: issue.id, status: 'closed' });
  await assert.rejects(issues.member('dev', null, 'Docs').attach(upload), /Reopen the issue/);
});

test('the daily job deletes files two weeks after closing, unless the issue was reopened', async () => {
  let clock = Date.UTC(2026, 9, 23);
  const documents = new Map<string, { data: unknown; version: string }>();
  const parts = new Map<string, unknown>();
  let version = 0;
  const store: IssueStore = {
    async get(path) { return documents.get(path) ?? null; },
    async write(path, data, expected, changes) {
      if ((documents.get(path)?.version ?? null) !== expected) throw new DocumentationV3Error(409, 'race');
      documents.set(path, { data, version: 'v' + ++version });
      for (const part of changes?.set ?? []) parts.set(part.path, part.data);
      for (const part of changes?.remove ?? []) parts.delete(part);
    },
    async remove() {},
    async readPart(path) { return parts.get(path) ?? null; },
    async list() { return [...documents].map(([path, entry]) => ({ path, data: entry.data })); }
  };
  const owner = member('owner@example.com', 'owner');
  const issues = createIssues({ masterKey, store: () => store, now: () => clock, background: () => {}, generate: async () => null,
    async rpc(name) {
      if (name === 'mcp_v3_access') return owner;
      if (name === 'mcp_issue_ai_key' || name === 'mcp_issue_groq_key') return null;
      return [];
    } });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const raise = async (text: string) => {
    const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text }) as { issue: { id: string } };
    await issues.reader(base, { action: 'issues.attach', environment: 'development', id: issue.id, name: 'shot.png', type: 'image/png', data: png });
    return issue.id;
  };
  const closedId = await raise('This issue stays closed for two weeks.');
  const reopenedId = await raise('This issue is reopened before the cleanup.');
  const desk = issues.member('owner', null, 'Docs');
  await desk.update({ id: closedId, status: 'closed' });
  await desk.update({ id: reopenedId, status: 'closed' });
  await desk.update({ id: reopenedId, status: 'open' });
  const target = { projectId, firebaseProject: 'test-project', serviceAccountKey: 'test-only' };
  const find = async (id: string) => (await desk.list()).issues.find(item => item.id === id)!;

  clock += CLOSED_FILES_MS - 1000;
  assert.deepEqual(await issues.cleanClosedFiles(target), { issues: 0, files: 0, failed: 0 });
  assert.equal(parts.size, 2);
  // Closing again after a reopen starts the two weeks again.
  await desk.update({ id: reopenedId, status: 'closed' });

  clock += 2000;
  assert.deepEqual(await issues.cleanClosedFiles(target), { issues: 1, files: 1, failed: 0 });
  assert.deepEqual((await find(closedId)).attachments, []);
  assert.equal(parts.size, 1, 'The sealed file is gone from Firestore too.');
  assert.equal((await find(reopenedId)).attachments?.length, 1);
  assert.equal((await find(closedId)).history.at(-1)!.text, 'Deleted 1 attachment, two weeks after closing');
  assert.deepEqual((await issues.member('owner', null, 'Docs').notifications()).notifications.filter(note => note.event.by === 'Automatic cleanup'), []);
  assert.deepEqual(await issues.cleanClosedFiles(target), { issues: 0, files: 0, failed: 0 }, 'Nothing is left to do for that issue.');
});

test('only the configured secret runs the cleanup job', () => {
  assert.equal(cronAuthorized('Bearer right', 'right'), true);
  assert.equal(cronAuthorized('Bearer wrong', 'right'), false);
  assert.equal(cronAuthorized(undefined, 'right'), false);
  assert.equal(cronAuthorized('Bearer ', undefined), false);
  assert.equal(cronAuthorized('Bearer ', ''), false);
});

test('a reply sent as the wrong type changes between answer and question', async () => {
  const { issues, settled } = fixture({ aiKey: null });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'Saving a draft sometimes fails.' }) as { issue: { id: string } };
  await settled();
  const owner = issues.member('owner', null, 'Docs');
  const readerView = async () => (await issues.reader(base, { action: 'issues.list', environment: 'development' }) as { issues: { status: string; answers: unknown[]; history: { kind: string; text?: string }[] }[] }).issues[0]!;
  const answered = await owner.update({ id: issue.id, answer: 'Which browser?' });
  const answerId = answered.issue.answers[0]!.id;
  await assert.rejects(issues.member('other', null, 'Docs').update({ id: issue.id, answerToQuestion: answerId }), /Only the assigned person/);
  await assert.rejects(owner.update({ id: issue.id, answerToQuestion: 'missing' }), /No such answer/);

  const asked = await owner.update({ id: issue.id, answerToQuestion: answerId });
  assert.equal(asked.issue.status, 'needs_info');
  assert.deepEqual(asked.issue.answers, []);
  assert.equal(asked.issue.answer, null);
  const question = asked.issue.history.find(event => event.kind === 'info_requested')!;
  assert.equal(question.text, 'Which browser?');
  assert.ok(!asked.issue.history.some(event => event.kind === 'answered'));
  let shown = await readerView();
  assert.deepEqual(shown.answers, []);
  assert.deepEqual(shown.history.filter(event => event.text).map(event => event.kind), ['info_requested'], 'The website shows only the corrected reply.');

  await assert.rejects(owner.update({ id: issue.id, questionToAnswer: '2020-01-01T00:00:00.000Z' }), /No such question/);
  const back = await owner.update({ id: issue.id, questionToAnswer: question.at });
  assert.equal(back.issue.status, 'answered');
  assert.equal(back.issue.answers[0]!.text, 'Which browser?');
  assert.ok(!back.issue.history.some(event => event.kind === 'info_requested'));
  shown = await readerView();
  assert.equal(shown.answers.length, 1);

  await owner.update({ id: issue.id, status: 'closed' });
  await assert.rejects(owner.update({ id: issue.id, answerToQuestion: back.issue.answers[0]!.id }), /Reopen the issue/);
});

test('reporters attach files; only the people answering read them, sealed in parts', async () => {
  const { issues, parts, settled } = fixture({ aiKey: null });
  const { id, file } = await reportWithFile(issues);
  await settled();
  assert.equal(file.name, 'shot.png');
  assert.equal(file.size, PNG.length);
  assert.equal(parts.size, 2, 'A 700 KB file is stored in two parts.');
  assert.ok(![...parts.values()].some(part => JSON.stringify(part).includes(PNG.subarray(8, 64).toString('base64'))), 'Parts are sealed.');

  const owner = issues.member('owner', null, 'Docs');
  const dev = issues.member('dev', null, 'Docs');
  const other = issues.member('other', null, 'Docs');
  await assert.rejects(dev.attachment({ id, attachment: file.id }), /No such attachment/);
  const read = await owner.attachment({ id, attachment: file.id });
  assert.ok(read.bytes.equals(PNG));
  assert.equal(read.type, 'image/png');

  await owner.update({ id, assignee: 'dev@example.com' });
  assert.ok((await dev.attachment({ id, attachment: file.id })).bytes.equals(PNG));
  await assert.rejects(other.attachment({ id, attachment: file.id }), /No such attachment/);
  const listed = (await dev.list({ status: 'all', assigned: 'me' })).issues[0]!;
  assert.equal(listed.attachments?.[0]?.name, 'shot.png');
  assert.ok(!JSON.stringify(listed).includes(PNG.subarray(8, 64).toString('base64')), 'Lists carry names, not files.');

  // Other readers of the answered issue never see that it has files, and cannot add to it.
  await dev.update({ id, answer: 'Untick "Hide archived" first.' });
  const someone = { ...base, readerUid: 'someone-else', email: 'po@example.com' };
  const seen = (await issues.reader(someone, { action: 'issues.list', environment: 'development' }) as { issues: Record<string, unknown>[] }).issues[0]!;
  assert.equal(seen.attachments, undefined);
  await assert.rejects(issues.reader(someone, { action: 'issues.attach', environment: 'development', id, name: 'x.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }), /No such issue/);
});

test('closing keeps files until the cleanup, reopening keeps them too, and deleting an issue deletes them at once', async () => {
  const { issues, parts, settled } = fixture({ aiKey: null });
  const { id, file } = await reportWithFile(issues);
  await settled();
  const owner = issues.member('owner', null, 'Docs');
  const size = parts.size;
  const closed = await owner.update({ id, status: 'closed' });
  assert.equal(parts.size, size);
  assert.equal(closed.issue.attachments?.length, 1, 'Files stay for two weeks after closing.');
  assert.ok((await owner.attachment({ id, attachment: file.id })).bytes.length > 0, 'They can still be read while closed.');
  await assert.rejects(issues.reader(base, { action: 'issues.attach', environment: 'development', id, name: 'x.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }), /closed/);
  const reopened = await owner.update({ id, status: 'open' });
  assert.equal(reopened.issue.attachments?.length, 1);
  assert.equal(parts.size, size);
  await owner.remove({ id });
  assert.equal(parts.size, 0);

  const second = await reportWithFile(issues);
  await settled();
  assert.ok(parts.size > 0);
  await owner.remove({ id: second.id });
  assert.equal(parts.size, 0);
});

test('only real images and readable text within the limits are accepted', async () => {
  const { issues, settled } = fixture({ aiKey: null });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const attach = (name: string, type: string, data: Buffer | string) => issues.reader(base, { action: 'issues.attach', environment: 'development', id: issue.id, name, type,
    data: typeof data === 'string' ? data : data.toString('base64') });
  await assert.rejects(attach('fake.png', 'image/png', Buffer.from('<script>alert(1)</script>')), /does not match/);
  await assert.rejects(attach('bad.json', 'application/json', Buffer.from('{not json')), /does not match/);
  await assert.rejects(attach('binary.txt', 'text/plain', Buffer.from([0, 1, 2, 0xff])), /does not match/);
  await assert.rejects(attach('page.html', 'text/html', Buffer.from('<html>')));
  await assert.rejects(attach('huge.txt', 'text/plain', Buffer.alloc(2 * 1024 * 1024 + 1, 97)));
  await assert.rejects(attach('junk.txt', 'text/plain', 'not base64 !!!'));
  const named = await attach('../../etc/pass\nwd.json', 'application/json', Buffer.from('{"ok":true}')) as { issue: { attachments: { name: string }[] } };
  assert.equal(named.issue.attachments[0]!.name, '.._.._etc_pass_wd.json');
  for (let count = 1; count < 5; count++) await attach('note' + count + '.txt', 'text/plain', Buffer.from('hello'));
  await assert.rejects(attach('sixth.txt', 'text/plain', Buffer.from('hello')), /at most 5/);
});

test('a real store commits files with the issue and keeps them out of the cache path', async () => {
  const commits: { writes: { update?: { name: string }; delete?: string }[] }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.includes('oauth2') || address.includes('/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
    if (address.endsWith(':commit')) {
      commits.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ writeResults: [] }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const store = createIssueStore({ firebaseProject: 'test-project', serviceAccountKey: JSON.stringify({ type: 'service_account', project_id: 'test-project', private_key_id: 'id', private_key: key, client_email: 'a@test-project.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' }) }, fetcher);
  const sealed = { format: '3', projectId, kind: 'issue', updatedAt: '2026-11-05T00:00:00.000Z', sealed: 'x' } as const;
  const part = { format: '3', projectId, kind: 'issue-attachment', sealed: 'y' } as const;
  await store.write('documentationV3Issues/p/issues/i', sealed, 'v1', { set: [{ path: 'documentationV3Issues/p/issues/i/attachmentParts/a.0', data: part }], remove: ['documentationV3Issues/p/issues/i/attachmentParts/b.0'] });
  assert.equal(commits.length, 1, 'One atomic commit.');
  assert.equal(commits[0]!.writes.length, 3);
  assert.match(commits[0]!.writes[0]!.update!.name, /issues\/i$/);
  assert.match(commits[0]!.writes[1]!.update!.name, /attachmentParts\/a\.0$/);
  assert.match(commits[0]!.writes[2]!.delete!, /attachmentParts\/b\.0$/);
  assert.equal(await store.readPart('documentationV3Issues/p/issues/i/attachmentParts/missing.0'), null);
});

test('an issue holds several answers, each edited or deleted on its own, and a deleted answer leaves no copy', async () => {
  const { issues, settled } = fixture({ aiKey: null });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const owner = issues.member('owner', null, 'Docs');
  const other = issues.member('other', null, 'Docs');
  const first = await owner.update({ id: issue.id, answer: 'First answer.' });
  const second = await owner.update({ id: issue.id, answer: 'Second answer.' });
  assert.deepEqual(second.issue.answers.map(item => item.text), ['First answer.', 'Second answer.']);
  assert.equal(second.issue.answer?.text, 'Second answer.', 'Websites showing one answer get the newest.');
  const firstId = first.issue.answers[0]!.id, secondId = second.issue.answers[1]!.id;

  await assert.rejects(other.update({ id: issue.id, answerEdit: { id: firstId, text: 'Mine' } }), /edit answers/);
  await assert.rejects(other.update({ id: issue.id, answerDelete: firstId }), /delete answers/);
  await assert.rejects(owner.update({ id: issue.id, answerDelete: 'missing' }), /No such answer/);

  const edited = await owner.update({ id: issue.id, answerEdit: { id: firstId, text: 'Corrected answer.' } });
  assert.equal(edited.issue.answers[0]!.text, 'Corrected answer.');
  assert.ok(edited.issue.answers[0]!.editedAt);
  assert.equal(edited.issue.answer?.text, 'Second answer.');
  assert.ok(!JSON.stringify(edited.issue.history).includes('First answer.'), 'The old wording is gone from the history.');

  const removed = await owner.update({ id: issue.id, answerDelete: secondId });
  assert.deepEqual(removed.issue.answers.map(item => item.text), ['Corrected answer.']);
  assert.equal(removed.issue.answer?.text, 'Corrected answer.');
  assert.equal(removed.issue.status, 'answered');
  assert.ok(!JSON.stringify(removed.issue).includes('Second answer.'), 'A deleted answer leaves no copy.');

  const seen = (await issues.reader(base, { action: 'issues.list', environment: 'development' }) as { issues: { answers: { text: string }[]; history: { kind: string }[] }[] }).issues[0]!;
  assert.deepEqual(seen.answers.map(item => item.text), ['Corrected answer.']);
  assert.ok(!seen.history.some(event => event.kind.startsWith('answer_')), 'The website does not show answer housekeeping.');

  const none = await owner.update({ id: issue.id, answerDelete: firstId });
  assert.equal(none.issue.status, 'open', 'With no answer left the issue is waiting again.');
  assert.equal(none.issue.answer, null);
  assert.deepEqual(none.issue.answers, []);
});

test('many long answers still read back, up to the limit', async () => {
  const { issues, settled } = fixture({ aiKey: null });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const owner = issues.member('owner', null, 'Docs');
  for (let count = 0; count < 20; count++) await owner.update({ id: issue.id, answer: String(count).padEnd(8000, 'x') });
  assert.equal((await owner.list({ status: 'all' })).issues[0]!.answers.length, 20);
  await assert.rejects(owner.update({ id: issue.id, answer: 'One too many' }), /at most 20/);
});

test('people in the same team reply to each other\'s issues and attach files; others cannot', async () => {
  const { issues, settled } = fixture({ aiKey: null, teamEmails: body => (body as { reader_email: string }).reader_email === 'stranger@example.com' ? [] : ['tester@example.com', 'mate@example.com'] });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const mate = { ...base, readerUid: 'mate-uid', email: 'Mate@example.com', displayName: 'Maya', team: 'Support' };
  const stranger = { ...base, readerUid: 'stranger-uid', email: 'stranger@example.com', team: 'Other' };
  const reply = { action: 'issues.reply', environment: 'development', id: issue.id };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const attach = { action: 'issues.attach', environment: 'development', id: issue.id, name: 'mate.png', type: 'image/png', data: png };
  const owner = issues.member('owner', null, 'Docs');
  await owner.update({ id: issue.id, request: 'Which browser?' });

  await assert.rejects(issues.reader(stranger, { ...reply, text: 'Not my team' }), /No such issue/);
  await assert.rejects(issues.reader(stranger, attach), /No such issue/);
  await assert.rejects(issues.reader({ ...mate, team: null }, { ...reply, text: 'No team now' }), /No such issue/);
  await assert.rejects(issues.reader({ ...mate, environments: ['beta'] }, { ...reply, text: 'Wrong environment' }), /No such issue/);

  const replied = await issues.reader(mate, { ...reply, text: 'It happens in Safari.' }) as { issue: Record<string, unknown> };
  assert.equal(replied.issue.status, 'open', 'The team gave the information that was asked for.');
  assert.equal(replied.issue.canReply, true);
  assert.equal(replied.issue.original, undefined);
  assert.deepEqual((replied.issue.conversation as { kind: string; by: string; text: string }[]).map(({ kind, by, text }) => ({ kind, by, text })), [
    { kind: 'info_requested', by: 'owner@example.com', text: 'Which browser?' }, { kind: 'replied', by: 'you', text: 'It happens in Safari.' }]);
  assert.deepEqual(replied.issue.history, [], 'The team hears about answers only.');

  const attached = await issues.reader(mate, attach) as { issue: Record<string, unknown> };
  assert.deepEqual((attached.issue.teamFiles as { name: string; by: string }[]).map(item => [item.name, item.by]), [['mate.png', 'you']]);
  assert.equal(attached.issue.attachments, undefined);

  const reporter = (await issues.reader(base, { action: 'issues.list', environment: 'development' }) as { issues: { attachments: { name: string }[]; history: { kind: string; by: string; name?: string }[] }[] }).issues[0]!;
  assert.deepEqual(reporter.attachments.map(file => file.name), ['mate.png']);
  const event = reporter.history.find(item => item.kind === 'replied')!;
  assert.equal(event.by, 'Maya');
  assert.equal(event.name, undefined);
  const stored = (await owner.list()).issues[0]!;
  assert.equal(stored.attachments?.[0]?.by, 'mate@example.com');
  const seen = stored.history.find(item => item.kind === 'replied')!;
  assert.deepEqual([seen.by, seen.name], ['mate@example.com', 'Maya']);

  await owner.update({ id: issue.id, status: 'closed' });
  await assert.rejects(issues.reader(mate, { ...reply, text: 'Too late' }), /closed/);
});

test('people in the same team see each other\'s open issues on the website, without private details', async () => {
  const seenCalls: unknown[] = [];
  const { issues, settled } = fixture({ aiKey: null, teamEmails: body => { seenCalls.push(body); return ['tester@example.com', 'mate@example.com']; } });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const mate = { ...base, readerUid: 'mate-uid', email: 'mate@example.com', team: 'Support' };
  const stranger = { ...base, readerUid: 'stranger-uid', email: 'stranger@example.com', team: null };
  const list = async (reader: typeof base) => (await issues.reader(reader, { action: 'issues.list', environment: 'development' }) as { issues: Record<string, unknown>[] }).issues;

  const shown = (await list(mate))[0]!;
  assert.equal(shown.team, true);
  assert.equal(shown.mine, false);
  assert.equal(shown.title, 'The export button downloads an empty file');
  assert.equal(shown.original, undefined, 'The reporter\'s original words stay private.');
  assert.deepEqual(shown.history, [], 'Nothing to hear about until it is answered.');
  assert.equal(shown.attachments, undefined);
  assert.equal(seenCalls.length, 1);
  assert.deepEqual(await list(stranger), [], 'No team, no shared issues.');
  await assert.rejects(issues.reader(stranger, { action: 'issues.reply', environment: 'development', id: issue.id, text: 'Not in the team' }), /No such issue/);
  await assert.rejects(issues.reader({ ...mate, environments: ['beta'] }, { action: 'issues.list', environment: 'development' }), /Environment access denied/);

  await issues.member('owner', null, 'Docs').update({ id: issue.id, status: 'closed' });
  assert.deepEqual(await list(mate), [], 'Closed issues leave the team list.');
});

test('when an issue is answered, the reporter\'s whole team is notified, but not of anything else', async () => {
  const { issues, settled } = fixture({ aiKey: null, teamEmails: () => ['tester@example.com', 'mate@example.com', 'dev@example.com'],
    people: [{ email: 'owner@example.com', name: 'Olive Owner' }, { email: 'dev@example.com', name: 'Dev Person' }] });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const owner = issues.member('owner', null, 'Docs');
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  await owner.update({ id: issue.id, request: 'Which filters were on?' });
  const historyOf = async (reader: typeof base) => (await issues.reader(reader, { action: 'issues.list', environment: 'development' }) as { issues: { history: { kind: string; by: string; text?: string }[] }[] }).issues[0]!.history;
  const mate = { ...base, readerUid: 'mate-uid', email: 'mate@example.com', team: 'Support' };
  assert.deepEqual(await historyOf(mate), [], 'Assignments and questions stay with the reporter.');

  await issues.member('dev', null, 'Docs').update({ id: issue.id, answer: 'Untick "Hide archived" first.' });
  const heard = await historyOf(mate);
  assert.deepEqual(heard.map(event => [event.kind, event.by]), [['answered', 'Dev Person']]);
  assert.equal(heard[0]!.text, undefined);

  // Someone in the team who answered it themselves hears nothing about their own answer.
  assert.deepEqual(await historyOf({ ...base, readerUid: 'dev-uid', email: 'dev@example.com', team: 'Support' }), []);
});

test('without the team migration readers still see their own issues', async () => {
  const { issues, settled } = fixture({ aiKey: null, teamEmails: () => { throw new Error('function does not exist'); } });
  await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' });
  await settled();
  const mine = await issues.reader({ ...base, team: 'Support' }, { action: 'issues.list', environment: 'development' }) as { issues: unknown[] };
  assert.equal(mine.issues.length, 1);
});

test('the website shows names instead of emails, and an email only for someone without a name', async () => {
  const { issues, settled } = fixture({ aiKey: null, people: [{ email: 'owner@example.com', name: 'Olive Owner' }, { email: 'dev@example.com', name: 'Dev Person' }, { email: 'other@example.com', name: null }] });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The export button downloads an empty file.' }) as { issue: { id: string } };
  await settled();
  const owner = issues.member('owner', null, 'Docs');
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  await issues.member('dev', null, 'Docs').update({ id: issue.id, answer: 'Untick "Hide archived" first.' });
  const seen = (await issues.reader(base, { action: 'issues.list', environment: 'development' }) as { issues: { assignee: string; answer: { by: string }; answers: { by: string }[]; history: { kind: string; by: string; to?: string }[] }[] }).issues[0]!;
  assert.equal(seen.assignee, 'Dev Person');
  assert.equal(seen.answer.by, 'Dev Person');
  assert.equal(seen.answers[0]!.by, 'Dev Person');
  const assigned = seen.history.find(event => event.kind === 'assigned')!;
  assert.equal(assigned.by, 'Olive Owner');
  assert.equal(assigned.to, 'Dev Person');
  assert.equal(seen.history[0]!.by, 'you');
  assert.ok(!JSON.stringify(seen).includes('dev@example.com'), 'Named people\'s emails are not sent to readers.');

  await owner.update({ id: issue.id, assignee: 'other@example.com' });
  const unnamed = (await issues.reader(base, { action: 'issues.list', environment: 'development' }) as { issues: { assignee: string }[] }).issues[0]!;
  assert.equal(unnamed.assignee, 'other@example.com', 'Someone without a name still shows who it is.');
});

test('owners and admins delete issues; nobody else can', async () => {
  const { issues, documents } = fixture();
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'Spam spam spam spam spam.' }) as { issue: { id: string } };
  await assert.rejects(issues.member('dev', null, 'Docs').remove({ id: issue.id }), /owners and admins delete/);
  assert.deepEqual(await issues.member('owner', null, 'Docs').remove({ id: issue.id }), { deleted: issue.id });
  assert.equal(documents.size, 0);
  await assert.rejects(issues.member('owner', null, 'Docs').remove({ id: issue.id }), /No such issue/);
});

test('polish rewords a draft from the issue and its conversation without saving or sending anything', async () => {
  const seen: PolishRequest[] = [];
  const { issues, documents } = fixture({ polish: async (key, request) => { assert.equal(key, 'gemini-test-key-000000000000'); seen.push(request); return 'Which browser are you using?'; } });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'Saving a draft sometimes fails.',
    page: { route: '#/drafts', title: 'Drafts', excerpt: 'Drafts save automatically.' } }) as { issue: { id: string } };
  const owner = issues.member('owner', null, 'Docs');
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  await owner.update({ id: issue.id, request: 'Does it fail every time?' });
  await issues.reader(base, { action: 'issues.reply', id: issue.id, text: 'Only on the beta site.' });
  const before = JSON.stringify([...documents]);

  const dev = issues.member('dev', null, 'Docs');
  assert.deepEqual(await dev.polish({ id: issue.id, text: '  which browser  ' }), { text: 'Which browser are you using?' });
  assert.equal(JSON.stringify([...documents]), before);
  assert.equal(seen[0]!.draft, 'which browser');
  assert.equal(seen[0]!.issue.page?.title, 'Drafts');
  assert.deepEqual(seen[0]!.conversation, [
    { from: 'team', kind: 'question', text: 'Does it fail every time?' },
    { from: 'reporter', kind: 'reply', text: 'Only on the beta site.' }]);
});

test('polish is only for the people who answer the issue', async () => {
  const { issues } = fixture({ polish: async () => 'Polished.' });
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'Saving a draft sometimes fails.' }) as { issue: { id: string } };
  await assert.rejects(issues.member('other', null, 'Docs').polish({ id: issue.id, text: 'Draft' }), /Only the assigned person/);
  await assert.rejects(issues.member('owner', null, 'Docs').polish({ id: issue.id, text: '   ' }));
  await assert.rejects(issues.member('owner', null, 'Docs').polish({ id: '44444444-4444-4444-8444-444444444444', text: 'Draft' }), /No such issue/);
  assert.deepEqual(await issues.member('owner', null, 'Docs').polish({ id: issue.id, text: 'Draft' }), { text: 'Polished.' });
});

test('polish falls back to Groq, and says so when no AI can help', async () => {
  const report = { action: 'issues.create', environment: 'development', type: 'issue', text: 'Saving a draft sometimes fails.' };
  const groq = fixture({ groqKey: 'groq-key', polish: async () => null, polishFallback: async key => key + ' polished' });
  const first = await groq.issues.reader(base, report) as { issue: { id: string } };
  assert.deepEqual(await groq.issues.member('owner', null, 'Docs').polish({ id: first.issue.id, text: 'Draft' }), { text: 'groq-key polished' });

  const groqOnly = fixture({ aiKey: null, groqKey: 'groq-key', polish: async () => { throw new Error('Gemini has no key'); }, polishFallback: async () => 'From Groq' });
  const second = await groqOnly.issues.reader(base, report) as { issue: { id: string } };
  assert.deepEqual(await groqOnly.issues.member('owner', null, 'Docs').polish({ id: second.issue.id, text: 'Draft' }), { text: 'From Groq' });

  const failing = fixture({ polish: async () => null });
  const third = await failing.issues.reader(base, report) as { issue: { id: string } };
  await assert.rejects(failing.issues.member('owner', null, 'Docs').polish({ id: third.issue.id, text: 'Draft' }), /could not polish this reply right now\. Your text is unchanged/);

  const noKeys = fixture({ aiKey: null });
  const fourth = await noKeys.issues.reader(base, report) as { issue: { id: string } };
  await assert.rejects(noKeys.issues.member('owner', null, 'Docs').polish({ id: fourth.issue.id, text: 'Draft' }), /needs a Gemini or Groq key/);
});

test('the polish providers send the draft as data and accept only a usable reply', async () => {
  const request: PolishRequest = { issue: { type: 'issue', title: 'T', description: 'D', reporterWords: null, page: null }, conversation: [], draft: 'which browser' };
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  const reply = (body: unknown, status = 200): typeof fetch => async (url, init) => {
    sent.push({ url: String(url), body: String(init?.body), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  };
  const gemini = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
  assert.equal(await geminiPolisher(reply(gemini('{"text":" Which browser? "}')))('key', request), 'Which browser?');
  assert.equal(sent[0]!.headers['x-goog-api-key'], 'key');
  assert.ok(!sent[0]!.url.includes('key='));
  assert.equal(JSON.parse(sent[0]!.body).contents[0].parts[0].text, JSON.stringify(request));
  assert.match(JSON.parse(sent[0]!.body).systemInstruction.parts[0].text, /never turn a question into an answer/);
  assert.equal(await geminiPolisher(reply(gemini('not json')))('key', request), null);
  assert.equal(await geminiPolisher(reply(gemini(JSON.stringify({ text: 'x'.repeat(8001) }))))('key', request), null);
  assert.equal(await geminiPolisher(reply({ error: { message: 'busy' } }, 503))('key', request), null);
  assert.equal(await groqPolisher(reply({ choices: [{ message: { content: '{"text":"Which browser?"}' } }] }))('key', request), 'Which browser?');
  assert.equal(await groqPolisher(reply({}, 500))('key', request), null);
});

test('history records every action; developers ask for more information and the reporter replies on the website', async () => {
  const { issues } = fixture();
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'Saving a draft sometimes fails.' }) as { issue: { id: string } };
  const owner = issues.member('owner', null, 'Docs');
  const dev = issues.member('dev', null, 'Docs');
  const other = issues.member('other', null, 'Docs');
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });

  await assert.rejects(other.update({ id: issue.id, request: 'Which browser?' }), /ask for more information/);
  await assert.rejects(dev.update({ id: issue.id, request: 'Which browser?', answer: 'Both' }), /not both/);
  const asked = await dev.update({ id: issue.id, request: 'Which browser, and what does the error say?' });
  assert.equal(asked.issue.status, 'needs_info');
  assert.equal((await dev.list({ status: 'needs_info' })).issues.length, 1);
  assert.equal((await dev.list({ status: 'unanswered' })).issues.length, 0);

  const stranger = { ...base, readerUid: 'someone-else' };
  await assert.rejects(issues.reader(stranger, { action: 'issues.reply', environment: 'development', id: issue.id, text: 'Not mine' }), /No such issue/);
  const replied = await issues.reader(base, { action: 'issues.reply', environment: 'development', id: issue.id, text: 'Safari 18. It says "Network error".' }) as
    { issue: { status: string; history: { kind: string; by: string }[] } };
  assert.equal(replied.issue.status, 'open');
  assert.deepEqual(replied.issue.history.map(event => event.kind + ':' + event.by),
    ['created:you', 'assigned:owner@example.com', 'info_requested:dev@example.com', 'replied:you']);

  await dev.update({ id: issue.id, answer: 'Fixed in 4.3.1: Safari now retries the save.' });
  await dev.update({ id: issue.id, status: 'closed' });
  await assert.rejects(issues.reader(base, { action: 'issues.reply', environment: 'development', id: issue.id, text: 'Still broken' }), /closed/);
  await assert.rejects(dev.update({ id: issue.id, request: 'More?' }), /Reopen/);
  const reopened = await dev.update({ id: issue.id, status: 'open' });
  assert.equal(reopened.issue.status, 'answered');
  assert.deepEqual(reopened.issue.history.map(event => event.kind),
    ['created', 'assigned', 'info_requested', 'replied', 'answered', 'closed', 'reopened']);
  assert.equal(reopened.issue.history[2]!.text, 'Which browser, and what does the error say?');

  // Other readers never see someone else's history.
  const seen = await issues.reader(stranger, { action: 'issues.list', environment: 'development' }) as { issues: Record<string, unknown>[] };
  assert.equal(seen.issues[0]!.history, undefined);
});

test('developers are notified of new issues, assignments and the reporter\'s replies, never of their own actions', async () => {
  const { issues } = fixture();
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'Search returns nothing for accented names.' }) as { issue: { id: string } };
  const owner = issues.member('owner', null, 'Docs');
  const dev = issues.member('dev', null, 'Docs');
  const kinds = async (desk: typeof dev) => (await desk.notifications()).notifications.map(note => note.event.kind + ':' + note.event.by);

  assert.deepEqual(await kinds(owner), ['created:Tess']);
  assert.deepEqual(await kinds(dev), []);
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  assert.deepEqual(await kinds(dev), ['assigned:owner@example.com']);
  await dev.update({ id: issue.id, request: 'Which name did you search for?' });
  await issues.reader(base, { action: 'issues.reply', environment: 'development', id: issue.id, text: 'José' });
  assert.deepEqual(await kinds(dev), ['replied:Tess', 'assigned:owner@example.com']);
  // Once assigned, the reply goes to the assignee, not to every admin.
  assert.deepEqual(await kinds(owner), ['created:Tess']);
  const [reply] = (await dev.notifications()).notifications;
  assert.equal(reply!.issue.id, issue.id);
  assert.equal(reply!.event.text, 'José');
});

test('changes read the cached issue and go back to Firestore only when the cached copy is stale', async () => {
  const { issues, documents, settled } = fixture();
  const { issue } = await issues.reader(base, { action: 'issues.create', environment: 'development', type: 'issue', text: 'The date picker shows the wrong month.' }) as { issue: { id: string } };
  await settled();
  const path = [...documents.keys()][0]!;
  const stale = documents.get(path)!;
  const reads: string[] = [];
  const cached = createIssues({
    masterKey, now: () => Date.UTC(2026, 9, 24),
    store: () => ({
      async readPart() { return null; },
      async get(at, options) {
        reads.push(options?.fresh ? 'firestore' : 'redis');
        return options?.fresh ? documents.get(at) ?? null : stale;
      },
      async write(at, data, version) {
        if (documents.get(at)!.version !== version) throw new DocumentationV3Error(409, 'race');
        documents.set(at, { data, version: version + '+' });
      },
      async remove() { throw new Error('Not used'); },
      async list() { return [...documents].map(([at, entry]) => ({ path: at, data: entry.data })); }
    }),
    async rpc(name) {
      if (name === 'mcp_v3_access') return member('owner@example.com', 'owner');
      if (name === 'mcp_issue_assignees') return ['dev@example.com'];
      return null;
    }
  });
  const owner = cached.member('owner', null, 'Docs');
  await owner.update({ id: issue.id, assignee: 'dev@example.com' });
  assert.deepEqual(reads, ['redis']);
  // Someone else's save made the cached copy stale: the write is refused and Firestore is read once.
  await owner.update({ id: issue.id, request: 'Which month did you pick?' });
  assert.deepEqual(reads, ['redis', 'redis', 'firestore']);
  assert.equal((await owner.list()).issues[0]!.status, 'needs_info');
});
