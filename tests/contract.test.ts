import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as validator from '../src/validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(pathToFileURL(resolve(root, 'package.json')));
const model = require(resolve(root, 'vendor/documentation-model.js'));
const discovery = require(resolve(root, 'vendor/documentation-discovery.js'));
const engine = require(resolve(root, 'vendor/documentation-engine.js'));

interface WireRecord {
  key: string;
  page: string;
  collection: string;
  title: string;
  data: Record<string, any>;
}
const readJSON = (path: string): any => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const fixture = (name: string): WireRecord[] => readJSON('contract/examples/' + name + '.json') as WireRecord[];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

test('every category fixture is an exact semantic record and aggregate covers all categories', () => {
  const manifest = readJSON('contract/manifest.json');
  assert.equal(manifest.contractVersion, '2.0.0');
  for (const [name, path] of Object.entries(manifest.examples) as [string, string][]) {
    const records = readJSON('contract/' + path) as WireRecord[];
    const report = validator.validateRecords(records, { complete: name === 'complete' || name === 'foundation' || name.startsWith('v2-') });
    assert.equal(report.ok, true, name + ': ' + report.errors.join('; '));
    assert.equal(report.schema, 1);
    assert.equal(report.contractVersion, manifest.contractVersion);
    records.forEach(record => assert.equal(model.record(record), record));
  }
  const records = fixture('complete');
  assert.equal(records.length, 18);
  assert.deepEqual(new Set(records.filter(record => record.page !== 'foundation').map(record => record.page)),
    new Set([...Object.keys(model.collections), 'backend']));
  assert.deepEqual(new Set(records.filter(record => record.page === 'backend').map(record => record.collection)),
    new Set(['backend.services', 'backend.databases', 'backend.integrations', 'backend.runbooks']));
  assert.deepEqual(Object.keys(fixture('foundation')[0]!.data.copy).sort(), [...model.copyKeys].sort());
});

test('aggregate records exactly match individual fixtures except enriched foundation navigation', () => {
  const aggregate = fixture('complete');
  const manifest = readJSON('contract/manifest.json');
  for (const [name, path] of Object.entries(manifest.examples) as [string, string][]) {
    if (name === 'complete' || name === 'foundation' || name.startsWith('v2-')) continue;
    for (const record of readJSON('contract/' + path) as WireRecord[]) {
      assert.deepEqual(aggregate.find(item => item.key === record.key), record);
    }
  }
  const foundation = fixture('foundation')[0]!;
  const composedFoundation = clone(aggregate[0]!);
  delete composedFoundation.data.navigation;
  const original = clone(foundation);
  delete original.data.navigation;
  assert.deepEqual(composedFoundation, original);
  const nav = aggregate[0]!.data.navigation;
  assert.equal(nav.entries.filter((entry: any) => entry.key !== 'foundation').length, aggregate.length - 1);
  assert.equal(model.assemble(aggregate).flows[0].steps.length > 0, true);
  assert.equal(aggregate[0]!.data.architecture.layers.length > 0, true);
});

test('snapshot checksums are pinned and vendor loaders retain exact CommonJS semantics', () => {
  const provenance = readJSON('vendor/provenance.json');
  assert.equal(provenance.schema, 1);
  assert.equal(provenance.contractVersion, '2.0.0');
  assert.equal(provenance.files.length, 8);
  assert.deepEqual(readJSON('contract/capabilities.json'), JSON.parse(JSON.stringify(model.schema.contract)), 'capabilities.json must come from the vendored schema.');
  assert.equal(readJSON('contract/manifest.json').contractVersion, provenance.contractVersion);
  for (const file of provenance.files as { snapshot: string | null; sha256: string; bytes: number }[]) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    if (!file.snapshot) continue;
    const bytes = readFileSync(resolve(root, file.snapshot));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.equal(readJSON('vendor/package.json').type, 'commonjs');
  assert.equal(typeof discovery.build, 'function');
  assert.equal(typeof engine.release, 'function');
  assert.equal(typeof model.navigationRecords, 'function');
  assert.equal(JSON.stringify(provenance).includes('/Users/'), false);
});

