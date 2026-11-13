import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOrbit, orbitPages } from '../src/orbit.js';
import { createDocumentationV3, type V3Access } from '../src/documentation-v3.js';
import type { V3Store } from '../src/documentation-v3.js';
import { createManagedDocumentation } from '../src/managed-documentation.js';
import { createCiphertextCache } from '../src/ciphertext-cache.js';
import type { RecordData } from '../src/v3-client.js';
import { DocumentationV3Error } from '../src/documentation-v3.js';
import type { OrbitAttempt } from '../src/orbit-usage.js';

const releaseId = '22222222-2222-4222-8222-222222222222';
const access: V3Access = {
  projectId: '11111111-1111-4111-8111-111111111111', userId: null, name: 'Northstar', role: 'none',
  email: 'reader@example.invalid', readerUid: 'reader-one', reader: 'product-owners', administrator: false,
  environments: ['production'], firebaseProject: 'test-project', serviceAccountKey: 'test-only'
};
const input = { environment: 'production' as const, releaseId, question: 'Where are approval rules?' };
function fixture() {
  const foundation = {
    key: 'foundation', page: 'foundation', collection: '', title: 'Northstar',
    data: { schemaVersion: 2, meta: { appName: 'Northstar', subtitle: 'Guides', createdBy: 'Editor', updatedBy: 'Editor', updated: '2026-11-02' },
      startPage: 'guides', sections: [
        { id: 'guides', collection: 'articles', layout: 'list', sort: { field: 'title', direction: 'asc' },
          fields: [{ key: 'summary', label: 'Summary', type: 'text' }, { key: 'hidden', label: 'Hidden', type: 'text', visible: false }] },
        { id: 'engineering', collection: 'internal-docs', layout: 'list', sort: { field: 'title', direction: 'asc' } }
      ],
      navigation: {
        tabs: [
          { id: 'guides', label: 'Product guides', overviewLabel: 'Overview', icon: 'book', href: '#/', order: 0, visible: true },
          { id: 'engineering', label: 'Engineering', overviewLabel: 'Overview', icon: 'book', href: '#/engineering', order: 1, visible: true, audiences: ['developers'] }
        ],
        groups: [{ id: 'requests', tab: 'guides', label: 'Requests', icon: 'book', order: 0, visible: true }],
        entries: [
          { id: 'approval', tab: 'guides', group: 'requests', key: 'guides/approval', label: 'Approval rules', href: '#/guides/approval', order: 0, visible: true, searchable: true },
          { id: 'draft', tab: 'guides', group: 'requests', key: 'guides/draft', label: 'HIDDEN_ARTICLE', href: '#/guides/draft', order: 1, visible: false, searchable: true },
          { id: 'nosearch', tab: 'guides', group: 'requests', key: 'guides/nosearch', label: 'UNSEARCHABLE_ARTICLE', href: '#/guides/nosearch', order: 2, visible: true, searchable: false },
          { id: 'deploy', tab: 'engineering', group: '', key: 'engineering/deploy', label: 'DEVELOPER_ARTICLE', href: '#/engineering/deploy', order: 0, visible: true, searchable: true }
        ]
      }
    }
  };
  const article = (key: string, title: string) => ({
    key, page: key.split('/')[0]!, collection: key.startsWith('engineering/') ? 'internal-docs' : 'articles', title,
    data: { schemaVersion: 2, id: key.split('/')[1]!, value: { summary: 'Approvers review pending requests.', hidden: 'HIDDEN_FIELD' },
      blocks: [
        { id: 'owners', type: 'paragraph', text: 'Product owners can review approval conditions.', audiences: ['product-owners'] },
        { id: 'developers', type: 'paragraph', text: 'DEVELOPER_BLOCK', audiences: ['developers'] }
      ] }
  });
  const records: RecordData[] = [foundation, article('guides/approval', 'Approval rules'), article('guides/draft', 'HIDDEN_ARTICLE'),
    article('guides/nosearch', 'UNSEARCHABLE_ARTICLE'), article('engineering/deploy', 'DEVELOPER_ARTICLE')];
  return { foundation, records };
}
function gemini(value: unknown): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
}
function harness(responses: unknown[] = [{ references: [0] }, { answer: 'Open Approval rules for approver roles and conditions.', references: [0] }]) {
  const calls: { url: string; options: RequestInit; payload: string }[] = [];
  let reads = 0;
  const service = createOrbit({
    aiKey: async identity => { assert.equal(identity.projectId, access.projectId); return 'workspace-key'; },
    read: async (identity, environment) => {
      assert.equal(identity.readerUid, access.readerUid); assert.equal(environment, 'production'); reads++;
      return { records: fixture().records, head: { releaseId } };
    },
    fetchGemini: async (url, options) => {
      calls.push({ url: String(url), options: options!, payload: String(options!.body) });
      return gemini(responses.shift());
    }
  });
  return { service, calls, reads: () => reads };
}

