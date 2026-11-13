import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createValidationService, sha256, wireRecord, VALIDATION_REQUEST_BYTES, type WireRecord } from '../src/validation.js';
import { createHttpHandler } from '../src/http.js';
import { readHttpConfig } from '../src/config.js';
import { reviewedCatalog } from './reviewed-catalog.js';

const signingKey = 'private-server-test-key-not-shared-with-clients-0123456789';
const otherKey = 'other-deployment-private-test-key-0123456789abcdef';
const service = createValidationService(signingKey);
const legacy = (name = 'complete') => z.array(wireRecord).parse(JSON.parse(
  readFileSync(new URL('../../contract/examples/' + name + '.json', import.meta.url), 'utf8')
));
// Hosted validation accepts v2 only; these fixtures are the generic v1 examples converted to v2.
const converter = createRequire(import.meta.url)('../../vendor/documentation-convert.js') as { convertSnapshot(records: WireRecord[]): { records: WireRecord[] } };
const fixtures = () => z.array(wireRecord).parse(converter.convertSnapshot(legacy()).records);
const COUNT = fixtures().length;
const faqRecord = () => structuredClone(fixtures().find(record => record.page === 'faq')!);
const setValue = (record: WireRecord, key: string, value: unknown) => { (record.data.value as Record<string, unknown>)[key] = value; };
const articleTokens = (result: ReturnType<typeof service.records>) => result.receipts.filter(receipt => receipt.key !== 'foundation').map(receipt => receipt.token);

test('hosted complete validation returns structured errors and fixes without echoing bodies', () => {
  const invalid = fixtures();
  invalid[1]!.data.value = 'Private draft prose must not be echoed' as unknown as Record<string, unknown>;
  const rejected = service.records({ records: invalid, complete: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.receipts.length, 0);
  assert.equal(rejected.issues[0]?.index, 1);
  assert.match(rejected.errors.join(' '), /invalid generic article/);
  assert.doesNotMatch(JSON.stringify(rejected), /Private draft prose/);
  const valid = fixtures();
  const accepted = service.records({ records: valid, complete: true });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.complete, true);
  assert.equal(accepted.count, COUNT);
  assert.equal(accepted.receipts.length, COUNT);
  assert.match(accepted.manifestHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(accepted.manifest?.[valid[1]!.key], sha256(JSON.stringify(valid[1])));
  assert.doesNotMatch(JSON.stringify(accepted), /Understand the example system/);
  assert.match(accepted.nextAction, /does not authorize writes/);
  assert.equal(service.records({}).ok, false);
  assert.equal(service.records({ records: [], payloads: [] }).ok, false);
});

test('original revision payload strings retain whitespace, byte count and original hash', () => {
  const records = fixtures();
  const payloads = records.map(record => JSON.stringify(record, null, 2));
  const original = service.records({ payloads, complete: true });
  assert.equal(original.ok, true);
  assert.equal(original.revisions[1]?.revision, sha256(payloads[1]!));
  assert.equal(original.revisions[1]?.bytes, Buffer.byteLength(payloads[1]!));
  assert.notEqual(original.revisions[1]?.revision, sha256(JSON.stringify(records[1])));
  const snapshot = service.snapshot(payloads[0], articleTokens(original));
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.manifest, original.manifest);
  assert.equal(snapshot.manifestHash, original.manifestHash);
  assert.equal(service.records({ payloads: ['{"sensitive-example'] }).issues[0]?.code, 'INVALID_JSON');
  const oversize = JSON.stringify(records[1]) + ' '.repeat(700000);
  assert.equal(service.records({ payloads: [oversize] }).ok, false);
});

test('signed snapshot validates all batches across independent server instances and blocks tampering', () => {
  const records = fixtures();
  const batchOne = service.records({ records: records.slice(1, 9) });
  const batchTwo = createValidationService(signingKey).records({ records: records.slice(9) });
  const tokens = [...articleTokens(batchOne), ...articleTokens(batchTwo)];
  const result = createValidationService(signingKey).snapshot(records[0], tokens);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.count, COUNT);
  assert.equal(result.manifestHash, service.records({ records, complete: true }).manifestHash);
  const modified = tokens.slice();
  modified[0] = modified[0]!.slice(0, -3) + 'abc';
  assert.equal(service.snapshot(records[0], modified).issues[0]?.code, 'INVALID_RECEIPT');
  assert.equal(createValidationService(otherKey).snapshot(records[0], tokens).issues[0]?.code, 'INVALID_RECEIPT');
  assert.equal(service.snapshot(records[0], [tokens[0]!, tokens[0]!]).issues[0]?.code, 'DUPLICATE_KEY');
  const foundationReceipt = service.records({ records: records.slice(0, 1) }).receipts[0]!.token;
  assert.equal(service.snapshot(records[0], [foundationReceipt, ...tokens]).issues[0]?.code, 'DUPLICATE_KEY');
});