test('all declared schemas parse and every local $ref resolves without network', () => {
  const files = readdirSync(resolve(root, 'contract')).filter(name => name.endsWith('.schema.json'));
  const schemas = new Map(files.map(name => [name, readJSON('contract/' + name)]));
  const check = (value: unknown, current: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(item => check(item, current));
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'string') {
      const [file, fragment] = object.$ref.split('#');
      const target = schemas.get(file || current);
      assert.ok(target, 'Missing schema ref: ' + object.$ref);
      if (fragment) {
        let node: any = target;
        for (const segment of fragment.slice(1).split('/')) node = node?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
        assert.notEqual(node, undefined, 'Missing ref fragment: ' + object.$ref);
      }
    }
    Object.values(object).forEach(item => check(item, current));
  };
  for (const [file, schema] of schemas) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    check(schema, file);
  }
  assert.equal(files.length, 6);
});

test('default accepts a partial article set but complete requires foundation', () => {
  const records = fixture('faq');
  assert.equal(validator.validateRecords(records).ok, true);
  const report = validator.validateRecords(records, { complete: true });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(' '), /foundation/);
});

test('duplicate article keys include cross-collection backend collisions', () => {
  const record = fixture('faq')[0]!;
  assert.equal(validator.validateRecords([record, clone(record)]).ok, false);
  const service = fixture('backend-services')[0]!;
  const database = fixture('backend-databases')[0]!;
  database.key = service.key;
  database.data.id = service.data.id;
  assert.match(validator.validateRecords([service, database]).errors.join(' '), /Duplicate record key/);
});

test('actual model rejects locator mismatch, heading mismatch, top-level extras and wrong array types', () => {
  for (const mutate of [
    (record: WireRecord) => { record.collection = 'applications'; },
    (record: WireRecord) => { record.key = 'features/another-id'; },
    (record: WireRecord) => { record.title = 'Unmatched heading'; },
    (record: WireRecord) => { (record as any).extra = true; },
    (record: WireRecord) => { record.data.apps = 'not-an-array'; },
    (record: WireRecord) => { record.data.id = 'unsafe/id'; },
    (record: WireRecord) => { record.title = 'x'.repeat(257); }
  ]) {
    const record = fixture('features')[0]!;
    mutate(record);
    assert.equal(validator.validateRecords([record]).ok, false);
  }
  const api = fixture('api')[0]!;
  assert.equal(api.title, api.data.method + ' ' + api.data.path);
  const error = fixture('errors')[0]!;
  error.data.title = 'Alternative heading';
  assert.equal(validator.validateRecords([error]).ok, false);
  error.title = error.data.title;
  assert.equal(validator.validateRecords([error]).ok, true);
});

test('foundation requires every exact copy key and publication requires navigation', () => {
  for (const key of model.copyKeys as string[]) {
    const records = fixture('foundation');
    delete records[0]!.data.copy[key];
    assert.equal(validator.validateRecords(records).ok, false, key);
  }
  const records = fixture('foundation');
  delete records[0]!.data.navigation;
  assert.equal(validator.validateRecords(records).ok, true);
  assert.equal(validator.validateRecords(records, { complete: true }).ok, false);
});

test('complete coverage is bidirectional, including invisible entries and missing tabs', () => {
  const records = fixture('complete');
  const nav = records[0]!.data.navigation;
  nav.entries = nav.entries.filter((entry: any) => entry.key !== records[1]!.key);
  assert.equal(validator.validateRecords(records, { complete: true }).ok, false);
  const dangling = fixture('complete');
  dangling.pop();
  const hidden = dangling[0]!.data.navigation.entries.at(-1);
  hidden.visible = false;
  hidden.searchable = false;
  assert.match(validator.validateRecords(dangling, { complete: true }).errors.join(' '), /missing record/);
  const missingTab = fixture('complete');
  missingTab[0]!.data.navigation.tabs = missingTab[0]!.data.navigation.tabs.filter((tab: any) => tab.id !== 'features');
  assert.equal(validator.validateRecords(missingTab).ok, false);
});

test('navigation validates exact fields, uniqueness, reserved overview keys and group ownership', () => {
  for (const mutate of [
    (nav: any) => { nav.entries.push(clone(nav.entries[0])); },
    (nav: any) => { nav.tabs[0].href = '#/home'; },
    (nav: any) => { nav.entries[0].key = 'flows/lookup'; },
    (nav: any) => { nav.entries[0].extra = true; },
    (nav: any) => { nav.entries[0].group = 'missing-group'; },
    (nav: any) => { nav.tabs[0].icon = 'https://example.com/icon.svg'; },
    (nav: any) => { nav.tabs[0].order = 0.5; }
  ]) {
    const records = fixture('foundation');
    mutate(records[0]!.data.navigation);
    assert.equal(validator.validateRecords(records).ok, false);
  }
  assert.equal(model.areaKey('flows', 'lookup'), 'foundation');
  assert.equal(model.areaKey('backend', 'services'), 'foundation');
});