test('Orbit uses shared navigation and audience-aware search, never hidden content', () => {
  const { records, foundation } = fixture();
  const pages = orbitPages(records, 'product-owners');
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]?.path, ['Northstar', 'Product guides', 'Requests', 'Approval rules']);
  assert.match(pages[0]!.text, /approval conditions/);
  assert.doesNotMatch(JSON.stringify(pages), /HIDDEN_|UNSEARCHABLE_|DEVELOPER_/);
  assert.equal(orbitPages(records, null).length, 2, 'Administrators can discover their engineering tab.');
  foundation.data.navigation.groups[0]!.visible = false;
  assert.equal(orbitPages(records, 'product-owners').length, 0, 'Hidden groups cannot surface through Orbit.');
});

test('Orbit uses the workspace key only in headers and builds links from published data', async () => {
  const h = harness();
  const answer = await h.service(access, input);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(answer.sources, [{ key: 'guides/approval', title: 'Approval rules', href: '#/guides/approval',
    path: ['Northstar', 'Product guides', 'Requests', 'Approval rules'] }]);
  assert.equal(answer.environment, 'production'); assert.equal(answer.releaseId, releaseId);
  for (const call of h.calls) {
    assert.match(call.url, /gemini-3\.5-flash:generateContent$/);
    assert.deepEqual(call.options.headers, { 'x-goog-api-key': 'workspace-key', 'Content-Type': 'application/json' });
    assert.doesNotMatch(call.payload, /workspace-key|HIDDEN_|UNSEARCHABLE_|DEVELOPER_|test-only|reader@example/);
  }
});

test('Orbit reads the actual encrypted published snapshot without client-supplied article content or writes', async () => {
  const saved = new Map<string, Record<string, unknown>>();
  let writes = 0;
  const store: V3Store = {
    async get(path) { const data = saved.get(path); return data ? { data } : null; },
    async getMany(paths) { return Promise.all(paths.map(path => store.get(path))); },
    async immutable(path, data) { writes++; saved.set(path, data); },
    async publish({ releaseId, release }) {
      writes++;
      saved.set('documentationV3Releases/' + releaseId, release);
      saved.set('documentationV3Environments/' + release.scope.environment,
        { format: 3, generation: 1, releaseId, keyId: release.scope.keyId });
      return 1;
    }
  };
  const managed = { store, masterKey: Buffer.alloc(32, 71).toString('base64url'), cache: createCiphertextCache(),
    releaseCacheSigningKey: 'orbit-test-signing-key' };
  const published = await createManagedDocumentation({ ...access, role: 'owner' }, managed).publish('production', {
    records: fixture().records, expected: 'empty',
    metadata: { version: '1.0.0', tags: ['Changed'], summary: 'Approval guide', operation: 'apply' }
  });
  assert.doesNotMatch(JSON.stringify([...saved]), /Approvers review pending requests/);
  const before = writes;
  const responses = [{ references: [0] }, { references: [0], answer: 'Open Approval rules for the approval conditions.' }];
  const orbit = createOrbit({ managed, aiKey: async () => 'workspace-key', fetchGemini: async () => gemini(responses.shift()) });
  const answer = await orbit(access, { ...input, releaseId: published.releaseId });
  assert.equal(answer.sources[0]?.href, '#/guides/approval');
  assert.equal(answer.releaseId, published.releaseId);
  assert.equal(writes, before, 'Reader questions never write documentation.');
});

test('unrelated or unsupported questions return no matches, not a general answer', async () => {
  const noArticle = harness([{ references: [] }]);
  assert.deepEqual((await noArticle.service(access, input)).sources, []);
  assert.equal(noArticle.calls.length, 1);
  const unsupported = harness([{ references: [0] }, { answer: 'An unsupported answer.', references: [] }]);
  const result = await unsupported.service(access, input);
  assert.deepEqual(result.sources, []); assert.match(result.answer, /could not find/);
});

test('unknown references and invented links are rejected rather than rendered', async () => {
  await assert.rejects(harness([{ references: [100] }]).service(access, input), /unknown article/);
  await assert.rejects(harness([{ references: [0] }, { answer: 'Go elsewhere.', references: [1] }]).service(access, input), /unknown article/);
  await assert.rejects(harness([{ references: [0], href: 'https://attacker.invalid' }]).service(access, input), /invalid documentation/);
});

