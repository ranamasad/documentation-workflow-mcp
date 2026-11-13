import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreCache } from '../src/firestore-cache.js';
import { applyFirestoreCommit, createFirestoreReader, createFirestoreWriter, useFirestoreCache, type TokenSource } from '../src/firestore.js';

const secret = 'x'.repeat(32);
const sharedTokens: TokenSource = Object.assign(async () => 'token', { shared: true });
const personalTokens: TokenSource = async () => 'token';

/** In-memory Upstash REST pipeline: one hash per key, with expiry. */
function fakeUpstash(clock: () => number) {
  const hashes = new Map<string, { fields: Map<string, string>; expires: number }>();
  const commands: string[][] = [];
  let down = false;
  const live = (key: string) => {
    const hash = hashes.get(key);
    if (hash && hash.expires <= clock()) hashes.delete(key);
    return hashes.get(key);
  };
  const run = ([name, key, ...args]: string[]): unknown => {
    const hash = live(key!);
    switch (name) {
      case 'PING': return 'PONG';
      case 'HMGET': return args.map(field => hash?.fields.get(field) ?? null);
      case 'HGET': return hash?.fields.get(args[0]!) ?? null;
      case 'HSET': case 'HSETNX': {
        const target = hash ?? { fields: new Map(), expires: Infinity };
        hashes.set(key!, target);
        if (name === 'HSETNX' && target.fields.has(args[0]!)) return 0;
        target.fields.set(args[0]!, args[1]!); return 1;
      }
      case 'HDEL': hash?.fields.delete(args[0]!); return 1;
      case 'EXPIRE': if (hash) hash.expires = clock() + Number(args[0]) * 1000; return hash ? 1 : 0;
      case 'HSCAN': {
        const pattern = new RegExp('^' + args[2]!.replace(/[.]/g, '\\.').replace('*', '.*') + '$');
        return ['0', [...(hash?.fields ?? [])].filter(([field]) => pattern.test(field)).flat()];
      }
      default: throw new Error('Unexpected ' + name);
    }
  };
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (down) throw new TypeError('offline');
    const batch = JSON.parse(String(init?.body)) as string[][];
    commands.push(...batch);
    return Response.json(batch.map(command => ({ result: run(command) })));
  }) as typeof globalThis.fetch;
  return { fetch, commands, hashes, setDown(value: boolean) { down = value; } };
}

/** Firestore REST stand-in holding plain documents by relative path. */
function fakeFirestore(documents: Map<string, Record<string, string>>) {
  const requests: string[] = [];
  const name = (path: string) => 'projects/p/databases/(default)/documents/' + path;
  const encode = (data: Record<string, string>) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { stringValue: value }]));
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const path = target.slice(target.indexOf('/documents') + 10);
    requests.push((init?.method ?? 'GET') + ' ' + path);
    if (path.endsWith(':commit')) {
      const writes = (JSON.parse(String(init?.body)) as { writes: { update?: { name: string; fields: Record<string, { stringValue: string }> }; delete?: string }[] }).writes;
      for (const write of writes) {
        if (write.delete) documents.delete(write.delete.slice(write.delete.indexOf('/documents/') + 11));
        else documents.set(write.update!.name.slice(write.update!.name.indexOf('/documents/') + 11),
          Object.fromEntries(Object.entries(write.update!.fields).map(([key, value]) => [key, value.stringValue])));
      }
      return Response.json({ writeResults: writes.map(() => ({ updateTime: '2026-10-23T01:00:00Z' })) });
    }
    if (path.endsWith(':runQuery')) {
      const collection = (JSON.parse(String(init?.body)) as { structuredQuery: { from: { collectionId: string }[] } }).structuredQuery.from[0]!.collectionId;
      return Response.json([...documents].filter(([key]) => key.split('/').at(-2) === collection)
        .map(([key, data]) => ({ document: { name: name(key), fields: encode(data) } })));
    }
    if (path.includes('?pageSize')) {
      const collection = path.slice(1, path.indexOf('?'));
      return Response.json({ documents: [...documents].filter(([key]) => key.startsWith(collection + '/') && key.split('/').length === 2)
        .map(([key, data]) => ({ name: name(key), fields: encode(data) })) });
    }
    const data = documents.get(path.slice(1));
    return data ? Response.json({ fields: encode(data), updateTime: '2026-10-23T00:00:00Z' }) : new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

