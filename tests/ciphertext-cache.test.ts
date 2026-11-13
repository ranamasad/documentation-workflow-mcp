import test from 'node:test';
import assert from 'node:assert/strict';
import { createCiphertextCache, ciphertextCacheKey } from '../src/ciphertext-cache.js';
import { readHttpConfig } from '../src/config.js';

test('ciphertext cache validates hits, expires, and deduplicates durable fallback', async () => {
  let clock = 0, loads = 0;
  const cache = createCiphertextCache({ now: () => clock, ttlSeconds: 2 });
  const validate = (value: unknown) => {
    assert.equal(value, 'ciphertext'); return value;
  };
  const load = async () => { loads++; await Promise.resolve(); return 'ciphertext'; };
  assert.deepEqual(await Promise.all([cache.get('x', validate, load), cache.get('x', validate, load)]), ['ciphertext', 'ciphertext']);
  assert.equal(loads, 1);
  await cache.get('x', validate, load); assert.equal(loads, 1);
  clock = 2001; await cache.get('x', validate, load); assert.equal(loads, 2);
});

test('cache corruptions are logged, deleted and never served; cache failures do not lose durable data', async () => {
  const commands: string[][] = [], warnings: string[] = [];
  const cache = createCiphertextCache({ redis: { url: 'https://cache.example', token: 'secret' }, warn: warning => warnings.push(warning),
    fetch: async (_url, init) => {
      const command = JSON.parse(String(init?.body)) as string[]; commands.push(command);
      if (command[0] === 'GET') return Response.json({ result: '{"scope":"wrong"}' });
      if (command[0] === 'DEL') return Response.json({ result: 1 });
      throw new TypeError('network error secret');
    } });
  const result = await cache.get('x', value => { assert.equal(value, 'good'); return value; }, async () => 'good');
  assert.equal(result, 'good');
  assert.deepEqual(commands.map(command => command[0]), ['GET', 'DEL', 'SET']);
  assert(warnings.some(warning => warning.includes('Corrupt')));
  assert(warnings.every(warning => !warning.includes('secret')));
  assert.deepEqual(await cache.set('y', 'good'), ['Ciphertext cache unavailable; durable storage retained.']);
  assert.equal(commands.at(-1)?.at(-1), '7200');
});

test('cache is byte bounded and namespaces project/environment', async () => {
  const cache = createCiphertextCache({ maxBytes: 100 });
  for (let index = 0; index < 50; index++) await cache.set(String(index), 'x'.repeat(40));
  assert(cache.bytes <= 100);
  await cache.set('large', 'x'.repeat(1000)); assert(cache.bytes <= 100);
  assert.notEqual(ciphertextCacheKey('firebase', 'a', 'beta', 'hash'), ciphertextCacheKey('firebase', 'a', 'production', 'hash'));
  assert.notEqual(ciphertextCacheKey('firebase', 'a', 'beta', 'hash'), ciphertextCacheKey('firebase', 'b', 'beta', 'hash'));
});

test('Upstash configuration is optional, paired, HTTPS and credential-free', () => {
  const base = { MCP_ALLOWED_HOSTS: 'localhost' };
  assert.equal(readHttpConfig(base).upstash, undefined);
  assert.throws(() => readHttpConfig({ ...base, UPSTASH_REDIS_REST_URL: 'https://cache.example' }));
  for (const url of ['http://cache.example', 'https://user:password@cache.example', 'https://cache.example/path']) {
    assert.throws(() => readHttpConfig({ ...base, UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: 'secret' }));
  }
  assert.deepEqual(readHttpConfig({ ...base, UPSTASH_REDIS_REST_URL: 'https://cache.example', UPSTASH_REDIS_REST_TOKEN: 'secret' }).upstash,
    { url: 'https://cache.example', token: 'secret' });
});

test('the Redis cache prefers the Vercel integration variables and never uses the read-only token', async () => {
  const { redisRestEnv } = await import('../src/config.js');
  assert.deepEqual(redisRestEnv({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'rw', KV_REST_API_READ_ONLY_TOKEN: 'ro',
    UPSTASH_REDIS_REST_URL: 'https://old.example', UPSTASH_REDIS_REST_TOKEN: 'old' }), { url: 'https://kv.example', token: 'rw' });
  assert.deepEqual(redisRestEnv({ UPSTASH_REDIS_REST_URL: 'https://old.example', UPSTASH_REDIS_REST_TOKEN: 'old' }), { url: 'https://old.example', token: 'old' });
  assert.deepEqual(readHttpConfig({ MCP_ALLOWED_HOSTS: 'localhost', KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'rw' }).upstash, { url: 'https://kv.example', token: 'rw' });
});