test('reader, environment and current release checks happen before Gemini', async () => {
  const h = harness();
  const { readerUid: _uid, ...notReader } = access;
  await assert.rejects(h.service(notReader, input), /verified website reader/);
  await assert.rejects(h.service(access, { ...input, environment: 'beta' }), /access denied/);
  assert.equal(h.reads(), 0);
  await assert.rejects(h.service(access, { ...input, releaseId: 'old-release' }), /Load the latest/);
  assert.equal(h.calls.length, 0);
});

test('missing keys, Gemini errors, invalid responses and timeouts fail explicitly', async () => {
  const base = { aiKey: async () => 'key', read: async () => ({ records: fixture().records, head: { releaseId } }) };
  await assert.rejects(createOrbit({ ...base, aiKey: async () => null })(access, input), /workspace Gemini key/);
  await assert.rejects(createOrbit({ ...base, fetchGemini: async () => new Response('', { status: 429 }) })(access, input), /AI quota/);
  await assert.rejects(createOrbit({ ...base, fetchGemini: async () => new Response('', { status: 500 }) })(access, input), /temporarily unavailable/);
  await assert.rejects(createOrbit({ ...base, fetchGemini: async () => new Response('not json') })(access, input), /unreadable response/);
  await assert.rejects(createOrbit({ ...base, fetchGemini: async () => Response.json({ candidates: [] }) })(access, input), /valid documentation/);
  await assert.rejects(createOrbit({ ...base, fetchGemini: async () => { throw new DOMException('timeout', 'TimeoutError'); } })(access, input), /too long/);
});

test('per-reader throttling bounds cost and resets after the window', async () => {
  let now = 1000;
  const service = createOrbit({ now: () => now, aiKey: async () => 'key',
    read: async () => ({ records: fixture().records, head: { releaseId } }), fetchGemini: async () => gemini({ references: [] }) });
  for (let index = 0; index < 8; index++) await service(access, input);
  await assert.rejects(service(access, input), /Please wait/);
  now += 60_001;
  await service(access, input);
});

test('one reader cannot start overlapping Gemini requests', async () => {
  let release: () => void = () => assert.fail('Read did not start');
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const service = createOrbit({ aiKey: async () => 'key',
    read: async () => { await waiting; return { records: fixture().records, head: { releaseId } }; },
    fetchGemini: async () => gemini({ references: [] }) });
  const first = service(access, input);
  await assert.rejects(service(access, input), /Please wait/);
  release();
  await first;
});

test('Orbit gateway requires verified website credentials and rejects caller-supplied content', async t => {
  let calls = 0;
  const orbit = harness().service;
  const handler = createDocumentationV3({ allowedOrigins: new Set(), rpc: async () => assert.fail('Unexpected write or RPC'),
    authenticate: async () => access, orbit: async (identity, request) => { calls++; return orbit(identity, request); } });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const call = (body: object) => fetch('http://127.0.0.1:' + address.port, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const body = { ...input, action: 'orbit.ask', siteToken: 'dsite_' + 'a'.repeat(43) };
  const ok = await call(body);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).sources[0].href, '#/guides/approval');
  assert.equal((await call({ ...input, action: 'orbit.ask' })).status, 403);
  assert.equal((await call({ ...body, articles: [{ text: 'Forged content' }] })).status, 400);
  assert.equal((await call({ ...body, question: 'x'.repeat(1001) })).status, 400);
  assert.equal(calls, 1);
});

