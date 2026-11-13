(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DOCS_SCHEMA = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const sectionPattern = /^[a-z][a-z0-9-]{0,63}$/;
  const idPattern = /^[a-zA-Z0-9_-]{1,120}$/;
  const reserved = new Set(['foundation', 'analytics', 'reader-analytics', 'article-analytics', 'admin-users', 'admin-teams', 'admin-documentation']);
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  // Missing block/field order and visibility mean 0 and true; no defaults mutate payloads.
  const defaults = Object.freeze({ order: 0, visible: true });
  const contract = Object.freeze({
    version: 2,
    // Readers a block or navigation tab can be limited to; content without audiences is for everyone.
    readers: Object.freeze(['end-users', 'support', 'testers', 'product-owners', 'administrators', 'developers', 'internal']),
    blockTypes: Object.freeze(['heading', 'paragraph', 'list', 'table', 'callout', 'code', 'diagram', 'image', 'link', 'cards', 'details', 'json', 'fields']),
    layouts: Object.freeze(['cards', 'table', 'list']),
    fieldTypes: Object.freeze(['text', 'number', 'boolean', 'date', 'json', 'link']),
    reservedSectionIds: Object.freeze([...reserved]),
    forbiddenKeys: Object.freeze([...forbidden]),
    patterns: Object.freeze({
      sectionId: sectionPattern.source,
      articleId: idPattern.source,
      blockId: idPattern.source,
      collection: '^[a-zA-Z][a-zA-Z0-9_-]{0,119}$',
      fieldSegment: '^[a-zA-Z_][a-zA-Z0-9_-]*$'
    }),
    defaults,
    limits: Object.freeze({
      documentBytes: 700000, stringLength: 500000, jsonDepth: 32, jsonNodes: 100000,
      sections: 40, navigationTabs: 40, navigationGroups: 200, navigationEntries: 2500,
      manifestRecords: 2000, fields: 256, blocksPerSibling: 500, blocksTotal: 2000,
      detailsDepth: 8, cards: 200, listItems: 2000, tableColumns: 256, tableRows: 2000,
      icons: 128, titleLength: 256, labelLength: 256, urlLength: 2048, fieldPathLength: 256,
      codeLanguageLength: 40
    })
  });
  const fail = message => { throw new Error('Invalid documentation: ' + message); };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const safeSection = value => typeof value === 'string' && !/\s/.test(value) && sectionPattern.test(value) && !reserved.has(value) && !forbidden.has(value);
  const safeId = value => typeof value === 'string' && !/\s/.test(value) && idPattern.test(value) && !forbidden.has(value);
  const safePath = value => typeof value === 'string' && value.length <= 256 && !/\s/.test(value) &&
    value.split('.').every(key => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key) && !forbidden.has(key));
  const iconUrl = value => typeof value === 'string' && value.length <= 256 && !/\s/.test(value) &&
    /^https:\/\/api\.iconify\.design\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.svg(?:\?color=%23[0-9a-fA-F]{6})?$/.test(value);
  const icon = value => iconUrl(value) || typeof value === 'string' && !/\s/.test(value) && sectionPattern.test(value);
  function shape(value, required, optional = []) {
    if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
        Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('unexpected fields');
  }
  function text(value, limit = 500000, nonempty = false) {
    if (typeof value !== 'string' || value.length > limit || value.includes('\0') || (nonempty && !value.trim())) fail('invalid text');
  }
  function flags(value) {
    if (value.order !== undefined && !Number.isSafeInteger(value.order)) fail('invalid order');
    if (value.visible !== undefined && typeof value.visible !== 'boolean') fail('invalid visible');
    if (value.expanded !== undefined && typeof value.expanded !== 'boolean') fail('invalid expanded');
    if (value.audiences !== undefined && (!Array.isArray(value.audiences) || !value.audiences.length ||
        value.audiences.some(reader => !contract.readers.includes(reader)) || new Set(value.audiences).size !== value.audiences.length)) fail('invalid audiences');
  }
  function json(value, depth = 0, budget = { count: 0 }) {
    if (++budget.count > 100000 || depth > 32) fail('content exceeds structural limits');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) return value.forEach(item => json(item, depth + 1, budget));
    if (!object(value)) fail('content must be JSON');
    Object.keys(value).forEach(key => {
      if (forbidden.has(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('unsafe property');
      json(value[key], depth + 1, budget);
    });
  }
  function publicUrl(value) {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value) || value.length > 2048 || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
    let url;
    try { url = new URL(value); } catch (_) { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|lan|home|localdomain|test|invalid|example|onion)$/.test(host)) return false;
    if (/^[\d.]+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
          a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) ||
          a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)) return false;
    }
    return true;
  }
  function href(value) {
    if (publicUrl(value)) return true;
    if (typeof value !== 'string' || /\s/.test(value)) return false;
    if (value === '#/') return true;
    const match = /^#\/([a-z][a-z0-9-]{0,63})(?:\/([a-zA-Z0-9_-]{1,120}))?$/.exec(value);
    return !!match && safeSection(match[1]) && (!match[2] || safeId(match[2]));
  }
  function fields(value) {
    if (!Array.isArray(value) || value.length > 256) fail('invalid fields');
    const keys = new Set();
    value.forEach(field => {
      shape(field, ['key', 'label', 'type'], ['order', 'visible']);
      if (!safePath(field.key) || keys.has(field.key) || !['text', 'number', 'boolean', 'date', 'json', 'link'].includes(field.type)) fail('invalid field');
      text(field.label, 256, true); flags(field); keys.add(field.key);
    });
    return value;
  }
  function blocks(value, depth = 0, budget = { count: 0 }) {
    if (depth === 0) json(value);
    if (!Array.isArray(value) || value.length > 500 || depth > 8) fail('invalid blocks');
    const ids = new Set();
    value.forEach(block => {
      if (++budget.count > 2000 || !object(block) || !safeId(block.id) || ids.has(block.id)) fail('invalid block id or block limit');
      ids.add(block.id);
      const types = {
        heading: [['text', 'level'], ['group']], paragraph: [['text'], []], list: [['items'], ['ordered']],
        table: [['columns', 'rows'], []], callout: [['tone', 'text'], []],
        code: [['code'], ['language']], diagram: [['source'], []],
        image: [['src', 'alt'], ['caption']], link: [['label', 'href'], []],
        cards: [['items'], []], details: [['title', 'blocks'], ['expanded']],
        json: [['value'], []], fields: [['value'], ['fields']]
      };
      if (typeof block.type !== 'string' || !Object.hasOwn(types, block.type)) fail('unknown block type');
      const [required, optional] = types[block.type];
      shape(block, ['id', 'type', ...required], ['order', 'visible', 'audiences', ...optional]); flags(block);
      switch (block.type) {
        case 'heading':
          if (![2, 3, 4].includes(block.level)) fail('invalid heading level');
          // A level-2 heading may name the tab its part belongs to ("Overview", "Technical", …).
          if (block.group !== undefined && (block.level !== 2 || typeof block.group !== 'string' || !/^[^\n]{1,40}$/.test(block.group) || block.group.trim() !== block.group)) fail('invalid heading group');
          text(block.text); break;
        case 'paragraph': text(block.text); break;
        case 'callout':
          if (!['info', 'warning', 'success', 'danger'].includes(block.tone)) fail('invalid callout');
          text(block.text); break;
        case 'code':
          text(block.code);
          if (block.language !== undefined && (typeof block.language !== 'string' || /\s/.test(block.language) || !/^[a-zA-Z0-9_+-]{1,40}$/.test(block.language))) fail('invalid language');
          break;
        case 'diagram': text(block.source); break;
        case 'list':
          if (!Array.isArray(block.items) || block.items.length > 2000) fail('invalid list');
          block.items.forEach(item => text(item));
          if (block.ordered !== undefined && typeof block.ordered !== 'boolean') fail('invalid ordered list');
          break;
        case 'table': {
          if (!Array.isArray(block.columns) || !block.columns.length || block.columns.length > 256 ||
              !Array.isArray(block.rows) || block.rows.length > 2000 || block.rows.some(row => !object(row))) fail('invalid table');
          const keys = new Set();
          block.columns.forEach(column => {
            shape(column, ['key', 'label'], ['order', 'visible']); flags(column);
            if (!safePath(column.key) || keys.has(column.key)) fail('invalid column');
            keys.add(column.key); text(column.label, 256, true);
          }); break;
        }
        case 'image':
          if (!publicUrl(block.src)) fail('invalid image URL');
          text(block.alt, 4000);
          if (block.caption !== undefined) text(block.caption, 4000);
          break;
        case 'link':
          text(block.label, 256, true);
          if (!href(block.href)) fail('invalid link');
          break;
        case 'cards':
          if (!Array.isArray(block.items) || block.items.length > 200) fail('invalid cards');
          block.items.forEach(item => {
            shape(item, ['title'], ['text', 'href', 'icon', 'order', 'visible']); flags(item);
            text(item.title, 256, true);
            if (item.text !== undefined) text(item.text);
            if (item.href !== undefined && !href(item.href)) fail('invalid card link');
            if (item.icon !== undefined && !icon(item.icon)) fail('invalid card icon');
          }); break;
        case 'details': text(block.title, 256, true); blocks(block.blocks, depth + 1, budget); break;
        case 'fields':
          if (!object(block.value)) fail('invalid fields value');
          if (block.fields !== undefined) fields(block.fields);
          break;
      }
    });
    json(value);
    return value;
  }
  function isDynamic(docs) { return docs?.schemaVersion === 2; }
  function section(docs, id) { return docs.sections?.find(item => item.id === id); }
  function startPage(docs) { return isDynamic(docs) ? docs.startPage : 'home'; }
  function foundation(data) {
    json(data);
    if (!isDynamic(data) || !object(data.meta) ||
        ['appName', 'subtitle', 'createdBy', 'updatedBy', 'updated'].some(key => typeof data.meta[key] !== 'string')) fail('invalid v2 metadata');
    if (!Array.isArray(data.sections) || !data.sections.length || data.sections.length > 40) fail('invalid sections');
    const ids = new Set();
    data.sections.forEach(item => {
      shape(item, ['id', 'collection', 'layout', 'sort'], ['fields', 'blocks', 'defaultExpanded', 'order', 'visible']);
      if (!safeSection(item.id) || ids.has(item.id) || typeof item.collection !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/.test(item.collection) || forbidden.has(item.collection) ||
          !['cards', 'table', 'list'].includes(item.layout)) fail('invalid section');
      shape(item.sort, ['field', 'direction']);
      if (!['title', 'id', 'order'].includes(item.sort.field) &&
          !(typeof item.sort.field === 'string' && item.sort.field.startsWith('value.') && safePath(item.sort.field.slice(6)))) fail('invalid sort field');
      if (!['asc', 'desc'].includes(item.sort.direction)) fail('invalid sort direction');
      if (item.defaultExpanded !== undefined && typeof item.defaultExpanded !== 'boolean') fail('invalid defaultExpanded');
      flags(item);
      if (item.fields !== undefined) fields(item.fields);
      if (item.blocks !== undefined) blocks(item.blocks);
      ids.add(item.id);
    });
    if (!ids.has(data.startPage) || section(data, data.startPage).visible === false) fail('startPage must identify a visible section');
    navigation(data.navigation, data);
    if (!data.navigation.tabs.find(tab => tab.id === data.startPage).visible) fail('startPage navigation must be visible');
    return data;
  }
  function navigation(nav, data) {
    shape(nav, ['tabs', 'groups', 'entries']);
    if (![nav.tabs, nav.groups, nav.entries].every(Array.isArray) ||
        nav.tabs.length > 40 || nav.groups.length > 200 || nav.entries.length > 2500) fail('invalid navigation collections');
    const tabs = new Map(), groups = new Map(), ids = new Set(), keys = new Set();
    function common(item) {
      if (!safeId(item.id) || !Number.isSafeInteger(item.order) || typeof item.visible !== 'boolean') fail('invalid navigation item');
      text(item.label, 256, true); flags(item);
    }
    nav.tabs.forEach(tab => {
      shape(tab, ['id', 'label', 'overviewLabel', 'icon', 'href', 'order', 'visible'], ['expanded', 'audiences']);
      common(tab); text(tab.overviewLabel, 256, true);
      if (!safeSection(tab.id) || !section(data, tab.id) || tabs.has(tab.id) || !icon(tab.icon) ||
          !(tab.href === '#/' + tab.id || tab.id === data.startPage && tab.href === '#/')) fail('invalid navigation tab');
      tabs.set(tab.id, tab);
    });
    if (tabs.size !== data.sections.length) fail('every section needs exactly one navigation tab');
    nav.groups.forEach(group => {
      shape(group, ['id', 'tab', 'label', 'icon', 'order', 'visible'], ['expanded']); common(group);
      if (!tabs.has(group.tab) || groups.has(group.id) || !icon(group.icon)) fail('invalid navigation group');
      groups.set(group.id, group);
    });
    nav.entries.forEach(entry => {
      shape(entry, ['id', 'tab', 'group', 'key', 'label', 'href', 'order', 'visible', 'searchable'], ['icon']);
      common(entry);
      const parts = typeof entry.href === 'string' ? entry.href.split('/') : [];
      if (ids.has(entry.id) || keys.has(entry.key) || !tabs.has(entry.tab) ||
          entry.group !== '' && groups.get(entry.group)?.tab !== entry.tab ||
          typeof entry.searchable !== 'boolean' || parts.length !== 3 || parts[0] !== '#' ||
          parts[1] !== entry.tab || !safeId(parts[2]) || entry.key !== entry.tab + '/' + parts[2] ||
          entry.icon !== undefined && !icon(entry.icon)) fail('invalid navigation entry');
      ids.add(entry.id); keys.add(entry.key);
    });
    json(nav); return nav;
  }
  function entity(item) {
    json(item);
    const data = item.data;
    shape(data, ['schemaVersion', 'id', 'value'], ['blocks', 'order']);
    if (!isDynamic(data) || !safeSection(item.page) || !safeId(data.id) ||
        item.key !== item.page + '/' + data.id || typeof item.collection !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/.test(item.collection) || forbidden.has(item.collection) || !object(data.value)) fail('invalid generic article');
    flags(data);
    if (data.blocks !== undefined) blocks(data.blocks);
    return item;
  }
  function ownPath(value, path) {
    if (!safePath(path)) return undefined;
    for (const key of path.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) return undefined;
      value = descriptor.value;
    }
    return value;
  }
  function compare(a, b) {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(typeof a === 'object' ? JSON.stringify(a) : a).localeCompare(String(typeof b === 'object' ? JSON.stringify(b) : b), 'en');
  }
  function orderedRecords(records, config) {
    const get = item => config.sort.field === 'title' ? item.title : config.sort.field === 'id' ? item.data.id :
      config.sort.field === 'order' ? item.data.order ?? 0 : ownPath(item.data.value, config.sort.field.slice(6));
    return records.filter(item => item.page === config.id).slice().sort((a, b) =>
      compare(get(a), get(b)) * (config.sort.direction === 'desc' ? -1 : 1) ||
      compare(a.title, b.title) || compare(a.data.id, b.data.id));
  }
  function inferredFields(value, prefix = '') {
    if (!object(value)) return [];
    return Object.keys(value).filter(key => safePath(key) && !key.includes('.')).flatMap(key => {
      const path = prefix + key, item = value[key];
      if (object(item) && Object.keys(item).length) return inferredFields(item, path + '.');
      return [{ key: path, label: path, type: typeof item === 'number' ? 'number' : typeof item === 'boolean' ? 'boolean' : typeof item === 'string' ? 'text' : 'json', ...defaults }];
    });
  }
  return { contract, defaults, sectionPattern, safeSection, safeId, safePath, publicUrl, href, fields, blocks,
    isDynamic, section, startPage, foundation, navigation, entity, ownPath, orderedRecords, inferredFields };
});