test('unsafe JSON, NUL, depth, nodes, string and UTF-8 byte limits fail locally', () => {
  for (const unsafe of ['__proto__', 'constructor', 'prototype']) {
    const records = fixture('faq');
    records[0]!.data.extra = JSON.parse('{"' + unsafe + '":"not allowed"}');
    assert.equal(validator.validateRecords(records).ok, false);
  }
  const badValues = [
    '\u0000', Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 'code',
    'a'.repeat(500001), Array.from({ length: 100001 }, () => null),
    { first: 'é'.repeat(200000), second: 'é'.repeat(200000) }
  ];
  let deep: any = 'leaf';
  for (let index = 0; index < 33; index++) deep = { child: deep };
  badValues.push(deep);
  for (const bad of badValues) {
    const records = fixture('faq');
    records[0]!.data.extra = bad;
    assert.equal(validator.validateRecords(records).ok, false);
  }
});

test('reports hash exact serialized record bytes without embedding payloads', async () => {
  const records = fixture('complete');
  const report = validator.validateRecords(records, { complete: true });
  assert.equal(report.ok, true);
  for (const [index, record] of records.entries()) {
    const payload = model.json(record);
    const revision = report.revisions![index]!;
    assert.equal(revision.revision, hash(payload));
    assert.equal(revision.bytes, Buffer.byteLength(payload, 'utf8'));
    assert.equal(revision.path, 'documentationRevisions/' + revision.revision);
    assert.equal(Object.hasOwn(revision, 'payload'), false);
  }
  const manifest = Object.fromEntries(report.revisions!.map(item => [item.key, item.revision]));
  assert.equal(report.manifestHash, await discovery.identity(manifest, validator.sha256));
  const originalPayload = JSON.stringify(records[1], null, 2);
  assert.notEqual(hash(originalPayload), hash(model.json(JSON.parse(originalPayload))));
  assert.equal(await engine.hash(originalPayload), hash(originalPayload));
});

test('discovery build/read verifies checksums and fails closed on absent/corrupt catalogs', async () => {
  const records = fixture('complete');
  const manifest = Object.fromEntries(records.map(record => [record.key, hash(model.json(record))]));
  const catalog = await discovery.build(records, manifest, validator.sha256);
  const stored = new Map<string, { data: any }>([[catalog.path, { data: catalog.root }]]);
  for (const shard of catalog.shards) stored.set(catalog.path + '/shards/' + shard.id, { data: shard.data });
  const adapter = { get: async (path: string) => stored.get(path) || null };
  const result = await discovery.read(adapter, manifest, validator.sha256);
  assert.equal(result.entries.length, records.length);
  assert.equal(result.manifestHash, await discovery.identity(manifest, validator.sha256));
  assert.ok(discovery.search(result.entries, 'status', 5).length > 0);
  await assert.rejects(() => discovery.read({ get: async () => null }, manifest, validator.sha256), /no full-content fallback/);
  const shardPath = catalog.path + '/shards/' + catalog.shards[0].id;
  stored.get(shardPath)!.data = { ...stored.get(shardPath)!.data, payload: '[{"corrupt":true}]' };
  await assert.rejects(() => discovery.read(adapter, manifest, validator.sha256), /corrupt shard/);
});

test('release validator accepts serialized manifest and rejects embedded maps', () => {
  const records = fixture('complete');
  const manifest = Object.fromEntries(records.map(record => [record.key, hash(model.json(record))]));
  const release = {
    schema: 1, environment: 'development', version: '1.0.0', tags: ['New'],
    summary: 'Generic contract test release.', actor: 'example-publisher', base: '',
    operation: 'apply', source: '', sourceRelease: '', rollbackRelease: '',
    manifest: model.json(manifest), areaChanges: '{}', createdAt: { illustrativeServerTimestamp: true }
  };
  assert.deepEqual(engine.release(release, 'development'), manifest);
  assert.throws(() => engine.release({ ...release, manifest }, 'development'));
  assert.throws(() => engine.release({ ...release, operation: 'promote', source: 'production' }, 'development'));
});

test('shared hosted validation rejects invalid input and never echoes article prose', () => {
  const success = validator.validateRecords(fixture('complete'), { complete: true });
  assert.equal(success.ok, true);
  assert.equal(JSON.stringify(success).includes('Understand the example system'), false);
  for (const input of [null, {}, [], [null], 'not an array', Array.from({ length: 2001 }, () => ({}))]) {
    assert.equal(validator.validateRecords(input).ok, false);
  }
  const invalid = validator.validateText('{"private-sensitive-example');
  assert.equal(invalid.ok, false);
  assert.equal(JSON.stringify(invalid).includes('private-sensitive-example'), false);
});