function groq(value: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

test('Groq answers with smaller input when both Gemini models fail, and reports its own failure too', async () => {
  const base = { aiKey: async () => 'key', read: async () => ({ records: fixture().records, head: { releaseId } }),
    fetchGemini: async () => new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 }) };
  const calls: { url: string; options: RequestInit }[] = [];
  const replies = [{ references: [0] }, { references: [0], answer: 'Open Approval rules.' }];
  const answer = await createOrbit({ ...base, groqKey: async () => 'groq-key', fetchGroq: async (url, options) => {
    calls.push({ url: String(url), options: options! }); return groq(replies.shift());
  } })(access, input);
  assert.equal(answer.answer, 'Open Approval rules.');
  assert.equal(answer.sources[0]?.href, '#/guides/approval');
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /api\.groq\.com\/openai\/v1\/chat\/completions$/);
  assert.equal((calls[0]!.options.headers as Record<string, string>).Authorization, 'Bearer groq-key');
  const body = JSON.parse(String(calls[0]!.options.body));
  assert.equal(body.model, 'openai/gpt-oss-20b');
  for (const entry of JSON.parse(body.messages[1].content).catalog) assert.ok(entry.summary.length <= 80);
  for (const article of JSON.parse(JSON.parse(String(calls[1]!.options.body)).messages[1].content).articles) assert.ok(article.text.length <= 1500);

  await assert.rejects(createOrbit({ ...base, groqKey: async () => 'groq-key', fetchGroq: async () => new Response('', { status: 429 }) })(access, input),
    /Groq reached its AI quota/);
  await assert.rejects(createOrbit({ ...base, groqKey: async () => 'groq-key', fetchGroq: async () => groq({ nope: true }) })(access, input),
    /Groq returned invalid documentation guidance/);
  let used = false;
  await assert.rejects(createOrbit({ ...base, fetchGroq: async () => { used = true; return groq({ references: [] }); } })(access, input),
    /Groq fallback is not configured/);
  assert.equal(used, false, 'Without a Groq key, Orbit never calls Groq.');
});

test('Orbit tries Flash, then Lite, then Groq in order for each generation stage', async () => {
  for (const useGroq of [false, true]) {
    const calls: string[] = [];
    let replies = 0;
    const response = () => ++replies === 1 ? { references: [0] } : { references: [0], answer: 'Approval rules explain this.' };
    const orbit = createOrbit({
      aiKey: async () => 'key', groqKey: async () => 'fallback-key',
      read: async () => ({ records: fixture().records, head: { releaseId } }),
      fetchGemini: async url => {
        const model = String(url).split('/models/')[1]!.split(':')[0]!;
        calls.push(model);
        if (model === 'gemini-3.5-flash' || useGroq) return new Response('', { status: 429 });
        return gemini(response());
      },
      fetchGroq: async () => { calls.push('Groq'); return groq(response()); }
    });
    assert.equal((await orbit(access, input)).answer, 'Approval rules explain this.');
    const stage = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', ...(useGroq ? ['Groq'] : [])];
    assert.deepEqual(calls, [...stage, ...stage]);
  }
});

test('unavailable models, denied access, timeouts, network errors and malformed replies try Lite', async () => {
  for (const failure of [
    () => new Response('', { status: 404 }),
    () => new Response('', { status: 403 }),
    () => { throw new DOMException('timeout', 'TimeoutError'); },
    () => { throw new TypeError('fetch failed'); },
    () => new Response('invalid json'),
    () => gemini({ unexpected: true })
  ]) {
    const calls: string[] = [];
    const orbit = createOrbit({ aiKey: async () => 'key',
      read: async () => ({ records: fixture().records, head: { releaseId } }),
      fetchGemini: async url => {
        calls.push(String(url));
        return calls.length === 1 ? failure() : gemini({ references: [] });
      } });
    assert.deepEqual((await orbit(access, input)).sources, []);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!, /gemini-3\.5-flash-lite:/);
  }
});

test('a valid no-match answer does not trigger a fallback', async () => {
  const h = harness([{ references: [] }]);
  assert.deepEqual((await h.service(access, input)).sources, []);
  assert.equal(h.calls.length, 1);
});

test('a configured Groq key can answer when no Gemini key is configured', async () => {
  const replies: unknown[] = [{ references: [0] }, { references: [0], answer: 'Open Approval rules.' }];
  const orbit = createOrbit({ aiKey: async () => null, groqKey: async () => 'groq-key',
    read: async () => ({ records: fixture().records, head: { releaseId } }),
    fetchGemini: async () => assert.fail('No Gemini key: do not make a Gemini request.'),
    fetchGroq: async () => groq(replies.shift()) });
  assert.equal((await orbit(access, input)).answer, 'Open Approval rules.');
});

test('content refusals and truncated answers are reported distinctly after both Gemini attempts', async () => {
  for (const [response, reason] of [
    [{ promptFeedback: { blockReason: 'SAFETY' } }, /content restrictions/],
    [{ candidates: [{ finishReason: 'SAFETY' }] }, /content restrictions/],
    [{ candidates: [{ finishReason: 'MAX_TOKENS' }] }, /answer token limit/]
  ] as const) {
    const orbit = createOrbit({ aiKey: async () => 'key',
      read: async () => ({ records: fixture().records, head: { releaseId } }),
      fetchGemini: async () => Response.json(response) });
    await assert.rejects(orbit(access, input), reason);
  }
});

