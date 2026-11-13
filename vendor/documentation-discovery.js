(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./documentation-model'));
  else root.DOCS_DISCOVERY = factory(root.DOCS_MODEL);
})(typeof window === 'object' ? window : globalThis, function (model) {
  'use strict';
  const digest = /^[a-f0-9]{64}$/;
  const size = text => new TextEncoder().encode(text).length;
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  function equal(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
  function manifestKeys(manifest) { return Object.keys(manifest).sort((a, b) => a.localeCompare(b, 'en')); }
  function fail(message) { throw new Error('Invalid documentation discovery: ' + message); }
  function exact(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join() !== fields.slice().sort().join()) fail('unexpected fields');
  }
  function words(text) {
    return [...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]{2,64}/gu) || [])];
  }
  function strings(value, result = []) {
    if (typeof value === 'string') result.push(value);
    else if (Array.isArray(value)) value.forEach(item => strings(item, result));
    else if (value && typeof value === 'object') Object.keys(value).sort().forEach(key => strings(value[key], result));
    return result;
  }
  function validateEnvelope(path, value) {
    const parts = path.split('/');
    if (parts[0] !== 'documentationDiscovery' || !digest.test(parts[1])) fail('invalid path');
    if (parts.length === 2) {
      exact(value, ['schema', 'manifestHash', 'count', 'shards']);
      if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 2000 ||
          !Array.isArray(value.shards) || !value.shards.length || value.shards.length > 100) fail('invalid catalog');
      let count = 0;
      value.shards.forEach((shard, index) => {
        exact(shard, ['id', 'hash', 'count']);
        if (shard.id !== String(index).padStart(4, '0') || !digest.test(shard.hash) ||
            !Number.isSafeInteger(shard.count) || shard.count < 1 || shard.count > 40) fail('invalid shard descriptor');
        count += shard.count;
      });
      if (count !== value.count) fail('catalog count mismatch');
    } else if (parts.length === 4 && parts[2] === 'shards' && /^\d{4}$/.test(parts[3])) {
      exact(value, ['schema', 'manifestHash', 'index', 'payload']);
      if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index > 99 ||
          parts[3] !== String(value.index).padStart(4, '0') ||
          typeof value.payload !== 'string' || !value.payload || size(value.payload) > 200000) fail('invalid shard');
    } else fail('invalid path');
    if (value.schema !== 1 || value.manifestHash !== parts[1]) fail('manifest identity mismatch');
    return value;
  }
  async function identity(manifest, hash) {
    model.manifest(manifest);
    return hash(model.json(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b, 'en')))));
  }
  async function build(records, manifest, hash) {
    model.manifest(manifest);
    if (records.length !== Object.keys(manifest).length || new Set(records.map(item => item.key)).size !== records.length ||
        records.some(item => !manifest[item.key])) fail('records must cover the exact manifest');
    const incoming = new Map(records.map(item => [item.key, []]));
    const outgoing = new Map(records.map(item => [item.key, model.links(item)]));
    records.forEach(item => outgoing.get(item.key).forEach(key => incoming.get(key)?.push(item.key)));
    const entries = records.map(item => {
      const data = item.key === 'foundation'
        ? Object.fromEntries(Object.entries(item.data).filter(([key]) => key !== 'navigation'))
        : item.data;
      const texts = strings(data);
      const summary = [data.summary, data.what?.simple, data.simple, data.description, data.answer, data.a,
        data.message, data.controls, ...texts].find(value => typeof value === 'string' && value.trim()) || item.title;
      // Bounded discovery hints, not a full-text copy or a claim of semantic completeness.
      const terms = words([item.title, item.key, ...texts].join(' '));
      return { key: item.key, revision: manifest[item.key], title: item.title, page: item.page,
        summary: summary.replace(/\s+/g, ' ').trim().slice(0, 320),
        terms: terms.slice(0, 128), termsTruncated: terms.length > 128,
        outgoing: outgoing.get(item.key), incoming: incoming.get(item.key).sort() };
    }).sort((a, b) => a.key.localeCompare(b.key, 'en'));
    const keys = manifestKeys(manifest), positions = new Map(keys.map((key, index) => [key, index]));
    const encode = links => links.map(key => positions.has(key) ? positions.get(key) : key);
    const manifestHash = await identity(manifest, hash), chunks = [];
    let batch = [];
    for (const item of entries) {
      const entry = { ...item, outgoing: encode(item.outgoing), incoming: encode(item.incoming) };
      if (batch.length && (batch.length === 40 || size(JSON.stringify([...batch, entry])) > 180000)) {
        chunks.push(batch); batch = [];
      }
      batch.push(entry);
      if (size(JSON.stringify(batch)) > 200000) fail('entry exceeds shard safety limit');
    }
    if (batch.length) chunks.push(batch);
    const shards = await Promise.all(chunks.map(async (chunk, index) => {
      const payload = JSON.stringify(chunk);
      return { id: String(index).padStart(4, '0'), hash: await hash(payload), count: chunk.length,
        data: { schema: 1, manifestHash, index, payload } };
    }));
    const root = { schema: 1, manifestHash, count: entries.length,
      shards: shards.map(({ id, hash: value, count }) => ({ id, hash: value, count })) };
    const path = 'documentationDiscovery/' + manifestHash;
    validateEnvelope(path, root);
    shards.forEach(shard => validateEnvelope(path + '/shards/' + shard.id, shard.data));
    return { path, root, shards };
  }
  async function stage(adapter, records, manifest, hash) {
    const catalog = await build(records, manifest, hash);
    const documents = catalog.shards.map(shard => [catalog.path + '/shards/' + shard.id, shard.data]);
    // Root is staged last; a failed build can never advertise incomplete shards.
    for (let offset = 0; offset < documents.length; offset += 4) {
      const group = documents.slice(offset, offset + 4);
      await Promise.all(group.map(async ([path, data]) => {
        const previous = await adapter.get(path);
        if (previous) {
          if (!equal(previous.data, data)) fail('immutable catalog conflict');
        } else await adapter.create(path, data);
      }));
    }
    const previous = await adapter.get(catalog.path);
    if (previous) {
      if (!equal(previous.data, catalog.root)) fail('immutable catalog conflict');
    } else await adapter.create(catalog.path, catalog.root);
    return catalog.root;
  }
  function entry(value, manifest) {
    exact(value, ['key', 'revision', 'title', 'page', 'summary', 'terms', 'termsTruncated', 'outgoing', 'incoming']);
    if (typeof value.key !== 'string' || !Object.hasOwn(manifest, value.key) || value.revision !== manifest[value.key] ||
        typeof value.title !== 'string' || !value.title || value.title.length > 256 ||
        value.page !== (value.key === 'foundation' ? 'foundation' : value.key.split('/')[0]) ||
        typeof value.summary !== 'string' || value.summary.length > 320 ||
        typeof value.termsTruncated !== 'boolean' || !Array.isArray(value.terms) || value.terms.length > 128 ||
        value.terms.some(term => typeof term !== 'string' || words(term).length !== 1 || words(term)[0] !== term) ||
        !Array.isArray(value.outgoing) || !Array.isArray(value.incoming) ||
        [...value.outgoing, ...value.incoming].some(key => typeof key !== 'string' ||
          (key !== 'foundation' && !/^[a-z][a-z0-9-]{0,63}\/[a-zA-Z0-9_-]{1,120}$/.test(key)))) fail('invalid article entry');
    return value;
  }
  async function read(adapter, manifest, hash) {
    const manifestHash = await identity(manifest, hash), path = 'documentationDiscovery/' + manifestHash;
    const stored = await adapter.get(path);
    if (!stored) throw new Error('Discovery index is not built for this release. Run the approved index command; no full-content fallback was performed.');
    const root = validateEnvelope(path, stored.data), entries = [], keys = manifestKeys(manifest);
    function decode(links) {
      if (!Array.isArray(links)) fail('invalid adjacency list');
      return links.map(value => {
        if (typeof value === 'string' && !Object.hasOwn(manifest, value)) return value;
        if (!Number.isSafeInteger(value) || value < 0 || value >= keys.length) fail('invalid adjacency ordinal');
        return keys[value];
      });
    }
    const batchSize = adapter.getDiscoveryShards ? 90 : 4;
    for (let offset = 0; offset < root.shards.length; offset += batchSize) {
      const descriptors = root.shards.slice(offset, offset + batchSize);
      const locations = descriptors.map(shard => path + '/shards/' + shard.id);
      const snapshots = adapter.getDiscoveryShards ? await adapter.getDiscoveryShards(locations)
        : await Promise.all(locations.map(location => adapter.get(location)));
      if (!Array.isArray(snapshots) || snapshots.length !== descriptors.length) fail('incomplete shard batch');
      const groups = await Promise.all(descriptors.map(async (shard, index) => {
        const location = locations[index], result = snapshots[index];
        if (!result) fail('missing shard');
        const data = validateEnvelope(location, result.data);
        if (await hash(data.payload) !== shard.hash) fail('corrupt shard');
        const values = JSON.parse(data.payload);
        if (!Array.isArray(values) || values.length !== shard.count) fail('shard count mismatch');
        return values.map(value => entry({ ...value, outgoing: decode(value.outgoing), incoming: decode(value.incoming) }, manifest));
      }));
      entries.push(...groups.flat());
    }
    if (entries.length !== root.count || root.count !== Object.keys(manifest).length ||
        new Set(entries.map(value => value.key)).size !== entries.length) fail('incomplete manifest coverage');
    const expectedIncoming = new Map(entries.map(item => [item.key, []]));
    entries.forEach(item => item.outgoing.forEach(key => expectedIncoming.get(key)?.push(item.key)));
    entries.forEach(item => {
      if (JSON.stringify(item.incoming) !== JSON.stringify(expectedIncoming.get(item.key).sort())) fail('inconsistent backlinks');
    });
    return { manifestHash, entries, shards: root.shards.length };
  }
  function search(entries, query, limit = 20) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('provide a query and limit 1–100');
    const terms = words(query);
    if (!terms.length) fail('query requires searchable words');
    return entries.map(item => {
      const heading = (item.title + ' ' + item.key).normalize('NFKC').toLowerCase();
      const summary = item.summary.normalize('NFKC').toLowerCase();
      const matched = terms.filter(term => heading.includes(term) || summary.includes(term) || item.terms.some(word => word.includes(term)));
      const score = matched.reduce((total, term) => total + (heading.includes(term) ? 5 : summary.includes(term) ? 3 : 1), 0);
      return { ...item, score, matchedTerms: matched };
    }).filter(item => item.score).sort((a, b) => b.matchedTerms.length - a.matchedTerms.length ||
      b.score - a.score || a.key.localeCompare(b.key, 'en')).slice(0, limit);
  }
  return { words, equal, validateEnvelope, identity, build, stage, read, search };
});
