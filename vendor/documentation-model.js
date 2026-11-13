(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./documentation-schema') : root.DOCS_SCHEMA);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DOCS_MODEL = api;
})(typeof window === 'object' ? window : globalThis, function (schema) {
  'use strict';
  const environments = ['development', 'beta', 'production'];
  const collections = {
    features: 'features', apps: 'applications', flows: 'flows', 'data-model': 'tables',
    api: 'endpoints', events: 'events', services: 'externalServices', errors: 'errors',
    notifications: 'notifications', config: 'config', troubleshooting: 'troubleshooting',
    faq: 'faq', glossary: 'glossary'
  };
  const aliases = { feature: 'features', app: 'apps', flow: 'flows', table: 'data-model',
    api: 'api', event: 'events', svc: 'services', error: 'errors', notif: 'notifications',
    config: 'config', trouble: 'troubleshooting', faq: 'faq', glossary: 'glossary',
    role: 'foundation', backend: 'backend' };
  const idPattern = /^[a-zA-Z0-9_-]{1,120}$/;
  const revisionPattern = /^[a-f0-9]{64}$/;
  const pages = ['home', 'architecture', 'roles', 'backend', ...Object.keys(collections)];
  const icons = ['home', 'layers', 'grid', 'flow', 'book', 'database', 'terminal', 'clock', 'globe', 'users', 'alert', 'bell', 'sliders', 'tool', 'help', 'shield', 'search', 'arrow', 'file', 'info', 'lock', 'plane'];
  function iconUrl(value) {
    return typeof value === 'string' && value.length <= 256 && !/\s/.test(value) &&
      /^https:\/\/api\.iconify\.design\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.svg(?:\?color=%23[0-9a-fA-F]{6})?$/.test(value);
  }
  function iconReference(value) {
    return iconUrl(value) || typeof value === 'string' && !/\s/.test(value) && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  }
  function iconAssets(data) {
    if (data.icons !== undefined) {
      if (!data.icons || typeof data.icons !== 'object' || Array.isArray(data.icons) ||
          !Object.keys(data.icons).length || Object.keys(data.icons).length > 128 ||
          Object.entries(data.icons).some(([name, url]) => /\s/.test(name) || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || !iconUrl(url))) {
        fail('icons must map names to trusted HTTPS Iconify SVG URLs');
      }
    }
    function reference(value) {
      if (!iconReference(value)) fail('invalid icon reference');
      if (data.icons && !iconUrl(value) && !Object.hasOwn(data.icons, value)) fail('icon reference missing from foundation.icons: ' + value);
    }
    if (data.navigation) {
      [...data.navigation.tabs, ...data.navigation.groups].forEach(item => reference(item.icon));
      data.navigation.entries.filter(item => item.icon !== undefined).forEach(item => reference(item.icon));
    }
    if (data.home?.quickLinks !== undefined && !Array.isArray(data.home.quickLinks)) fail('home.quickLinks must be an array');
    (data.home?.quickLinks || []).forEach(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid home quick link');
      if (item.icon !== undefined) reference(item.icon);
    });
  }
  function navigation(value, foundation) {
    if (schema.isDynamic(foundation)) return schema.navigation(value, foundation);
    exact(value, ['tabs', 'groups', 'entries']);
    const tabs = new Map(), groups = new Map(), entries = new Set(), routes = new Set();
    function common(item) {
      if (typeof item.id !== 'string' || !idPattern.test(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 256 ||
          !Number.isSafeInteger(item.order) || typeof item.visible !== 'boolean') fail('invalid navigation item');
    }
    if (![value.tabs, value.groups, value.entries].every(Array.isArray) || value.tabs.length > 40 ||
        value.groups.length > 200 || value.entries.length > 2500) fail('invalid navigation collections');
    value.tabs.forEach(tab => {
      exact(tab, ['id', 'label', 'overviewLabel', 'icon', 'href', 'order', 'visible']);
      common(tab);
      if (!pages.includes(tab.id) || tabs.has(tab.id) || !iconReference(tab.icon) ||
          tab.href !== (tab.id === 'home' ? '#/' : '#/' + tab.id) ||
          typeof tab.overviewLabel !== 'string' || !tab.overviewLabel.trim() || tab.overviewLabel.length > 256) fail('invalid navigation tab');
      tabs.set(tab.id, tab);
    });
    value.groups.forEach(group => {
      exact(group, ['id', 'tab', 'label', 'icon', 'order', 'visible']);
      common(group);
      if (!tabs.has(group.tab) || groups.has(group.id) || !iconReference(group.icon)) fail('invalid navigation group');
      groups.set(group.id, group);
    });
    value.entries.forEach(entry => {
      exact(entry, ['id', 'tab', 'group', 'key', 'label', 'href', 'order', 'visible', 'searchable', ...(entry.icon !== undefined ? ['icon'] : [])]);
      common(entry);
      if (entry.icon !== undefined && !iconReference(entry.icon)) fail('invalid navigation entry icon');
      if (entries.has(entry.id) || routes.has(entry.href) || !tabs.has(entry.tab) ||
          (entry.group !== '' && groups.get(entry.group)?.tab !== entry.tab) ||
          typeof entry.searchable !== 'boolean' ||
          typeof entry.href !== 'string' || !new RegExp('^#/' + entry.tab + '/[a-zA-Z0-9_-]{1,120}$').test(entry.href)) fail('invalid navigation entry');
      const id = entry.href.split('/')[2];
      if (entry.key !== areaKey(entry.tab, id)) fail('navigation locator mismatch');
      entries.add(entry.id);
      routes.add(entry.href);
    });
    const keys = value.entries.filter(entry => entry.key !== 'foundation').map(entry => entry.key);
    if (new Set(keys).size !== keys.length) fail('duplicate navigation article');
    json(value);
    return value;
  }
  function navigationRecords(records, required = true, manifest = {}) {
    const foundation = records.find(item => item.key === 'foundation')?.data;
    const nav = foundation?.navigation;
    if (new Set(records.map(item => item.key)).size !== records.length) fail('duplicate article keys');
    if (schema.isDynamic(foundation)) {
      schema.foundation(foundation);
      records.filter(item => item.key !== 'foundation').forEach(item => {
        if (!schema.isDynamic(item.data)) fail('legacy article in v2 documentation');
        schema.entity(item);
        if (schema.section(foundation, item.page)?.collection !== item.collection) fail('section collection mismatch');
      });
      Object.keys(manifest).filter(key => key !== 'foundation').forEach(key => {
        if (!schema.section(foundation, key.split('/')[0])) fail('published section missing configuration');
      });
    } else if (records.some(item => item.key !== 'foundation' && schema.isDynamic(item.data))) fail('generic article requires v2 foundation');
    if (!nav) { if (required) fail('foundation.navigation is required before publication'); return; }
    navigation(nav, foundation);
    const keys = new Set(nav.entries.map(entry => entry.key));
    records.forEach(item => { if (item.key !== 'foundation' && !keys.has(item.key)) fail('add article to foundation.navigation: ' + item.key); });
    Object.keys(manifest).forEach(key => { if (key !== 'foundation' && !keys.has(key)) fail('published article missing navigation metadata: ' + key); });
  }
  function ordered(items) { return items.slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
  function navigationEntries(nav, manifest, tab) {
    if (!nav) return [];
    return ordered(nav.entries.filter(entry => (!tab || entry.tab === tab) &&
      nav.tabs.some(item => item.id === entry.tab && item.visible) && entry.visible &&
      (!entry.group || nav.groups.some(group => group.id === entry.group && group.visible)) &&
      (entry.key === 'foundation' || manifest[entry.key])));
  }
  const copyKeys = ['hero', 'features', 'flows', 'lookup', 'lookupCard', 'flowCaption',
    'layers', 'folders', 'who', 'scenarioEmpty', 'rateLimits', 'backendSimple',
    'backendTech', 'backendScope', 'services', 'errors', 'troubleshooting', 'glossary', 'confirm'];
  function fail(message) { throw new Error('Invalid documentation: ' + message); }
  function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join() !== keys.slice().sort().join()) fail('unexpected fields');
  }
  function environment(value) {
    if (!environments.includes(value)) fail('environment must be development, beta or production');
    return value;
  }
  function metadata(value) {
    if (typeof value.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.version)) fail('a target version is required (1–64 safe characters)');
    if (!Array.isArray(value.tags) || !value.tags.length || value.tags.length > 3 ||
        new Set(value.tags).size !== value.tags.length || value.tags.some(tag => !['Hotfix', 'New', 'Changed'].includes(tag))) fail('select Hotfix, New and/or Changed');
    if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 4000) fail('difference summary is required (max 4000 characters)');
  }
  function json(value) {
    let count = 0;
    function visit(x, depth) {
      if (++count > 100000 || depth > 32) fail('content exceeds structural limits');
      if (x === null || typeof x === 'boolean') return;
      if (typeof x === 'number' && Number.isFinite(x)) return;
      if (typeof x === 'string') { if (x.length > 500000 || /\u0000/.test(x)) fail('invalid string'); return; }
      if (Array.isArray(x)) { x.forEach(y => visit(y, depth + 1)); return; }
      if (x && typeof x === 'object') {
        Object.keys(x).forEach(key => {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe property');
          visit(x[key], depth + 1);
        });
        return;
      }
      fail('content must be JSON, never executable code');
    }
    visit(value, 0);
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).length > 700000) fail('document exceeds 700 KB safety bound');
    return serialized;
  }
  function record(value) {
    exact(value, ['key', 'page', 'collection', 'title', 'data']);
    if (typeof value.title !== 'string' || !value.title || value.title.length > 256) fail('invalid title');
    if (value.key === 'foundation') {
      if (schema.isDynamic(value.data)) {
        if (value.page !== 'foundation' || value.collection !== '') fail('invalid foundation locator');
        schema.foundation(value.data); iconAssets(value.data); json(value); return value;
      }
      if (value.data?.schemaVersion !== undefined && value.data.schemaVersion !== 1) fail('unsupported schema version');
      if (value.page !== 'foundation' || value.collection !== '' || !value.data.meta ||
          typeof value.data.meta.appName !== 'string' || !value.data.copy) fail('missing foundation');
      if (['appName', 'subtitle', 'createdBy', 'updatedBy', 'updated'].some(key => typeof value.data.meta[key] !== 'string') ||
          copyKeys.some(key => typeof value.data.copy[key] !== 'string') ||
          !value.data.architecture || !Array.isArray(value.data.architecture.layers) || !Array.isArray(value.data.architecture.tree) ||
          !value.data.home || !value.data.roles) fail('incomplete shared overview schema');
      ['dataSources', 'confirm'].forEach(key => { if (!Array.isArray(value.data[key])) fail('missing shared collection: ' + key); });
      if (value.data.navigation) navigation(value.data.navigation);
      iconAssets(value.data);
    } else {
      if (schema.isDynamic(value.data)) { schema.entity(value); json(value); return value; }
      if (value.data?.schemaVersion !== undefined && value.data.schemaVersion !== 1) fail('unsupported schema version');
      const collection = collections[value.page] || (value.page === 'backend' && /^backend\.(services|databases|integrations|runbooks)$/.test(value.collection) && value.collection);
      if (collection !== value.collection || !idPattern.test(value.data?.id) ||
          value.key !== value.page + '/' + value.data.id) fail('invalid article locator');
      const label = { faq: 'q', glossary: 'term', errors: 'message', troubleshooting: 'title', api: 'path' }[value.page] || 'name';
      if (typeof value.data[label] !== 'string' || !value.data[label]) fail('missing article heading');
      const heading = value.data.name || value.data.title || value.data.term || value.data.q || value.data.message || (value.data.method + ' ' + value.data.path);
      if (value.title !== heading) fail('title must match the article heading');
      const arrays = {
        features: ['apps', 'services', 'endpoints', 'tables', 'events', 'config', 'dependsOn', 'json', 'rules', 'faq', 'refs', 'confirm'],
        flows: ['steps', 'related'], 'data-model': ['fields', 'backendTables', 'apps'],
        api: ['requestFields', 'responseFields', 'errors'], backend: ['columns', 'mappings']
      }[value.page] || [];
      arrays.forEach(key => { if (value.data[key] !== undefined && !Array.isArray(value.data[key])) fail('expected array: ' + key); });
    }
    json(value);
    return value;
  }
  function split(docs) {
    const foundation = JSON.parse(JSON.stringify(docs));
    const result = [];
    if (schema.isDynamic(docs)) {
      if (!Array.isArray(docs.records)) fail('v2 assembled documentation requires records array');
      const articles = docs.records.map(item => record(JSON.parse(JSON.stringify(item))));
      if (articles.some(item => item.key === 'foundation')) fail('records must contain only generic article envelopes');
      delete foundation.records;
      Object.values(collections).forEach(collection => { delete foundation[collection]; });
      delete foundation.backend;
      const records = [record({ key: 'foundation', page: 'foundation', collection: '', title: 'Overview, navigation and shared documentation', data: foundation }), ...articles];
      navigationRecords(records);
      return records;
    }
    function add(page, collection, items) {
      (items || []).forEach(item => result.push(record({
        key: page + '/' + item.id, page, collection,
        title: item.name || item.title || item.term || item.q || item.message || (item.method + ' ' + item.path), data: item
      })));
    }
    Object.entries(collections).forEach(([page, collection]) => {
      add(page, collection, docs[collection]); foundation[collection] = [];
    });
    ['services', 'databases', 'integrations', 'runbooks'].forEach(group => {
      add('backend', 'backend.' + group, docs.backend?.[group]);
      if (foundation.backend) foundation.backend[group] = [];
    });
    result.unshift(record({ key: 'foundation', page: 'foundation', collection: '', title: 'Overview, navigation and shared documentation', data: foundation }));
    if (new Set(result.map(item => item.key)).size !== result.length) fail('duplicate article keys');
    return result;
  }
  function assemble(records) {
    records.forEach(record);
    const foundation = records.find(item => item.key === 'foundation');
    if (!foundation) fail('published release has no foundation');
    navigationRecords(records, false);
    const docs = JSON.parse(JSON.stringify(foundation.data));
    Object.values(collections).forEach(collection => { docs[collection] = []; });
    docs.backend = { ...docs.backend };
    ['services', 'databases', 'integrations', 'runbooks'].forEach(group => { docs.backend[group] = []; });
    if (schema.isDynamic(docs)) {
      docs.records = records.filter(item => item.key !== 'foundation').map(item => JSON.parse(JSON.stringify(item)));
      return docs;
    }
    records.filter(item => item.key !== 'foundation').forEach(item => {
      const [a, b] = item.collection.split('.');
      (b ? docs[a][b] : docs[a]).push(JSON.parse(JSON.stringify(item.data)));
    });
    if (docs.navigation) Object.entries(collections).forEach(([page, collection]) => {
      const entries = ordered(docs.navigation.entries.filter(entry => entry.tab === page));
      docs[collection].sort((a, b) => entries.findIndex(entry => entry.key === page + '/' + a.id) - entries.findIndex(entry => entry.key === page + '/' + b.id));
    });
    if (docs.navigation) {
      docs.features.forEach(item => {
        const entry = docs.navigation.entries.find(entry => entry.key === 'features/' + item.id);
        item.group = docs.navigation.groups.find(group => group.id === entry?.group)?.label || '';
      });
      ['services', 'databases', 'integrations', 'runbooks'].forEach(group => {
        const order = ordered(docs.navigation.entries.filter(entry => entry.tab === 'backend')).map(entry => entry.key);
        docs.backend[group].sort((a, b) => order.indexOf('backend/' + a.id) - order.indexOf('backend/' + b.id));
      });
    }
    return docs;
  }
  function discoverable(docs, manifest, search = false) {
    const result = { ...docs, backend: { ...docs.backend } };
    const entries = navigationEntries(docs.navigation, manifest).filter(entry => !search || entry.searchable);
    const keys = new Set(entries.map(entry => entry.key));
    if (schema.isDynamic(docs)) result.records = (docs.records || []).filter(item =>
      keys.has(item.key) && schema.section(docs, item.page)?.visible !== false);
    Object.entries(collections).forEach(([page, collection]) => {
      result[collection] = (docs[collection] || []).filter(item => keys.has(page + '/' + item.id));
    });
    ['services', 'databases', 'integrations', 'runbooks'].forEach(group => {
      result.backend[group] = (docs.backend?.[group] || []).filter(item => keys.has('backend/' + item.id));
    });
    return result;
  }
  function links(item) {
    record(item);
    const content = { ...item.data };
    if (item.key === 'foundation') delete content.navigation;
    const targets = new Set(), text = JSON.stringify(content);
    if (schema.isDynamic(item.data)) {
      function explicit(value) {
        if (typeof value === 'string') {
          const route = /^#\/([a-z][a-z0-9-]{0,63})(?:\/([a-zA-Z0-9_-]{1,120}))?$/.exec(value);
          if (route) targets.add(route[2] ? route[1] + '/' + route[2] : 'foundation');
        } else if (Array.isArray(value)) value.forEach(explicit);
        else if (value && typeof value === 'object') Object.values(value).forEach(explicit);
      }
      explicit(content);
      targets.delete(item.key);
      return [...targets].sort();
    }
    for (const match of text.matchAll(/\[\[([a-z]+):([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const page = aliases[match[1]];
      if (page) targets.add(areaKey(page, match[2]));
    }
    for (const match of text.matchAll(/#\/([a-z][a-z0-9-]{0,63})(?:\/([a-zA-Z0-9_-]{1,120}))?/g)) {
      targets.add(schema.isDynamic(item.data) && match[2] ? match[1] + '/' + match[2] : areaKey(match[1], match[2]));
    }
    const fields = { dependsOn: 'features', related: 'features', features: 'features',
      endpoints: 'api', tables: 'data-model', events: 'events', config: 'config',
      apps: 'apps', services: 'services', app: 'apps', backendTables: 'data-model',
      errors: 'errors', faq: 'faq', troubleshooting: 'troubleshooting',
      notifications: 'notifications', flows: 'flows', glossary: 'glossary' };
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      Object.entries(value).forEach(([key, val]) => {
        if (fields[key]) (Array.isArray(val) ? val : [val]).forEach(id => {
          if (typeof id === 'string' && idPattern.test(id)) targets.add(fields[key] + '/' + id);
        });
        walk(val);
      });
    }
    if (!schema.isDynamic(item.data)) walk(content);
    targets.delete(item.key);
    return [...targets].sort();
  }
  function review(source, target, selected) {
    const sourceMap = new Map(source.map(item => [item.key, item]));
    const targetMap = new Map(target.map(item => [item.key, item]));
    if (!selected.length || new Set(selected).size !== selected.length) fail('select unique articles');
    selected.forEach(key => { if (!sourceMap.has(key)) fail('selected source is missing: ' + key); });
    const selectedSet = new Set(selected);
    const outgoing = new Set(selected.flatMap(key => links(sourceMap.get(key))));
    const incoming = source.filter(item => links(item).some(key => selectedSet.has(key))).map(item => item.key);
    const next = new Map(targetMap);
    selected.forEach(key => next.set(key, sourceMap.get(key)));
    if (!next.has('foundation')) fail('include the shared foundation when publishing an empty target');
    return {
      selected: selected.map(key => ({ key, changed: JSON.stringify(sourceMap.get(key)) !== JSON.stringify(targetMap.get(key)) })),
      outgoing: [...outgoing], incoming,
      missing: [...outgoing].filter(key => !next.has(key)),
      records: [...next.values()]
    };
  }
  function fullReview(source, target) {
    const sourceMap = new Map(source.map(item => [item.key, item]));
    const targetMap = new Map(target.map(item => [item.key, item]));
    const added = [], changed = [], unchanged = [];
    source.forEach(item => {
      if (!targetMap.has(item.key)) added.push(item.key);
      else if (json(item) !== json(targetMap.get(item.key))) changed.push(item.key);
      else unchanged.push(item.key);
    });
    const removed = target.filter(item => !sourceMap.has(item.key)).map(item => item.key);
    return { added, changed, unchanged, removed,
      missing: [...new Set(source.flatMap(links))].filter(key => !sourceMap.has(key)),
      records: source.slice(),
      stats: { new: added.length, changed: changed.length, removed: removed.length, unchanged: unchanged.length } };
  }
  function manifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest must be an object');
    const entries = Object.entries(value);
    if (!entries.length || entries.length > 2000 || !value.foundation) fail('manifest lacks foundation or exceeds 2000 areas');
    entries.forEach(([key, revision]) => {
      if (key !== 'foundation' && !/^[a-z][a-z0-9-]{0,63}\/[a-zA-Z0-9_-]{1,120}$/.test(key)) fail('invalid manifest key');
      if (!revisionPattern.test(revision)) fail('invalid revision');
    });
    json(value);
    return value;
  }
  function areaKey(page, id) {
    return !id || ['home', 'architecture', 'roles', 'foundation'].includes(page) ||
      (page === 'flows' && id === 'lookup') ||
      (page === 'backend' && ['services', 'databases', 'integrations', 'runbooks'].includes(id))
      ? 'foundation' : page + '/' + id;
  }
  function areaChanges(value, revisions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('area changes must be an object');
    Object.entries(value).forEach(([key, change]) => {
      exact(change, ['before', 'after', 'version', 'tags', 'summary', 'actor', 'releaseId', 'previousRelease']);
      metadata(change);
      if (!revisions[key] || change.after !== revisions[key] ||
          (change.before !== '' && !revisionPattern.test(change.before)) ||
          typeof change.actor !== 'string' || !change.actor || change.actor.length > 254 ||
          !/^[a-f0-9-]{36}$/.test(change.releaseId) ||
          (change.previousRelease !== '' && !/^[a-f0-9-]{36}$/.test(change.previousRelease))) fail('invalid area provenance: ' + key);
    });
    json(value);
    return value;
  }
  function dynamicItems(docs, sectionId) {
    const config = schema.section(docs, sectionId);
    return config ? schema.orderedRecords(docs.records || [], config) : [];
  }
  return { environments, collections, copyKeys, environment, metadata, record, json, split, assemble, links, review, fullReview, manifest, areaKey, areaChanges, revisionPattern,
    navigation, navigationRecords, navigationEntries, discoverable, ordered, pages, icons, iconUrl,
    schema, isDynamic: schema.isDynamic, startPage: schema.startPage, section: schema.section, dynamicItems };
});
