(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./documentation-model'), require('node:crypto').webcrypto, require('./documentation-discovery'));
  else root.DOCS_ENGINE = factory(root.DOCS_MODEL, root.crypto, root.DOCS_DISCOVERY);
})(typeof window === 'object' ? window : globalThis, function (model, crypto, discovery) {
  'use strict';
  async function hash(payload) {
    const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function pointer(value) {
    if (!value) return;
    if (!/^[a-f0-9-]{36}$/.test(value.releaseId) || !Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error('Invalid environment pointer');
  }
  function release(value, environment) {
    if (!value || value.schema !== 1 || value.environment !== environment ||
        !['import', 'apply', 'promote', 'rollback'].includes(value.operation) ||
        typeof value.actor !== 'string' || !value.actor ||
        typeof value.base !== 'string' || typeof value.sourceRelease !== 'string' ||
        !['', ...model.environments].includes(value.source)) throw new Error('Invalid release');
    const fields = ['schema', 'environment', 'version', 'tags', 'summary', 'actor', 'base',
      'operation', 'source', 'sourceRelease', 'rollbackRelease', 'manifest', 'createdAt'];
    if ('areaChanges' in value) fields.push('areaChanges');
    if (Object.keys(value).sort().join() !== fields.sort().join() ||
        value.actor.length > 254 || (value.base !== '' && !/^[a-f0-9-]{36}$/.test(value.base))) throw new Error('Invalid release envelope');
    if (value.operation === 'import' && (environment !== 'development' || value.base !== '')) throw new Error('Invalid bootstrap release');
    if (value.operation === 'promote') {
      if (!['development:beta', 'development:production', 'beta:production'].includes(value.source + ':' + environment) ||
          !/^[a-f0-9-]{36}$/.test(value.sourceRelease)) throw new Error('Invalid promotion release');
    } else if (value.source !== '' || value.sourceRelease !== '') throw new Error('Unexpected promotion source');
    if ((value.operation === 'rollback' && !/^[a-f0-9-]{36}$/.test(value.rollbackRelease)) ||
        (value.operation !== 'rollback' && value.rollbackRelease !== '')) throw new Error('Invalid rollback release');
    model.metadata(value);
    const manifest = model.manifest(JSON.parse(value.manifest));
    if ('areaChanges' in value) {
      if (typeof value.areaChanges !== 'string' || new TextEncoder().encode(value.manifest + value.areaChanges).length > 900000) throw new Error('Release metadata exceeds safety bound');
      model.areaChanges(JSON.parse(value.areaChanges), manifest);
    }
    return manifest;
  }
  async function open(adapter, environment) {
    model.environment(environment);
    const head = await adapter.get('documentationEnvironments/' + environment);
    pointer(head?.data);
    if (!head) return { environment, head: null, release: null, records: [], manifest: {}, areaChanges: {} };
    const id = head.data.releaseId;
    const stored = await adapter.get('documentationReleases/' + id);
    const manifest = release(stored?.data, environment);
    const areaChanges = JSON.parse(stored.data.areaChanges || '{}');
    Object.values(areaChanges).forEach(change => {
      if (change.releaseId === id && (change.actor !== stored.data.actor || change.version !== stored.data.version ||
          change.previousRelease === id)) throw new Error('Area audit identity/version mismatch');
    });
    return { environment, head, release: stored.data, records: [], manifest, areaChanges };
  }
  async function readRecords(adapter, manifest, keys) {
    const batch = keys.map(key => [key, manifest[key]]);
    if (batch.some(([, revision]) => !revision)) throw new Error('Area is not published in this release');
    const snapshots = adapter.getMany && keys.length > 1
      ? await adapter.getMany(batch.map(([, revision]) => 'documentationRevisions/' + revision))
      : await Promise.all(batch.map(([, revision]) => adapter.get('documentationRevisions/' + revision)));
    if (!Array.isArray(snapshots) || snapshots.length !== batch.length) throw new Error('Incomplete documentation batch');
    return Promise.all(batch.map(async ([key, revision], index) => {
      const snapshot = snapshots[index];
      if (!snapshot || snapshot.data.schema !== 1 || snapshot.data.key !== key || typeof snapshot.data.payload !== 'string' ||
          await hash(snapshot.data.payload) !== revision) throw new Error('Missing or corrupted documentation revision: ' + key);
      const item = model.record(JSON.parse(snapshot.data.payload));
      if (item.key !== key || snapshot.data.title !== item.title) throw new Error('Revision locator/title does not match manifest: ' + key);
      return item;
    }));
  }
  async function load(adapter, environment, progress = () => {}) {
    const snapshot = await open(adapter, environment);
    if (!snapshot.head) return snapshot;
    const entries = Object.keys(snapshot.manifest), records = snapshot.records;
    const batchSize = adapter.getMany ? 90 : 12;
    progress(0, entries.length);
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      const batch = entries.slice(offset, offset + batchSize);
      records.push(...await readRecords(adapter, snapshot.manifest, batch));
      progress(records.length, entries.length);
    }
    model.assemble(records);
    return snapshot;
  }
  function expected(snapshot, id) {
    if (typeof id !== 'string' || id !== (snapshot.head?.data.releaseId || 'empty')) throw new Error('Conflict: environment changed. Read and review the latest release before writing.');
  }
  async function stageEnvironment(adapter, snapshot, progress = () => {}) {
    const environment = model.environment(snapshot.environment), manifest = model.manifest(snapshot.manifest);
    const entries = Object.entries(manifest);
    const batched = adapter.environmentBatches === true && typeof adapter.getMany === 'function';
    const batchSize = batched ? 90 : 12;
    let completed = 0;
    progress(0, entries.length);
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      const batch = entries.slice(offset, offset + batchSize);
      const locators = batch.map(([, revision]) => 'documentationEnvironments/' + environment + '/revisions/' + revision);
      const snapshots = batched ? await Promise.all([
        adapter.getMany(batch.map(([, revision]) => 'documentationRevisions/' + revision)),
        adapter.getMany(locators)
      ]) : null;
      if (snapshots && snapshots.some(values => !Array.isArray(values) || values.length !== batch.length)) throw new Error('Incomplete environment batch');
      let next = 0, failed = false, failure;
      // Drain in-flight copies before exposing an error so a retry cannot overlap unfinished workers.
      await Promise.all(Array.from({ length: Math.min(12, batch.length) }, async () => {
        try {
          while (!failed && next < batch.length) {
            const index = next++;
            const [key, revision] = batch[index];
            const original = snapshots ? snapshots[0][index] : await adapter.get('documentationRevisions/' + revision), data = original?.data;
            if (!data || Object.keys(data).sort().join() !== 'key,payload,schema,title' ||
                data.schema !== 1 || data.key !== key || typeof data.payload !== 'string' ||
                await hash(data.payload) !== revision) throw new Error('Missing or corrupted documentation revision: ' + key);
            const record = model.record(JSON.parse(data.payload));
            if (record.key !== key || record.title !== data.title) throw new Error('Revision locator/title does not match manifest: ' + key);
            const locator = locators[index];
            const previous = snapshots ? snapshots[1][index] : await adapter.get(locator);
            if (!previous) await adapter.create(locator, data);
            const stored = previous || await adapter.get(locator);
            if (!stored || !discovery.equal(stored.data, data)) throw new Error('Environment revision conflict: ' + key);
            progress(++completed, entries.length);
          }
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }));
      if (failed) throw failure;
    }
    return { environment, count: entries.length };
  }
  async function publish(adapter, options) {
    if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw new Error('onProgress must be a function');
    const progress = (stage, completed, total, environment = options.environment, releaseId) => {
      if (options.onProgress) options.onProgress({ stage, environment, completed, total, ...(releaseId ? { releaseId } : {}) });
    };
    const loadProgress = async (stage, environment) => {
      progress(stage, 0, 0, environment);
      return load(adapter, environment, (completed, total) => progress(stage, completed, total, environment));
    };
    model.environment(options.environment);
    model.metadata(options);
    if (!['apply', 'promote', 'rollback'].includes(options.operation)) throw new Error('Invalid operation');
    if (Object.hasOwn(options, 'remove') && options.operation !== 'apply') throw new Error('Explicit removals are supported only by apply');
    if (options.operation === 'promote' && Object.hasOwn(options, 'selected')) throw new Error('Promotion requires a full source snapshot; selected is not supported');
    if (typeof options.actor !== 'string' || !options.actor || options.actor.length > 254) throw new Error('Explicit authenticated actor required');
    if (typeof options.expected !== 'string' || (options.expected !== 'empty' && !/^[a-f0-9-]{36}$/.test(options.expected))) throw new Error('Conflict: explicit expected release ID or empty required');
    const target = await loadProgress('load-target', options.environment);
    expected(target, options.expected);
    let records, source = null, restoredChanges = null, restoredManifest = null;
    if (options.operation === 'promote') {
      if (!['development:beta', 'development:production', 'beta:production'].includes(options.source + ':' + options.environment)) throw new Error('Only Development→Beta/Production and Beta→Production are allowed');
      source = await loadProgress('load-source', options.source);
      expected(source, options.expectedSource);
      if (!source.head) throw new Error('Source is not published');
      const review = model.fullReview(source.records, target.records);
      if (review.missing.length && options.acknowledgeMissing !== true) throw new Error('Unpublished outgoing links require explicit acknowledgement: ' + review.missing.join(', '));
      records = review.records;
    } else if (options.operation === 'rollback') {
      if (!/^[a-f0-9-]{36}$/.test(options.rollbackRelease || '')) throw new Error('Choose an immutable release to roll back to');
      const previous = await adapter.get('documentationReleases/' + options.rollbackRelease);
      const manifest = release(previous?.data, options.environment);
      restoredManifest = manifest;
      restoredChanges = JSON.parse(previous.data.areaChanges || '{}');
      records = [];
      const historical = Object.entries(manifest);
      progress('load-source', 0, historical.length);
      for (const [key, revision] of historical) {
        const stored = await adapter.get('documentationRevisions/' + revision);
        if (!stored || await hash(stored.data.payload) !== revision) throw new Error('Rollback revision unavailable: ' + key);
        records.push(model.record(JSON.parse(stored.data.payload)));
        progress('load-source', records.length, historical.length);
      }
    } else {
      if (!Array.isArray(options.records) || !options.records.length) throw new Error('Explicit structured records required');
      options.records.forEach(model.record);
      if (new Set(options.records.map(item => item.key)).size !== options.records.length) throw new Error('Duplicate record keys');
      const merged = new Map(target.records.map(item => [item.key, item]));
      if (options.remove !== undefined) {
        if (!Array.isArray(options.remove) || new Set(options.remove).size !== options.remove.length ||
            options.remove.some(key => typeof key !== 'string' || key === 'foundation' || !merged.has(key) ||
              options.records.some(item => item.key === key))) {
          throw new Error('Remove only unique existing article keys, never foundation or records being replaced');
        }
        options.remove.forEach(key => merged.delete(key));
      }
      options.records.forEach(item => merged.set(item.key, item));
      records = [...merged.values()];
    }
    model.assemble(records);
    model.navigationRecords(records);
    if (options.operation === 'apply' && options.remove?.length) {
      const navigation = records.find(item => item.key === 'foundation').data.navigation;
      if (navigation.entries.some(entry => options.remove.includes(entry.key))) {
        throw new Error('Remove deleted articles from foundation.navigation in the same plan');
      }
      const incoming = model.fullReview(records, target.records).missing.filter(key => options.remove.includes(key));
      if (incoming.length && options.acknowledgeMissing !== true) {
        throw new Error('Removing referenced articles requires explicit acknowledgement: ' + incoming.join(', '));
      }
    }
    const manifest = {};
    let prepared = 0;
    progress('prepare', 0, records.length);
    for (const item of records) {
      const payload = model.json(item);
      const unchanged = target.records.find(previous => previous.key === item.key);
      const id = source ? source.manifest[item.key] : restoredManifest ? restoredManifest[item.key]
        : unchanged && model.json(unchanged) === payload ? target.manifest[item.key] : await hash(payload);
      manifest[item.key] = id;
      if (target.manifest[item.key] !== id && source?.manifest[item.key] !== id && restoredManifest?.[item.key] !== id) {
        await adapter.create('documentationRevisions/' + id, { schema: 1, key: item.key, title: item.title, payload });
      }
      progress('prepare', ++prepared, records.length);
    }
    model.manifest(manifest);
    const id = crypto.randomUUID();
    const stats = model.fullReview(records, target.records).stats;
    const areaChanges = restoredChanges || Object.fromEntries(Object.entries(target.areaChanges).filter(([key]) => manifest[key]));
    if (!restoredChanges) {
      const selected = options.operation === 'promote' ? Object.keys(manifest) : options.records.map(item => item.key);
      if (options.areaChanges && (typeof options.areaChanges !== 'object' || Array.isArray(options.areaChanges) ||
          Object.keys(options.areaChanges).some(key => !selected.includes(key)))) throw new Error('Area metadata must refer only to selected records');
      for (const key of selected) {
        if (options.operation === 'promote' && target.manifest[key] === manifest[key] && !Object.hasOwn(options.areaChanges || {}, key)) continue;
        const fields = options.areaChanges?.[key] || options;
        model.metadata({ ...fields, version: options.version });
        areaChanges[key] = { before: target.manifest[key] || '', after: manifest[key],
          version: options.version, tags: fields.tags, summary: fields.summary, actor: options.actor,
          releaseId: id, previousRelease: target.areaChanges[key]?.releaseId || '' };
      }
    }
    model.areaChanges(areaChanges, manifest);
    const data = {
      schema: 1, environment: options.environment, version: options.version,
      tags: options.tags, summary: options.summary, actor: options.actor,
      base: target.head?.data.releaseId || '', operation: options.operation,
      source: source?.environment || '', sourceRelease: source?.head.data.releaseId || '',
      rollbackRelease: options.operation === 'rollback' ? options.rollbackRelease : '',
      manifest: model.json(manifest), areaChanges: model.json(areaChanges), createdAt: adapter.timestamp()
    };
    release(data, options.environment);
    await stageEnvironment(adapter, { environment: options.environment, manifest },
      (completed, total) => progress('environment', completed, total));
    progress('discovery', 0, 1);
    await discovery.stage(adapter, records, manifest, hash);
    progress('discovery', 1, 1);
    progress('release', 0, 1);
    await adapter.create('documentationReleases/' + id, data);
    progress('release', 1, 1);
    // Only the pointer is public state: staged immutable objects never modify an existing release.
    progress('activate', 0, 1, options.environment, id);
    await adapter.advance(target, source, id);
    progress('activate', 1, 1, options.environment, id);
    progress('complete', 1, 1, options.environment, id);
    return { releaseId: id, count: records.length, stats };
  }
  async function areaHistory(adapter, snapshot, key, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('History limit must be 1–100');
    const result = [], seen = new Set();
    let change = snapshot.areaChanges[key];
    while (change && result.length < limit) {
      if (seen.has(change.releaseId)) throw new Error('Cyclic area history');
      seen.add(change.releaseId);
      const stored = await adapter.get('documentationReleases/' + change.releaseId);
      release(stored?.data, snapshot.environment);
      const own = JSON.parse(stored.data.areaChanges || '{}')[key];
      if (JSON.stringify(own) !== JSON.stringify(change) || own.actor !== stored.data.actor ||
          own.version !== stored.data.version) throw new Error('Area history provenance mismatch');
      result.push({ ...change, operation: stored.data.operation, createdAt: stored.data.createdAt });
      if (!change.previousRelease) break;
      const previous = await adapter.get('documentationReleases/' + change.previousRelease);
      release(previous?.data, snapshot.environment);
      const old = JSON.parse(previous.data.areaChanges || '{}')[key];
      if (!old || old.releaseId !== change.previousRelease || old.after !== change.before) throw new Error('Missing or inconsistent area history');
      change = old;
    }
    return result;
  }
  return { hash, open, readRecords, load, publish, pointer, release, expected, areaHistory, stageEnvironment, discovery };
});