test('reads come from Redis after the first load; writes replace cached copies in place', async (t) => {
  let clock = 0;
  const upstash = fakeUpstash(() => clock);
  useFirestoreCache(createFirestoreCache({ secret, redis: { url: 'https://cache.example', token: 'secret' }, fetch: upstash.fetch, now: () => clock, warn: () => {} }));
  t.after(() => useFirestoreCache(undefined));
  const firestore = fakeFirestore(new Map([['teams/a', { name: 'A' }], ['documentationEnvironments/beta', { releaseId: 'r1' }]]));
  const reader = createFirestoreReader('p', sharedTokens, firestore.fetch);
  const writer = createFirestoreWriter('p', sharedTokens, firestore.fetch);

  assert.deepEqual(await reader.get('documentationEnvironments/beta'), { data: { releaseId: 'r1' }, token: '2026-10-23T00:00:00Z' });
  clock += 10_000;
  await reader.get('documentationEnvironments/beta');
  assert.equal(firestore.requests.length, 1);
  assert(upstash.commands.every(command => !command.join(' ').includes('documentationEnvironments')), 'Redis sees only opaque names and sealed values');

  assert.deepEqual(await writer.list('teams'), [{ id: 'a', data: { name: 'A' } }]);
  await writer.commit([{ set: 'teams/b', fields: { name: 'B' } }]);
  const before = firestore.requests.length;
  clock += 10_000;
  assert.deepEqual(await writer.list('teams'), [{ id: 'a', data: { name: 'A' } }, { id: 'b', data: { name: 'B' } }]);
  await writer.commit([{ delete: 'teams/a' }]);
  clock += 10_000;
  assert.deepEqual(await writer.list('teams'), [{ id: 'b', data: { name: 'B' } }]);
  assert.equal(firestore.requests.length, before + 1, 'only the delete commit reached Firestore');

  // Another instance shares the same Redis data.
  const other = createFirestoreCache({ secret, redis: { url: 'https://cache.example', token: 'secret' }, fetch: upstash.fetch, now: () => clock, warn: () => {} });
  useFirestoreCache(other);
  assert.deepEqual(await createFirestoreWriter('p', sharedTokens, firestore.fetch).list('teams'), [{ id: 'b', data: { name: 'B' } }]);
  assert.equal(firestore.requests.length, before + 1);

  // An hour with no activity deletes the project's data; the next read loads again.
  clock += 60 * 60 * 1000 + 1;
  await reader.get('documentationEnvironments/beta');
  assert.equal(firestore.requests.length, before + 2);
});

test('activity keeps the session alive past an hour', async (t) => {
  let clock = 0;
  const upstash = fakeUpstash(() => clock);
  useFirestoreCache(createFirestoreCache({ secret, redis: { url: 'https://cache.example', token: 'secret' }, fetch: upstash.fetch, now: () => clock, warn: () => {} }));
  t.after(() => useFirestoreCache(undefined));
  const firestore = fakeFirestore(new Map([['teams/a', { name: 'A' }]]));
  const reader = createFirestoreReader('p', sharedTokens, firestore.fetch);
  for (let minute = 0; minute <= 180; minute += 20) {
    clock = minute * 60 * 1000;
    await reader.get('teams/a');
  }
  assert.equal(firestore.requests.length, 1);
});