test('full hosted snapshot checks bidirectional navigation, hidden entries and missing foundation', () => {
  const records = fixtures();
  const tokens = articleTokens(service.records({ records: records.slice(1) }));
  assert.equal(service.snapshot(records[1], tokens).ok, false);
  assert.equal(service.records({ records: records.slice(1), complete: true }).ok, false);
  const missingArticle = service.snapshot(records[0], tokens.slice(1));
  assert.equal(missingArticle.ok, false);
  assert.match(missingArticle.errors.join(' '), /missing (record|navigation metadata)/);
  const foundation = structuredClone(records[0]!);
  const nav = z.object({ tabs: z.array(z.unknown()), groups: z.array(z.unknown()), entries: z.array(z.record(z.string(), z.unknown())) }).parse(foundation.data.navigation);
  nav.entries = nav.entries.filter(entry => entry.key !== records[1]!.key);
  foundation.data.navigation = nav;
  assert.match(service.snapshot(foundation, tokens).errors.join(' '), /missing navigation metadata/);
  const empty = structuredClone(records[0]!);
  const emptyNav = z.object({ entries: z.array(z.unknown()) }).passthrough().parse(empty.data.navigation);
  emptyNav.entries = [];
  empty.data.navigation = emptyNav;
  assert.equal(service.snapshot(empty, []).ok, true, service.snapshot(empty, []).errors.join('; '));
});

test('large snapshots validate through bounded batches without keeping article bodies on the server', () => {
  const records = fixtures();
  const foundation = records[0]!;
  const faq = faqRecord();
  const nav = z.object({ tabs: z.array(z.unknown()), groups: z.array(z.unknown()), entries: z.array(z.record(z.string(), z.unknown())) }).parse(foundation.data.navigation);
  const template = nav.entries.find(entry => entry.key === faq.key);
  assert.ok(template);
  const additions: WireRecord[] = Array.from({ length: 27 }, (_, index) => {
    const id = 'large-faq-' + index;
    nav.entries.push({ ...template, id: 'large-entry-' + index, key: 'faq/' + id, href: '#/faq/' + id });
    return { ...faq, key: 'faq/' + id, data: { ...faq.data, id, blocks: [{ id: 'answer', type: 'paragraph', text: 'generic example text '.repeat(20000) }] } };
  });
  foundation.data.navigation = nav;
  assert.ok(Buffer.byteLength(JSON.stringify([...records, ...additions])) > VALIDATION_REQUEST_BYTES);
  assert.equal(service.records({ records: [...records, ...additions], complete: true }).ok, false);
  const tokens = articleTokens(service.records({ records: records.slice(1) }));
  for (const record of additions) {
    const checked = service.records({ records: [record] });
    assert.equal(checked.ok, true);
    tokens.push(...articleTokens(checked));
  }
  const result = createValidationService(signingKey).snapshot(foundation, tokens);
  assert.equal(result.ok, true);
  assert.equal(result.count, COUNT + additions.length);
  assert.equal(Object.keys(result.manifest ?? {}).length, COUNT + additions.length);
  assert.equal(service.records({ records: additions.slice(0, 1) }).complete, false);
});

test('unsafe JSON and excessive depth fail with no signed receipts, never success-shaped fallbacks', () => {
  for (const data of [
    JSON.parse('{"__proto__":{"secret":"never echo this"}}'),
    { constructor: 'invalid' },
    { a: '\0' }
  ]) {
    const record = faqRecord();
    setValue(record, 'extra', data);
    const checked = service.records({ records: [record] });
    assert.equal(checked.ok, false);
    assert.equal(checked.receipts.length, 0);
    assert.doesNotMatch(JSON.stringify(checked), /never echo this/);
  }
  let deep: unknown = 'leaf';
  for (let i = 0; i < 35; i++) deep = { child: deep };
  const record = faqRecord();
  setValue(record, 'extra', deep);
  assert.equal(service.records({ records: [record] }).ok, false);
  assert.equal(existsSync(new URL('../../scripts/validate-local.mjs', import.meta.url)), false);
});