test('general questions get a site overview in both requests, limited to the reader\'s sections', async () => {
  const records = fixture().records.map(record => record.key === 'foundation'
    ? { ...record, data: { ...(record.data as object), meta: { ...(record.data as { meta: object }).meta, subtitle: 'Guides for the team' },
        copy: { hero: 'Northstar explains how requests are approved.', who: 'x'.repeat(900) } } }
    : record);
  const payloads: string[] = [];
  const responses: unknown[] = [{ references: [0] }, { answer: 'Northstar explains how requests are approved. Open Approval rules.', references: [0] }];
  const orbit = createOrbit({ aiKey: async () => 'workspace-key', read: async () => ({ records, head: { releaseId } }),
    fetchGemini: async (_url, options) => { payloads.push(String(options!.body)); return gemini(responses.shift()); } });
  const answer = await orbit(access, { ...input, question: 'What is this?' });
  assert.match(answer.answer, /Northstar explains/);
  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.match(payload, /Northstar explains how requests are approved/);
    assert.match(payload, /Product guides/);
    assert.doesNotMatch(payload, /Engineering|x{401}/);
  }
});

test('one question consumes one reservation regardless of model fallback attempts', async () => {
  let reservations = 0;
  const completed: { id: string; outcome: string; attempts: OrbitAttempt[] }[] = [];
  let calls = 0;
  const orbit = createOrbit({ aiKey: async () => 'key',
    read: async () => ({ records: fixture().records, head: { releaseId } }),
    usage: {
      reserve: async identity => { assert.equal(identity.email, access.email); reservations++; return 'request'; },
      complete: async (id, outcome, attempts) => { completed.push({ id, outcome, attempts }); }
    },
    fetchGemini: async url => {
      if (String(url).includes('flash:')) return new Response('', { status: 429 });
      return gemini(++calls === 1 ? { references: [0] } : { references: [0], answer: 'Open Approval rules.' });
    } });
  await orbit(access, input);
  assert.equal(reservations, 1);
  assert.deepEqual(completed, [{ id: 'request', outcome: 'success', attempts: [
    { model: 'gemini-3.5-flash', status: 'failed' }, { model: 'gemini-3.5-flash-lite', status: 'success' },
    { model: 'gemini-3.5-flash', status: 'failed' }, { model: 'gemini-3.5-flash-lite', status: 'success' }
  ] }]);
});

test('daily limits stop provider calls and validation failures never reserve a question', async () => {
  let reservations = 0;
  const orbit = createOrbit({
    aiKey: async () => assert.fail('Blocked questions do not access provider keys.'),
    read: async () => ({ records: fixture().records, head: { releaseId } }),
    usage: {
      reserve: async () => { reservations++; throw new DocumentationV3Error(429, 'Daily Orbit limit reached.'); },
      complete: async () => assert.fail('A blocked reservation is not completed.')
    }
  });
  await assert.rejects(orbit(access, { ...input, question: 'x' }));
  await assert.rejects(orbit(access, { ...input, environment: 'beta' }));
  await assert.rejects(orbit(access, { ...input, releaseId: 'stale' }));
  assert.equal(reservations, 0);
  await assert.rejects(orbit(access, input), /Daily Orbit limit/);
  assert.equal(reservations, 1);
});

test('no-match answers and failed provider requests both count, and failed accounting never reports success', async () => {
  for (const failed of [false, true]) {
    let reservations = 0, completions = 0;
    const orbit = createOrbit({ aiKey: async () => 'key',
      read: async () => ({ records: fixture().records, head: { releaseId } }),
      usage: {
        reserve: async () => { reservations++; return 'request'; },
        complete: async (_id, outcome, attempts) => {
          completions++; assert.equal(outcome, failed ? 'failed' : 'success');
          assert.equal(attempts.length, failed ? 2 : 1);
        }
      },
      fetchGemini: async () => failed ? new Response('', { status: 503 }) : gemini({ references: [] })
    });
    if (failed) await assert.rejects(orbit(access, input), /temporarily unavailable/);
    else assert.deepEqual((await orbit(access, input)).sources, []);
    assert.equal(reservations, 1); assert.equal(completions, 1);
  }
  const orbit = createOrbit({ aiKey: async () => 'key',
    read: async () => ({ records: fixture().records, head: { releaseId } }),
    usage: { reserve: async () => 'request', complete: async () => { throw new DocumentationV3Error(503, 'Accounting unavailable.'); } },
    fetchGemini: async () => gemini({ references: [] }) });
  await assert.rejects(orbit(access, input), /Accounting unavailable/);
  await assert.rejects(orbit(access, input), /Accounting unavailable/, 'Accounting errors release the in-flight lock.');
});