test('queries are answered from the cached collection and include new writes', async (t) => {
  useFirestoreCache(createFirestoreCache({ secret }));
  t.after(() => useFirestoreCache(undefined));
  const firestore = fakeFirestore(new Map([
    ['documentationV3Telemetry/x/visits/1', { date: '2026-10-20' }],
    ['documentationV3Telemetry/x/visits/2', { date: '2026-10-22' }],
    ['documentationV3Telemetry/y/visits/3', { date: '2026-10-22' }]
  ]));
  const writer = createFirestoreWriter('p', sharedTokens, firestore.fetch);
  const query = () => writer.query('visits', { parent: 'documentationV3Telemetry/x', where: [{ field: 'date', op: 'GREATER_THAN_OR_EQUAL', string: '2026-10-21' }], orderBy: 'date', max: 10 });
  assert.deepEqual((await query()).documents.map(document => document.id), ['2']);
  await applyFirestoreCommit('p', [{ update: { name: 'projects/p/databases/(default)/documents/documentationV3Telemetry/x/visits/4', fields: { date: { stringValue: '2026-10-23' } } } }],
    { writeResults: [{ updateTime: '2026-10-23T00:00:00Z' }] });
  assert.deepEqual((await query()).documents.map(document => document.id), ['4', '2']);
  assert.equal(firestore.requests.filter(request => request.includes(':runQuery')).length, 1);
  const limited = await writer.query('visits', { parent: 'documentationV3Telemetry/x', orderBy: 'date', max: 1 });
  assert.deepEqual([limited.documents.map(document => document.id), limited.truncated], [['4'], true]);
});

test('personal reads, fresh reads and corrupt or unavailable Redis fall back to Firestore', async (t) => {
  let clock = 0;
  const upstash = fakeUpstash(() => clock);
  const options = { secret, redis: { url: 'https://cache.example', token: 'secret' }, fetch: upstash.fetch, now: () => clock, warn: () => {} };
  useFirestoreCache(createFirestoreCache(options));
  t.after(() => useFirestoreCache(undefined));
  const firestore = fakeFirestore(new Map([['teams/a', { name: 'A' }]]));
  const personal = createFirestoreReader('p', personalTokens, firestore.fetch);
  await personal.get('teams/a'); await personal.get('teams/a');
  assert.equal(firestore.requests.length, 2);
  const reader = createFirestoreReader('p', sharedTokens, firestore.fetch);
  await reader.get('teams/a'); await reader.get('teams/a', { fresh: true });
  assert.equal(firestore.requests.length, 4);
  // A tampered entry fails authentication: it is deleted and Firestore is read.
  for (const hash of upstash.hashes.values()) for (const [field, value] of hash.fields) hash.fields.set(field, value.replace(/\.(.)/, (_, c: string) => '.' + (c === 'A' ? 'B' : 'A')));
  useFirestoreCache(createFirestoreCache(options));
  assert.deepEqual(await createFirestoreReader('p', sharedTokens, firestore.fetch).get('teams/a'), { data: { name: 'A' }, token: '2026-10-23T00:00:00Z' });
  assert(upstash.commands.some(command => command[0] === 'HDEL'));
  upstash.setDown(true);
  useFirestoreCache(createFirestoreCache(options));
  assert.deepEqual((await createFirestoreReader('p', sharedTokens, firestore.fetch).get('teams/a'))?.data, { name: 'A' });
});

test('cache status pings Redis and reports this instance\'s cache errors', async () => {
  const clock = Date.parse('2026-10-25T00:00:00Z');
  const upstash = fakeUpstash(() => clock);
  assert.deepEqual(await createFirestoreCache({ secret }).status(), { redis: 'not-configured', failures: 0 });
  const cache = createFirestoreCache({ secret, redis: { url: 'https://cache.example', token: 'secret' }, fetch: upstash.fetch, now: () => clock, warn: () => {} });
  const working = await cache.status();
  assert.equal(working.redis, 'ok');
  assert.equal(working.failures, 0);
  upstash.setDown(true);
  await cache.document('p', 'teams/a', {}, async () => null);
  const down = await cache.status();
  assert.equal(down.redis, 'unreachable');
  // Expiry refresh, read and write each failed.
  assert.equal(down.failures, 3);
  assert.deepEqual(down.lastFailure, { at: '2026-10-25T00:00:00.000Z', message: 'Firestore cache write failed; Firestore stays authoritative.' });
});