for (const mode of ['legacy', 'modern'] as const) {
  test(`real ${mode} MCP validates drafts over HTTP and returns full snapshot evidence`, { timeout: 20_000 }, async t => {
    const token = 'test-only-http-bearer-0123456789abcdef0123456789';
    const http = createHttpHandler(readHttpConfig({ MCP_BEARER_TOKEN: token, MCP_VALIDATION_SIGNING_KEY: signingKey }));
    const server = createServer((req, res) => {
      void http.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    t.after(async () => {
      await http.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const client = new Client({ name: 'hosted-validation-test', version: '1' }, mode === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } }
    }));
    t.after(() => client.close());
    const records = reviewedCatalog();
    const large = faqRecord();
    large.data.blocks = [{ id: 'answer', type: 'paragraph', text: 'generic documentation draft '.repeat(14000) }];
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 32 * 1024);
    const largeChecked = await client.callTool({ name: 'validate_documentation', arguments: { records: [large] } });
    assert.equal(largeChecked.isError, true, 'Large structurally valid drafts still require a coverage plan and useful editorial structure.');
    assert.equal(z.object({ ok: z.boolean() }).parse(largeChecked.structuredContent).ok, true);
    const failed = await client.callTool({ name: 'validate_documentation', arguments: { records: [{ key: 'bad' }], complete: true } });
    assert.equal(failed.isError, true);
    assert.equal(z.object({ ok: z.boolean() }).parse(failed.structuredContent).ok, false);
    const checked = await client.callTool({ name: 'validate_documentation', arguments: { records } });
    assert.equal(checked.isError, false);
    const report = z.object({ ok: z.boolean(), complete: z.boolean(), receipts: z.array(z.object({ key: z.string(), token: z.string() })) }).parse(checked.structuredContent);
    assert.equal(report.complete, false);
    const snapshot = await client.callTool({ name: 'validate_documentation_snapshot', arguments: {
      foundation: records[0], receipts: report.receipts.filter(receipt => receipt.key !== 'foundation').map(receipt => receipt.token)
    } });
    assert.equal(snapshot.isError, false);
    const complete = z.object({ complete: z.literal(true), count: z.number(), manifestHash: z.string() }).parse(snapshot.structuredContent);
    assert.equal(complete.count, records.length);
    assert.equal(complete.manifestHash, service.records({ records, complete: true }).manifestHash);
    const unknown = await client.callTool({ name: 'validate_documentation', arguments: { records, sourceCode: 'not accepted' } });
    assert.equal(unknown.isError, true);
    const badReceipt = await client.callTool({ name: 'validate_documentation_snapshot', arguments: { foundation: records[0], receipts: ['forged'] } });
    assert.equal(badReceipt.isError, true);
    const rawPayloads = records.map(record => JSON.stringify(record, null, 2));
    const preserved = await client.callTool({ name: 'validate_documentation', arguments: { payloads: rawPayloads, complete: true } });
    assert.equal(preserved.isError, false);
    const manifest = z.object({ manifest: z.record(z.string(), z.string()) }).parse(preserved.structuredContent).manifest;
    assert.equal(manifest[records[1]!.key], sha256(rawPayloads[1]!));
    const v1 = legacy();
    const refused = await client.callTool({ name: 'validate_documentation', arguments: { records: v1, complete: true } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.structuredContent), /LEGACY_FORMAT/);
    const converted = await client.callTool({ name: 'convert_documentation_to_v2', arguments: { foundation: v1[0], records: v1.slice(1), complete: true } });
    assert.equal(converted.isError, false);
    const result = z.object({ ok: z.literal(true), records: z.array(wireRecord), report: z.object({ sections: z.array(z.string()) }) })
      .parse(JSON.parse(z.array(z.object({ text: z.string() })).parse(converted.content)[0]!.text));
    assert.equal(result.records.length, COUNT);
    assert.ok(result.report.sections.includes('features'));
  });
}

test('hosted validation and snapshots refuse v1 and point to the converter', () => {
  const v1 = legacy();
  const refused = service.records({ records: v1, complete: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.receipts.length, 0);
  assert.ok(refused.issues.some(item => item.code === 'LEGACY_FORMAT'));
  assert.match(refused.errors.join(' '), /convert_documentation_to_v2/);
  assert.equal(service.snapshot(v1[0], []).issues.some(item => item.code === 'LEGACY_FORMAT'), true);
});