test('validateText distinguishes JSON syntax errors from semantic errors and unexpected failures', () => {
  assert.deepEqual(validator.validateText('{').errors, ['Invalid JSON input.']);
  const semantic = fixture('faq');
  semantic[0]!.title = 'Unmatched heading';
  assert.match(validator.validateText(JSON.stringify(semantic)).errors.join(' '), /title must match/);
  const options = Object.defineProperty({}, 'complete', {
    get() { throw new Error('Unexpected validation failure'); }
  });
  assert.throws(() => validator.validateText(JSON.stringify(fixture('faq')), options),
    /Unexpected validation failure/);
});

test('icons follow the website policy: Iconify URLs or registry names, nothing else', () => {
  const check = (mutate: (data: any) => void) => {
    const records = fixture('foundation');
    mutate(records[0]!.data);
    return validator.validateRecords(records).ok;
  };
  const iconify = 'https://api.iconify.design/lucide/book.svg';
  assert.equal(check(() => {}), true);
  assert.equal(check(data => { data.navigation.tabs[0].icon = iconify; }), true, 'Tab Iconify URL');
  assert.equal(check(data => { data.navigation.tabs[0].icon = iconify + '?color=%23ff0000'; }), true, 'Colored Iconify URL');
  assert.equal(check(data => { data.navigation.entries[0].icon = iconify; }), true, 'Entry icons are supported');
  assert.equal(check(data => { data.navigation.tabs[0].icon = 'http://api.iconify.design/lucide/book.svg'; }), false);
  assert.equal(check(data => { data.navigation.tabs[0].icon = 'https://example.com/icon.svg'; }), false, 'Generic HTTPS is not an icon');
  assert.equal(check(data => { data.navigation.entries[0].icon = 'javascript:alert(1)'; }), false);
  assert.equal(check(data => { data.icons = { book: 'https://evil.example/x.svg' }; }), false, 'Registry must point to Iconify');
});

test('v2 dynamic snapshots validate; v1 still validates; mixed snapshots are rejected everywhere', () => {
  const v2 = readJSON('contract/examples/v2-catalog.json');
  const handbook = readJSON('contract/examples/v2-handbook.json');
  const v1 = readJSON('contract/examples/complete.json');
  for (const snapshot of [v2, handbook]) {
    const result = validator.validateRecords(snapshot, { complete: true });
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.format, 2);
    assert.ok(result.revisions.every((item: { format: number }) => item.format === 2));
  }
  const legacy = validator.validateRecords(v1, { complete: true });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.format, 1);
  for (const mixed of [[v1[0], v2[1]], [v2[0], v1[1]], [...v2, v1[1]]]) {
    const result = validator.validateRecords(mixed);
    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.code, 'MIXED_SNAPSHOT');
  }
  const broken = clone(v2);
  broken[1].data.value = '<script>';
  assert.equal(validator.validateRecords(broken).ok, false, 'Article value must be a JSON object');
  const missing = clone(v2).filter((record: { key: string }) => record.key !== v2[1].key);
  assert.equal(validator.validateRecords(missing, { complete: true }).ok, false, 'Navigation entries must point to records in the snapshot');
  const undeclared = clone(v2);
  undeclared[1].page = 'not-declared';
  undeclared[1].key = 'not-declared/' + undeclared[1].data.id;
  assert.equal(validator.validateRecords(undeclared, { complete: true }).ok, false, 'Articles must belong to a declared section');
});

test('signed receipts carry the content format and v1 never receives a receipt', () => {
  const service = validator.createValidationService('test-only-signing-key-0123456789abcdef');
  const v2 = readJSON('contract/examples/v2-catalog.json');
  const v1 = readJSON('contract/examples/complete.json');
  const articles = service.records({ records: v2.slice(1) });
  assert.equal(articles.ok, true);
  assert.ok(articles.receipts.every(receipt => receipt.format === 2));
  const snapshot = service.snapshot(v2[0], articles.receipts.map(receipt => receipt.token));
  assert.equal(snapshot.ok, true, snapshot.errors.join('; '));
  assert.equal(snapshot.format, 2);
  const legacy = service.records({ records: v1.slice(1, 3) });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.receipts.length, 0, 'v1 content cannot be signed, so it can never enter a v2 snapshot');
  assert.equal(legacy.issues.at(-1)?.code, 'LEGACY_FORMAT');
});
