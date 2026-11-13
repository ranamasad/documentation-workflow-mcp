/* Deterministic v1 (legacy fixed categories) → v2 (dynamic sections) conversion.
 * Shared by the local CLI and the Documentation Workflow MCP; never loaded by the reader.
 * Conversion is an explicit, reviewed migration: it creates new v2 records and never edits
 * published v1 revisions. Every v1 field is either mapped to safe blocks or reported. */
(function (root, factory) {
  'use strict';
  const api = typeof module === 'object' && module.exports ?
    factory(require('./documentation-model'), require('./documentation-schema')) : factory(root.DOCS_MODEL, root.DOCS_SCHEMA);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DOCS_CONVERT = api;
})(typeof window === 'object' ? window : globalThis, function (model, schema) {
  'use strict';
  const own = (value, key) => value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const present = value => value !== undefined && value !== null && value !== '' &&
    !(Array.isArray(value) && !value.length) && !(object(value) && !Object.keys(value).length);
  const lucide = name => 'https://api.iconify.design/lucide/' + name + '.svg';

  // Built-in v1 icon names mapped to equivalent public Lucide icons, plus reader UI icons.
  const ICONS = {
    home: 'house', layers: 'layers', grid: 'layout-grid', flow: 'workflow', book: 'book-open', database: 'database',
    terminal: 'terminal', clock: 'clock', globe: 'globe', users: 'users', alert: 'triangle-alert', bell: 'bell',
    sliders: 'sliders-horizontal', tool: 'wrench', help: 'circle-help', shield: 'shield', search: 'search',
    arrow: 'arrow-right', file: 'file-text', info: 'info', lock: 'lock', plane: 'plane', chevron: 'chevron-right',
    menu: 'menu', moon: 'moon', sun: 'sun', print: 'printer', check: 'check', close: 'x', refresh: 'refresh-cw'
  };
  const UI_ICONS = ['search', 'chevron', 'menu', 'moon', 'sun', 'print', 'users', 'alert', 'file'];

  // One v2 section per v1 category. Routes and article keys stay identical, so links keep working.
  const SECTIONS = {
    features: { collection: 'features', layout: 'cards', fields: [['summary', 'Summary'], ['who', 'Who can use it']] },
    apps: { collection: 'applications', layout: 'cards', fields: [['kind', 'Kind'], ['summary', 'Summary']] },
    flows: { collection: 'flows', layout: 'list', fields: [['summary', 'Summary']] },
    'data-model': { collection: 'tables', layout: 'table', fields: [['store', 'Store'], ['summary', 'What it holds'], ['primaryKey', 'Primary key']] },
    api: { collection: 'endpoints', layout: 'table', fields: [['method', 'Method'], ['path', 'Path'], ['auth', 'Authentication']] },
    events: { collection: 'events', layout: 'table', fields: [['kind', 'Kind'], ['trigger', 'Trigger / schedule']] },
    services: { collection: 'externalServices', layout: 'cards', fields: [['kind', 'Kind'], ['summary', 'Summary']] },
    errors: { collection: 'errors', layout: 'table', fields: [['area', 'Area'], ['message', 'Message'], ['raiseIssue', 'Raise issue', 'boolean']] },
    notifications: { collection: 'notifications', layout: 'list', fields: [['channel', 'Channel'], ['when', 'When'], ['to', 'To']] },
    config: { collection: 'config', layout: 'table', fields: [['source', 'Source'], ['controls', 'What it controls'], ['values', 'Default / values'], ['secret', 'Secret', 'boolean']] },
    troubleshooting: { collection: 'troubleshooting', layout: 'list', fields: [['group', 'Group']] },
    faq: { collection: 'faq', layout: 'list', fields: [['group', 'Group']] },
    glossary: { collection: 'glossary', layout: 'list', fields: [['definition', 'Definition']] },
    backend: { collection: 'backend', layout: 'list', fields: [['kind', 'Kind'], ['summary', 'Summary']] },
    home: { collection: 'home', layout: 'cards', fields: [] },
    architecture: { collection: 'architecture', layout: 'cards', fields: [] },
    roles: { collection: 'roles', layout: 'cards', fields: [] }
  };
  const ALIASES = { feature: 'features', app: 'apps', flow: 'flows', table: 'data-model', api: 'api', event: 'events',
    svc: 'services', error: 'errors', notif: 'notifications', config: 'config', trouble: 'troubleshooting', faq: 'faq',
    glossary: 'glossary', backend: 'backend', role: 'roles' };
  const BACKEND_KINDS = { 'backend.services': ['services', 'Service'], 'backend.databases': ['databases', 'Database'],
    'backend.integrations': ['integrations', 'Integration'], 'backend.runbooks': ['runbooks', 'Runbook'] };
  const SCENARIOS = [['ok', 'Everything works'], ['input', 'Wrong input'], ['access', 'Can’t access'], ['failure', 'Service failure'],
    ['retry', 'Retry / double submit'], ['race', 'At the same time'], ['unusual', 'Unusual cases'], ['roles', 'By role']];

  function fail(message) { throw new Error('Invalid conversion: ' + message); }
  function humanize(key) {
    const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : 'Value';
  }
  function text(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  /* ---------- Context: labels, link resolution and reporting ---------- */
  function context(foundation, records = []) {
    const data = foundation.data;
    const nav = data.navigation || { tabs: [], groups: [], entries: [] };
    const labels = new Map(nav.entries.filter(entry => entry.key !== 'foundation').map(entry => [entry.key, entry.label]));
    // The v1 field-lookup page exists when it has data sources or a navigation entry.
    const hasLookup = Array.isArray(data.dataSources) && data.dataSources.length > 0 ||
      nav.entries.some(entry => entry.href === '#/flows/lookup') && nav.tabs.some(tab => tab.id === 'flows');
    if (hasLookup) labels.set('flows/lookup', nav.entries.find(entry => entry.href === '#/flows/lookup')?.label || 'Field lookup');
    const tabs = new Set(nav.tabs.map(tab => tab.id));
    // Backend articles join the navigation group of their logical collection (services, databases…).
    const backendKinds = new Map(records.filter(record => record?.page === 'backend').map(record => [record.key, BACKEND_KINDS[record.collection]?.[0]]));
    return {
      data, nav, labels, tabs, hasLookup, backendKinds,
      report: { unmapped: [], brokenLinks: [], droppedNavigation: [], warnings: [] }
    };
  }
  // Rewrite a v1 internal route to its v2 equivalent; null when it has no destination.
  function route(ctx, href) {
    if (typeof href !== 'string') return null;
    if (/^https:\/\//i.test(href)) return schema.publicUrl(href) ? href : null;
    if (href === '#/' || href === '#' || href === '#/home') return '#/';
    const match = /^#\/([a-z][a-z0-9-]{0,63})(?:\/([a-zA-Z0-9_-]{1,120}))?$/.exec(href);
    if (!match) return null;
    const [, page, id] = match;
    if (!ctx.tabs.has(page) && page !== 'roles' && page !== 'architecture') return null;
    if (!id) return SECTIONS[page] ? '#/' + page : null;
    if (ctx.labels.has(page + '/' + id)) return '#/' + page + '/' + id;
    return SECTIONS[page] && ctx.tabs.has(page) ? '#/' + page : null;
  }
  function target(ctx, type, id, from) {
    const page = ALIASES[type];
    if (!page) return null;
    if (page === 'roles') return ctx.tabs.has('roles') ? { href: '#/roles', label: 'User roles' } : null;
    const key = page + '/' + id;
    if (ctx.labels.has(key)) return { href: '#/' + key, label: ctx.labels.get(key) };
    if (page === 'backend' && BACKEND_KINDS['backend.' + id] && ctx.tabs.has('backend')) return { href: '#/backend', label: humanize(id) };
    ctx.report.brokenLinks.push({ key: from, target: key });
    return null;
  }

  /* ---------- Block builder ---------- */
  function builder(ctx, key) {
    let next = 0;
    const related = new Map();
    const id = prefix => (prefix || 'b') + (++next);
    function plain(value) {
      return text(value)
        .replace(/\[\[([a-z]+):([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, type, ref, label) => {
          if (type === 'confirm') return '(needs confirmation: ' + ref + ')';
          const link = target(ctx, type, ref, key);
          if (link) related.set(link.href, label || link.label);
          return label || link?.label || ref;
        })
        .replace(/(^|[\s(])(#\/[a-z][a-z0-9-]*(?:\/[a-zA-Z0-9_-]+)?)/g, (match, lead, href) => {
          const resolved = route(ctx, href);
          if (resolved && resolved !== '#/') related.set(resolved, related.get(resolved) || ctx.labels.get(resolved.slice(2)) || humanize(resolved.split('/').pop()));
          return match;
        })
        .replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
    }
    function confirmations(value) {
      const found = [];
      text(value).replace(/\[\[confirm:([^\]|]+)(?:\|[^\]]+)?\]\]/g, (match, note) => { found.push(note); return match; });
      return found;
    }
    // v1 mini-markdown: blank-line paragraphs, "- " bullets and "1. " numbered lists.
    function rich(value) {
      if (!present(value)) return [];
      if (Array.isArray(value)) return [{ id: id(), type: 'list', items: value.map(item => plain(item)) }];
      const out = [];
      text(value).split(/\n\s*\n/).map(chunk => chunk.replace(/^\n+|\n+$/g, '')).filter(Boolean).forEach(chunk => {
        const lines = chunk.split('\n');
        if (lines.every(line => /^\s*- /.test(line))) out.push({ id: id(), type: 'list', items: lines.map(line => plain(line.replace(/^\s*- /, ''))) });
        else if (lines.every(line => /^\s*\d+\. /.test(line))) out.push({ id: id(), type: 'list', ordered: true, items: lines.map(line => plain(line.replace(/^\s*\d+\. /, ''))) });
        else out.push({ id: id(), type: 'paragraph', text: plain(chunk) });
      });
      confirmations(value).forEach(note => out.push(callout('warning', 'Needs confirmation: ' + note)));
      return out;
    }
    function heading(value, level = 2) { return { id: id(), type: 'heading', level, text: plain(value) }; }
    function callout(tone, value) { return { id: id(), type: 'callout', tone, text: plain(value) }; }
    function details(title, blocks, expanded) {
      const content = blocks.filter(Boolean);
      return content.length ? { id: id(), type: 'details', title: plain(title).slice(0, 256) || 'Details', blocks: content, ...(expanded ? { expanded: true } : {}) } : null;
    }
    // Plain-language first; technical detail collapsed for support readers.
    function layers(simple, tech, techTitle) {
      return [...rich(simple), details(techTitle || 'Technical detail', rich(tech))].filter(Boolean);
    }
    function diagram(source, caption) {
      if (!present(source)) return [];
      return [{ id: id(), type: 'diagram', source: text(source) }, ...(present(caption) ? [{ id: id(), type: 'paragraph', text: plain(caption) }] : [])];
    }
    function table(headers, rows, formatters = []) {
      if (!Array.isArray(rows) || !rows.length) return null;
      const width = Math.max(headers.length, ...rows.map(row => Array.isArray(row) ? row.length : 1));
      const columns = Array.from({ length: Math.min(width, 256) }, (_, index) => ({ key: 'c' + index, label: plain(headers[index] || 'Column ' + (index + 1)).slice(0, 256) || 'Column ' + (index + 1) }));
      return { id: id(), type: 'table', columns, rows: rows.slice(0, 2000).map(row => Object.fromEntries(columns.map((column, index) => {
        const cell = Array.isArray(row) ? row[index] : index ? undefined : row;
        return [column.key, formatters[index] ? formatters[index](cell) : plain(cell)];
      }))) };
    }
    // Short facts become a two-column table; long ones get their own heading.
    function facts(pairs, level = 3) {
      const short = [], long = [];
      pairs.filter(pair => present(pair[1])).forEach(([label, value]) => {
        const valueText = text(value);
        (valueText.length <= 160 && !valueText.includes('\n') && typeof value !== 'object' ? short : long).push([label, value]);
      });
      // Short facts render as a label/value list (the fields block), long ones as headed prose.
      const list = short.length ? { id: id(), type: 'fields', value: Object.fromEntries(short.map(([, value], index) => ['f' + index, plain(value)])),
        fields: short.map(([label], index) => ({ key: 'f' + index, label: plain(label).slice(0, 256) || 'Detail', type: 'text', order: index })) } : null;
      return [list, ...long.flatMap(([label, value]) => [heading(label, level), ...rich(value)])].filter(Boolean);
    }
    function json(value, title) {
      if (!present(value) && value !== false && value !== 0) return [];
      return [...(title ? [{ id: id(), type: 'paragraph', text: plain(title) }] : []),
        typeof value === 'string' ? { id: id(), type: 'code', code: value } : { id: id(), type: 'json', value }];
    }
    // Explicit ID references (apps: ['ipad'], endpoints: [...]) become linked cards.
    function references(type, ids) {
      const items = (Array.isArray(ids) ? ids : [ids]).filter(item => typeof item === 'string' && item).map(ref => {
        const link = target(ctx, type, ref, key);
        return link ? { title: link.label.slice(0, 256), href: link.href } : { title: ref.slice(0, 256) };
      });
      return items.length ? { id: id(), type: 'cards', items } : null;
    }
    function relatedBlocks() {
      if (!related.size) return [];
      const items = [...related].filter(([href]) => href !== '#/' + key).map(([href, label]) => ({ title: String(label).slice(0, 256) || href, href }));
      return items.length ? [heading('Related', 2), { id: id(), type: 'cards', items }] : [];
    }
    // Anything the category mapping does not know is preserved, never silently dropped.
    function leftovers(data, used) {
      const extra = Object.keys(data).filter(field => !used.includes(field) && present(data[field]));
      extra.forEach(field => ctx.report.unmapped.push({ key, field }));
      return extra.length ? [details('Additional information', extra.flatMap(field => {
        const value = data[field];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [heading(humanize(field), 3), ...rich(text(value))];
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) return [heading(humanize(field), 3), ...rich(value)];
        if (Array.isArray(value) && value.every(Array.isArray)) return [heading(humanize(field), 3), table([], value)];
        return [heading(humanize(field), 3), ...json(value)];
      }))] : [];
    }
    return { id, plain, rich, heading, callout, details, layers, diagram, table, facts, json, references, relatedBlocks, leftovers };
  }
  const yesNo = value => value === true || value === 'true' || value === 1 ? 'Yes' : value === false || value === 'false' || value === 0 ? 'No' : text(value);
  const code = value => value === undefined || value === null || value === '' ? '' : String(value);
  function fieldTable(b, rows, headers = ['Field', 'Type', 'Required', 'Meaning', 'Example', 'Comes from', 'Stored in']) {
    return b.table(headers, rows, [code, null, yesNo, null, code]);
  }
  function summary(b, value) { return b.plain(value).replace(/\s+/g, ' ').trim().slice(0, 500); }

  /* ---------- Article builders per v1 category ---------- */
  const articles = {
    features(f, b, ctx) {
      const value = { summary: summary(b, f.summary), who: summary(b, f.who || ctx.data.copy?.who) };
      const codeDate = ctx.data.gitDates?.[f.id];
      const blocks = [...b.rich(f.summary),
        ...b.facts([['Who can use it', f.who || ctx.data.copy?.who], ['Code last changed', codeDate]]),
        ...(present(f.apps) || present(f.services) ? [b.heading('Applications involved', 3), b.references('app', f.apps), b.references('svc', f.services)] : []),
        ...(present(f.what) ? [b.heading('What it is'), ...b.layers(f.what.simple, f.what.tech)] : []),
        ...(present(f.where) ? [b.heading('Where to find it'), ...b.rich(f.where)] : []),
        ...(present(f.steps) ? [b.heading('How the user uses it'), ...b.rich(f.steps)] : []),
        ...(present(f.underneath) ? [b.heading('How it works underneath'), ...b.layers(f.underneath.simple, f.underneath.tech),
          b.details('Diagram', b.diagram(f.underneath.diagram, f.underneath.caption))] : [])];
      const data = [
        ...(present(f.endpoints) ? [b.heading('Endpoints used', 3), b.references('api', f.endpoints)] : []),
        ...(f.json || []).flatMap(item => [b.heading(item.title || 'JSON', 3), ...b.rich(item.note),
          ...b.json(item.example, item.exampleTitle), fieldTable(b, item.fields)]),
        ...(present(f.tables) || present(f.tablesNote) ? [b.heading('Database tables / objects read or written', 3), ...b.rich(f.tablesNote), b.references('table', f.tables)] : []),
        ...(present(f.events) || present(f.eventsNote) ? [b.heading('Events, messages & background jobs triggered', 3), b.references('event', f.events), ...b.rich(f.eventsNote)] : [])];
      if (data.some(Boolean)) blocks.push(b.heading('Data and JSON'), b.details('Technical data and JSON', data));
      if (present(f.rules)) blocks.push(b.heading('Rules and limits'), b.table(['Rule (plain words)', 'Where it is enforced'], f.rules));
      const scenarios = SCENARIOS.filter(([name]) => present(f.scenarios?.[name]));
      if (scenarios.length) {
        blocks.push(b.heading('Scenarios'));
        scenarios.forEach(([name, label]) => {
          blocks.push(b.heading(label, 3));
          f.scenarios[name].forEach(item => blocks.push(b.details(item.title || label, [
            ...b.facts([['User did', item.did], ['What happens', item.happens], ['User sees', item.sees], ['Support should', item.support]], 4),
            item.tech ? b.details('Technical detail', [...b.facts([['Code path', item.tech.path], ['HTTP status', item.tech.status],
              ['Logged', item.tech.logged], ['Final DB state', item.tech.db]], 4), ...b.json(item.tech.json, item.tech.jsonTitle)]) : null])));
        });
      }
      if (present(f.faq)) blocks.push(b.heading('Common user questions and complaints'), ...f.faq.map(item => b.details('“' + b.plain(item.q) + '”', b.rich(item.a))));
      if (present(f.troubleshooting)) blocks.push(b.heading('Troubleshooting checklist'), ...b.rich(f.troubleshooting));
      if (present(f.supportFix) || present(f.escalate)) {
        blocks.push(b.heading('What support can fix vs. when to raise an issue'));
        if (present(f.supportFix)) blocks.push(b.heading('Support can', 3), ...b.rich(f.supportFix));
        if (present(f.escalate)) blocks.push(b.heading('Raise an issue when', 3), b.callout('warning', f.escalate));
      }
      if (present(f.config) || present(f.configNote)) blocks.push(b.heading('Configuration'), b.references('config', f.config), ...b.rich(f.configNote));
      if (present(f.dependsOn)) blocks.push(b.heading('Depends on'), b.references('feature', f.dependsOn));
      if (present(f.tests)) blocks.push(b.heading('Tests'), b.details('Test coverage', b.rich(f.tests)));
      if (present(f.issues) || present(f.confirm)) blocks.push(b.heading('Known issues, TODOs and risks'), ...b.rich(f.issues),
        ...(f.confirm || []).map(note => b.callout('warning', 'Needs confirmation: ' + b.plain(note))));
      if (present(f.refs)) blocks.push(b.heading('Technical references'), b.details('Source references', [b.table(['File', 'Function / type', 'Purpose'], f.refs)]));
      return { value, blocks, used: ['id', 'name', 'group', 'summary', 'who', 'apps', 'services', 'what', 'where', 'steps', 'underneath', 'endpoints',
        'json', 'tables', 'tablesNote', 'events', 'eventsNote', 'rules', 'scenarios', 'faq', 'troubleshooting', 'supportFix', 'escalate',
        'config', 'configNote', 'dependsOn', 'tests', 'issues', 'confirm', 'refs'] };
    },
    apps(a, b) {
      return { value: { kind: summary(b, a.kind), summary: summary(b, a.short), ...(present(a.group) ? { group: summary(b, a.group) } : {}) },
        blocks: [...(present(a.confirm) ? [b.callout('warning', 'Needs confirmation: ' + b.plain(a.confirm))] : []),
          ...b.facts([['Kind', a.kind], ['Group', a.group]]), ...b.layers(a.simple, a.tech),
          b.details('Technical detail: how it is built', b.facts([['Tech used', a.stack], ['Folder', a.folder], ['How it starts', a.starts],
            ['Responsible for', a.responsibilities], ['Exposes', a.exposes], ['Calls', a.calls], ['Reads / writes', a.data],
            ['Config needed', a.config], ['Tests', a.tests]], 4)),
          ...(present(a.endpoints) ? [b.heading('Endpoints', 3), b.references('api', a.endpoints)] : []),
          ...(present(a.downImpact) ? [b.heading('What breaks if it goes down'), ...b.layers(a.downImpact.simple, a.downImpact.tech)] : [])],
        used: ['id', 'name', 'group', 'kind', 'short', 'simple', 'tech', 'stack', 'folder', 'starts', 'responsibilities', 'exposes', 'calls', 'data', 'config', 'tests', 'endpoints', 'downImpact', 'confirm'] };
    },
    flows(f, b) {
      const steps = (f.steps || []).map((step, index) => b.details((index + 1) + '. ' + b.plain(step.title || 'Step'), [
        ...b.rich(step.simple), ...b.facts([['Handled by', step.app], ['Travels via', step.via], ['Validated / can fail', step.fails],
          ['Database', step.db], ['Triggers', step.triggers]], 4), ...b.json(step.request, 'Request'), ...b.json(step.response, 'Response')], index === 0));
      return { value: { summary: summary(b, f.short) },
        blocks: [...b.rich(f.short), ...b.layers(f.simple, f.tech), ...(present(f.diagram) ? [b.heading('Diagram'), ...b.diagram(f.diagram, f.caption)] : []),
          ...(steps.length ? [b.heading('Step by step'), ...steps] : []),
          ...(present(f.related) ? [b.heading('Related features'), b.references('feature', f.related)] : [])],
        used: ['id', 'name', 'short', 'simple', 'tech', 'diagram', 'caption', 'steps', 'related'] };
    },
    'data-model'(t, b) {
      return { value: { store: summary(b, t.store), summary: summary(b, t.simpleShort || t.short), primaryKey: summary(b, t.pk) },
        blocks: [...b.layers(t.simple, t.tech), ...b.facts([['Store', t.store], ['Defined in', t.file], ['Primary key', t.pk], ['Kind', t.kind],
          ['Lifetime / purge', t.lifetime], ['Code last changed', t.codeDate]]),
          ...(present(t.fields) ? [b.heading('Fields'), fieldTable(b, t.fields, ['Field', 'Type', 'Required', 'Meaning', 'Example'])] : []),
          ...(present(t.relations) ? [b.heading('Relationships'), ...b.rich(t.relations)] : []),
          ...(present(t.backendTables) ? [b.heading('Backend provenance'), b.references('table', t.backendTables)] : []),
          ...(present(t.apps) ? [b.heading('Applications'), b.references('app', t.apps)] : [])],
        used: ['id', 'name', 'store', 'simpleShort', 'short', 'simple', 'tech', 'file', 'pk', 'kind', 'lifetime', 'fields', 'relations', 'backendTables', 'apps', 'codeDate'] };
    },
    api(e, b, ctx) {
      const server = [['Route / handler', e.server], ['Source files / provenance', e.sources || e.serverFiles || e.serverFile],
        ['Handler function', e.serverHandler], ['Authentication / middleware', e.serverAuth], ['Server validation', e.serverValidation],
        ['Reads', e.reads], ['Writes / recipients', e.writes], ['Upstream / cache', e.upstream], ['Server responses and errors', e.serverErrors],
        ['Server limits / retries / timeouts', e.serverLimits], ['Logs / monitoring', e.logs], ['How to check receipt or source', e.howToCheck],
        ['Other implementation in supplied repositories', e.serverAlternatives]];
      return { value: { method: summary(b, e.method), path: summary(b, e.path), auth: summary(b, e.auth || 'n/a') },
        blocks: [...(present(e.confirm) ? [b.callout('warning', 'Needs confirmation: ' + b.plain(e.confirm))] : []),
          ...(present(e.app) ? [b.heading('Service', 3), b.references('app', e.app)] : []),
          ...b.facts([['Method', e.method], ['Path', e.path], ['Auth', e.auth || 'n/a'], ['Base', e.base || 'n/a'], ['Timeout', e.timeout]]),
          ...b.layers(e.simple, e.tech),
          b.details('Client detail', [...b.rich(e.backendConfirmed), ...b.facts([['Full URL', e.url], ['Handled in app code by', e.handler],
            ['Called from', e.callers], ['Headers', e.headers], ['Query parameters', e.query], ['Client retries', e.retries],
            ['Rate limits', e.rateLimit || e.serverLimits || ctx.data.copy?.rateLimits], ['Stored on device', e.stored]], 4)]),
          ...(present(e.server) ? [b.heading('Backend: end-to-end trace'), b.details('Backend trace', [...b.facts([['Confirmed deployment ownership', e.confirmedDeployment],
            ['Code last changed', e.codeDate]], 4), ...b.facts(server, 4)])] : []),
          ...(present(e.request) ? [b.heading('Request'), ...b.json(e.request, e.requestType ? 'Request ' + e.requestType : null)] : []),
          ...(present(e.requestFields) ? [fieldTable(b, e.requestFields)] : []),
          ...(present(e.response) ? [b.heading('Response'), ...b.json(e.response, 'Response JSON (2xx)')] : []),
          ...(present(e.responseFields) ? [fieldTable(b, e.responseFields)] : []),
          ...(present(e.errors) ? [b.heading('Error responses'), ...e.errors.map(error => b.details(text(error.status) + ' — ' + b.plain(error.when),
            [...b.facts([['App behaviour', error.app]], 4), ...b.json(error.json, 'Error body')]))] : [])],
        used: ['id', 'method', 'path', 'app', 'auth', 'base', 'timeout', 'simple', 'tech', 'url', 'handler', 'callers', 'headers', 'query', 'retries',
          'rateLimit', 'stored', 'backendConfirmed', 'server', 'confirmedDeployment', 'codeDate', 'sources', 'serverFiles', 'serverFile', 'serverHandler',
          'serverAuth', 'serverValidation', 'reads', 'writes', 'upstream', 'serverErrors', 'serverLimits', 'logs', 'howToCheck', 'serverAlternatives',
          'requestType', 'request', 'requestFields', 'response', 'responseFields', 'errors', 'confirm'] };
    },
    events(e, b) {
      return { value: { kind: summary(b, e.kind), trigger: summary(b, e.trigger || e.schedule) },
        blocks: [...b.rich(e.short), ...b.layers(e.simple, e.tech), ...b.facts([['Kind', e.kind], ['Trigger', e.trigger], ['Schedule', e.schedule],
          ['Sent by', e.sender], ['Handled by', e.handler], ['Retries', e.retries], ['On failure', e.onFailure]]),
          ...(present(e.payload) ? [b.heading('Payload'), ...b.json(e.payload)] : [])],
        used: ['id', 'name', 'kind', 'short', 'simple', 'tech', 'trigger', 'schedule', 'sender', 'handler', 'retries', 'onFailure', 'payload'] };
    },
    services(s, b) {
      return { value: { kind: summary(b, s.kind), summary: summary(b, s.short) },
        blocks: [...b.rich(s.short), ...b.layers(s.simple, s.tech),
          ...(present(s.failure) ? [b.heading('If it fails'), ...b.layers(s.failure.simple, s.failure.tech)] : []),
          b.details('Technical detail: data exchanged', [...b.facts([['Called by', s.calledBy], ['Data sent', s.sent], ['Data received', s.received],
            ['Webhooks / callbacks', s.webhooks], ['Config', s.config]], 4), ...(s.json || []).flatMap(item => b.json(item.body, item.title))])],
        used: ['id', 'name', 'kind', 'short', 'simple', 'tech', 'failure', 'calledBy', 'sent', 'received', 'webhooks', 'config', 'json'] };
    },
    errors(e, b) {
      return { value: { area: summary(b, e.area), message: summary(b, e.message), raiseIssue: e.escalate === true },
        blocks: [b.callout(e.escalate ? 'danger' : 'info', '“' + b.plain(e.message) + '”'),
          ...b.facts([['Area', e.area], ['Message key', e.key], ['Raise issue', e.escalate ? 'Yes' : 'Usually not']]),
          ...(present(e.meaning) ? [b.heading('What it means'), ...b.rich(e.meaning)] : []),
          ...(present(e.causes) ? [b.heading('Common causes'), ...b.rich(e.causes)] : []),
          ...(present(e.tell) ? [b.heading('Tell the user'), ...b.rich(e.tell)] : []),
          b.details('Technical detail', b.rich(e.tech)),
          ...(present(e.features) ? [b.heading('Related features'), b.references('feature', e.features)] : [])],
        used: ['id', 'message', 'title', 'key', 'area', 'meaning', 'causes', 'tell', 'tech', 'escalate', 'features'] };
    },
    notifications(n, b) {
      return { value: { channel: summary(b, n.channel), when: summary(b, n.when), to: summary(b, n.to) },
        blocks: [...b.facts([['Channel', n.channel], ['When', n.when], ['To', n.to]]), ...b.layers(n.simple, n.tech),
          ...(present(n.notReceived) ? [b.heading('Why it might not arrive'), b.callout('warning', n.notReceived)] : []),
          b.details('Payload', b.json(n.payload))],
        used: ['id', 'name', 'channel', 'when', 'to', 'simple', 'tech', 'payload', 'notReceived'] };
    },
    config(c, b) {
      return { value: { source: summary(b, c.source), controls: summary(b, c.controls), values: summary(b, c.values), secret: c.secret === true },
        blocks: [...(c.secret ? [b.callout('danger', 'Secret setting: its value is never shown in this documentation.')] : []),
          ...b.facts([['Name', c.name], ['Source', c.source], ['Default / values', c.values], ['Used by', c.usedBy]]),
          ...(present(c.controls) ? [b.heading('What it controls'), ...b.rich(c.controls)] : [])],
        used: ['id', 'name', 'source', 'controls', 'values', 'usedBy', 'secret'] };
    },
    troubleshooting(t, b) {
      return { value: { group: summary(b, t.group) },
        blocks: [...b.layers(t.simple, t.tech), ...(present(t.related) ? [b.heading('Related features'), b.references('feature', t.related)] : [])],
        used: ['id', 'title', 'group', 'simple', 'tech', 'related'] };
    },
    faq(q, b) {
      return { value: { group: summary(b, q.group || 'General') }, blocks: b.layers(q.a, q.tech), used: ['id', 'q', 'group', 'a', 'tech'] };
    },
    glossary(g, b) {
      return { value: { definition: summary(b, g.simple || g.tech) }, blocks: b.layers(g.simple, g.tech), used: ['id', 'term', 'simple', 'tech'] };
    },
    backend(e, b, ctx, record) {
      const kind = BACKEND_KINDS[record.collection]?.[1] || 'Backend';
      return { value: { kind, summary: summary(b, e.simple) },
        blocks: [...b.layers(e.simple, e.tech),
          ...(present(e.access) ? [b.heading('Required access'), ...b.rich(e.access)] : []),
          ...(present(e.steps) ? [b.heading('Step-by-step check'), ...b.rich(e.steps)] : []),
          ...b.facts([['Code last changed', e.codeDate]]),
          b.details('Technical detail', [...b.facts([['Source files', e.files], ['Engine', e.engine], ['Environment / configuration names', e.environment],
            ['Deployment', e.deployment], ['Auth / middleware', e.auth], ['Logging / monitoring', e.logging], ['Jobs / queues / caches', e.jobs],
            ['Identifiers', e.identifiers], ['Read-only lookup', e.lookup]], 4),
            ...(present(e.columns) ? [b.heading('Tables & columns', 4), b.table(['Table.column', 'Type', 'Meaning'], e.columns)] : []),
            ...(present(e.mappings) ? [b.heading('App field ↔ DB column / source', 4), b.table(['App field', 'Backend column / source', 'Evidence'], e.mappings)] : [])]),
          ...(present(e.normal) ? [b.heading('Normal'), ...b.rich(e.normal)] : []),
          ...(present(e.abnormal) ? [b.heading('Abnormal'), ...b.rich(e.abnormal)] : []),
          ...(present(e.escalation) ? [b.heading('Raise issue'), b.callout('warning', e.escalation)] : [])],
        used: ['id', 'name', 'simple', 'tech', 'access', 'codeDate', 'steps', 'files', 'engine', 'environment', 'deployment', 'auth', 'logging', 'jobs',
          'identifiers', 'lookup', 'columns', 'mappings', 'normal', 'abnormal', 'escalation'] };
    }
  };

  function envelope(page, id, title, value, blocks, order) {
    return { key: page + '/' + id, page, collection: SECTIONS[page].collection, title,
      data: { schemaVersion: 2, id, value, order, blocks } };
  }
  function finish(b, blocks) {
    // Drop empty builder results and keep block IDs unique across the article.
    return [...blocks.filter(Boolean), ...b.relatedBlocks()];
  }

  /** Convert one published v1 article using its v1 foundation as context. */
  function convertArticle(record, foundation, ctx = context(foundation)) {
    model.record(record);
    if (record.key === 'foundation') fail('use convertFoundation for the foundation');
    if (schema.isDynamic(record.data)) fail('record is already v2: ' + record.key);
    const build = articles[record.page];
    if (!build) fail('unsupported v1 page: ' + record.page);
    const b = builder(ctx, record.key);
    const result = build(record.data, b, ctx, record);
    const entry = ctx.nav.entries.find(item => item.key === record.key);
    const blocks = finish(b, [...result.blocks, ...b.leftovers(record.data, result.used)]);
    const value = Object.fromEntries(Object.entries(result.value).filter(([, item]) => item !== ''));
    return envelope(record.page, record.data.id, record.title, value, blocks, entry ? entry.order : 0);
  }

  function sectionBlocks(page, data, ctx) {
    const b = builder(ctx, 'foundation');
    const copy = data.copy || {};
    const intro = (value) => present(value) ? (object(value) ? b.layers(value.simple, value.tech) : b.rich(value)) : [];
    let blocks;
    switch (page) {
      case 'home': {
        const home = data.home || {};
        blocks = [...b.rich(copy.hero),
          ...(present(home.quickLinks) ? [b.heading('How can we help?'), { id: b.id(), type: 'cards', items: home.quickLinks.map(link => {
            const href = route(ctx, link.href);
            return { title: b.plain(link.title).slice(0, 256) || 'Link', ...(present(link.desc) ? { text: b.plain(link.desc) } : {}),
              ...(href ? { href } : {}), ...(link.icon ? { icon: link.icon } : {}) };
          }) }] : []),
          ...(present(home.simple) || present(home.tech) ? [b.heading('About this knowledge base'), ...b.layers(home.simple, home.tech)] : []),
          ...(present(home.stack) ? [b.heading('Tech stack'), { id: b.id(), type: 'cards', items: home.stack.map(item => ({
            title: b.plain(item.name).slice(0, 256) || 'Component', text: [item.area, item.desc].filter(present).map(b.plain).join(' — ') })) }] : []),
          ...(present(home.mainTasks) ? [b.heading('What users can do'), ...b.rich(home.mainTasks)] : []),
          ...(present(data.confirm) ? [b.heading('Open questions'), b.details('Needs confirmation (' + data.confirm.length + ')',
            [b.table(['Area', 'Question', 'Why it matters'], data.confirm.map(item => [item.area, item.text, item.why]))])] : [])];
        break;
      }
      case 'architecture': {
        const a = data.architecture || {};
        const flat = [];
        (function walk(nodes, prefix) {
          (nodes || []).forEach(node => { const path = prefix + node.name; flat.push([path, node.desc || '']); walk(node.children, path + '/'); });
        })(a.tree, '');
        blocks = [...b.layers(a.simple, a.tech),
          ...(present(a.simpleDiagram) ? [b.heading('The big picture'), ...b.diagram(a.simpleDiagram, a.simpleDiagramCaption)] : []),
          ...(present(a.impact) ? [b.heading('What users notice when a part fails'), b.table(['If this fails…', 'Users will notice…', 'Raise issue?'],
            a.impact.map(item => [item.part, item.effect, item.escalate ? 'Yes' : 'Usually not']))] : []),
          ...(present(a.diagram) ? [b.heading('Full system diagram'), ...b.diagram(a.diagram, a.diagramCaption)] : []),
          ...(present(a.layers) ? [b.heading('Layers'), ...b.rich(copy.layers), ...a.layers.map(layer => b.details(b.plain(layer.name) + (layer.short ? ' — ' + b.plain(layer.short) : ''), [
            ...b.rich(layer.desc), ...b.facts([['Folders', layer.folders], ['May call', layer.mayCall], ['Must not call', layer.mayNotCall]], 4),
            ...(present(layer.features) ? [b.heading('Features passing through this layer', 4), b.references('feature', layer.features)] : [])]))] : []),
          ...(present(a.lifecycle) || present(a.lifecycleText) ? [b.heading('Request lifecycle'), ...b.rich(a.lifecycleText), ...b.diagram(a.lifecycle, a.lifecycleCaption)] : []),
          ...(present(a.deployment) || present(a.environments) ? [b.heading('Deployment & environments'), ...b.rich(a.deployment),
            b.table(['Environment', 'Build config', 'Host + path', 'Route', 'Env header', 'Local DB name', 'Env banner', 'Distribution'], a.environments || []),
            ...b.diagram(a.deployDiagram, a.deployCaption)] : []),
          ...(flat.length ? [b.heading('Folder explorer'), ...b.rich(copy.folders), b.details('Folders (' + flat.length + ')', [b.table(['Path', 'Description'], flat, [code])])] : [])];
        break;
      }
      case 'roles': {
        const r = data.roles || {};
        blocks = [...b.layers(r.simple, r.tech), ...(r.sections || []).flatMap(item => [b.heading(item.title || 'Role'), ...b.layers(item.simple, item.tech),
          item.table ? b.table(item.table.headers || [], item.table.rows || []) : null])];
        break;
      }
      case 'apps': blocks = intro(data.applicationsIntro); break;
      case 'data-model': {
        const m = data.dataModel || {};
        blocks = [...intro(m), ...(present(m.diagram) || present(m.fnbDiagram) ? [b.details('Entity relationships',
          [...b.diagram(m.diagram, m.diagramCaption), ...b.diagram(m.fnbDiagram, m.fnbDiagramCaption)])] : [])];
        break;
      }
      case 'api': blocks = intro(data.apiIntro); break;
      case 'events': blocks = intro(data.eventsIntro); break;
      case 'notifications': blocks = intro(data.notificationsIntro); break;
      case 'config': blocks = intro(data.configIntro); break;
      case 'flows': blocks = [...intro(copy.flows), ...b.rich(copy.flowCaption)]; break;
      case 'backend': blocks = [...b.layers(copy.backendSimple, copy.backendTech),
        ...(present(data.backendRepositoryFacts) ? [b.details('Analysed source snapshots', [b.table(['Repository', 'Commit', 'Code date', 'Scope'],
          data.backendRepositoryFacts.map(item => [item.repository, item.commit, item.commitDate || item.codeDate, copy.backendScope]), [null, code])])] : [])];
        break;
      default: blocks = intro(copy[page]);
    }
    return finish(b, blocks);
  }

  function lookupArticle(data, ctx, order) {
    const b = builder(ctx, 'flows/lookup');
    const blocks = finish(b, [...b.rich(data.copy?.lookup), ...(data.dataSources || []).flatMap(item => [b.heading(item.name || item.id),
      ...b.facts([['Also called', item.aka]]), ...b.layers(item.simple, item.tech), ...(present(item.check) ? [b.heading('How to check', 3), ...b.rich(item.check)] : [])])]);
    return envelope('flows', 'lookup', ctx.labels.get('flows/lookup'), { summary: summary(b, data.copy?.lookupCard) }, blocks, order);
  }

  /** Convert the v1 foundation into a v2 foundation (plus generated foundation-owned articles). */
  function convertFoundation(foundation, ctx = context(foundation)) {
    model.record(foundation);
    if (foundation.key !== 'foundation') fail('expected the foundation record');
    if (schema.isDynamic(foundation.data)) fail('foundation is already v2');
    const data = foundation.data;
    const nav = ctx.nav;
    const tabs = model.ordered(nav.tabs).filter(tab => SECTIONS[tab.id]);
    const visible = tabs.filter(tab => tab.visible);
    const startPage = visible.find(tab => tab.id === 'home')?.id || visible[0]?.id;
    if (!startPage) fail('v1 navigation has no visible tab to use as the start page');
    const groups = nav.groups.filter(group => SECTIONS[group.tab]).map(group => ({ id: group.id, tab: group.tab, label: group.label, icon: group.icon, order: group.order, visible: group.visible }));
    const entries = nav.entries.filter(entry => entry.key !== 'foundation').map(entry => ({ id: entry.id, tab: entry.tab, group: entry.group,
      key: entry.key, label: entry.label, href: entry.href, order: entry.order, visible: entry.visible, searchable: entry.searchable,
      ...(entry.icon !== undefined ? { icon: entry.icon } : {}) }));
    const extra = [];
    nav.entries.filter(entry => entry.key === 'foundation').forEach(entry => {
      if (entry.href === '#/flows/lookup' && ctx.hasLookup) {
        entries.push({ id: entry.id, tab: 'flows', group: entry.group, key: 'flows/lookup', label: entry.label, href: '#/flows/lookup',
          order: entry.order, visible: entry.visible, searchable: entry.searchable, ...(entry.icon !== undefined ? { icon: entry.icon } : {}) });
        extra.push(lookupArticle(data, ctx, entry.order));
      } else if (entry.tab === 'backend' && BACKEND_KINDS['backend.' + entry.href.split('/')[2]]) {
        groups.push({ id: entry.id, tab: 'backend', label: entry.label, icon: nav.tabs.find(tab => tab.id === 'backend')?.icon || 'database',
          order: entry.order, visible: entry.visible });
      } else ctx.report.droppedNavigation.push({ id: entry.id, href: entry.href, reason: 'v2 navigation lists articles only; the content remains on its section page' });
    });
    // v1 backend articles are grouped by their logical collection.
    const backendGroups = new Map(nav.entries.filter(entry => entry.key === 'foundation' && entry.tab === 'backend')
      .map(entry => [entry.href.split('/')[2], entry.id]));
    entries.filter(entry => entry.tab === 'backend' && !entry.group).forEach(entry => {
      const groupId = backendGroups.get(ctx.backendKinds.get(entry.key));
      if (groupId) entry.group = groupId;
    });
    if (ctx.hasLookup && !entries.some(entry => entry.key === 'flows/lookup') && tabs.some(tab => tab.id === 'flows')) {
      entries.push({ id: 'field-lookup', tab: 'flows', group: '', key: 'flows/lookup', label: ctx.labels.get('flows/lookup'), href: '#/flows/lookup',
        order: 0, visible: true, searchable: true });
      extra.push(lookupArticle(data, ctx, 0));
    }
    const sections = tabs.map(tab => {
      const config = SECTIONS[tab.id];
      const blocks = sectionBlocks(tab.id, data, ctx);
      return { id: tab.id, collection: config.collection, layout: config.layout, sort: { field: 'order', direction: 'asc' },
        fields: config.fields.map(([key, label, type], index) => ({ key, label, type: type || 'text', order: index })),
        ...(blocks.length ? { blocks } : {}), order: tab.order, visible: tab.visible };
    });
    const navigation = {
      tabs: tabs.map(tab => ({ id: tab.id, label: tab.label, overviewLabel: tab.overviewLabel, icon: tab.icon,
        href: tab.id === startPage ? '#/' : '#/' + tab.id, order: tab.order, visible: tab.visible, ...(tab.id === startPage ? { expanded: true } : {}) })),
      groups, entries
    };
    // Icons: keep the v1 registry, then map built-in names and add the reader's UI icons.
    const icons = { ...(object(data.icons) ? data.icons : {}) };
    const references = new Set(UI_ICONS);
    [...navigation.tabs, ...navigation.groups, ...navigation.entries].forEach(item => { if (item.icon) references.add(item.icon); });
    sections.forEach(section => JSON.stringify(section.blocks || []).replace(/"icon":"([^"]+)"/g, (match, name) => { references.add(name); return match; }));
    references.forEach(name => {
      if (model.iconUrl(name) || own(icons, name)) return;
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) return;
      if (ICONS[name]) icons[name] = lucide(ICONS[name]);
      else { icons[name] = lucide('file-text'); ctx.report.warnings.push('Icon "' + name + '" has no known equivalent; using file-text.'); }
    });
    const used = ['meta', 'copy', 'home', 'architecture', 'roles', 'dataSources', 'confirm', 'applicationsIntro', 'dataModel', 'apiIntro',
      'eventsIntro', 'notificationsIntro', 'configIntro', 'backend', 'backendRepositoryFacts', 'navigation', 'icons', 'gitDates', 'schemaVersion'];
    Object.keys(data).filter(key => !used.includes(key) && present(data[key])).forEach(field => ctx.report.unmapped.push({ key: 'foundation', field, dropped: true }));
    const record = { key: 'foundation', page: 'foundation', collection: '', title: foundation.title,
      data: { schemaVersion: 2, meta: { ...data.meta }, icons, startPage, sections, navigation } };
    model.record(record);
    return [record, ...extra];
  }

  /** Convert a complete v1 snapshot (foundation + every article) into a validated v2 snapshot. */
  function convertSnapshot(records) {
    if (!Array.isArray(records) || !records.length) fail('expected a nonempty array of v1 records');
    const foundation = records.find(record => record.key === 'foundation');
    if (!foundation) fail('the v1 foundation record is required');
    const ctx = context(foundation, records);
    const converted = convertFoundation(foundation, ctx);
    const articlesOut = records.filter(record => record.key !== 'foundation').map(record => convertArticle(record, foundation, ctx));
    const result = [...converted, ...articlesOut];
    model.navigationRecords(result, true);
    result.forEach(record => model.record(record));
    return { records: result, report: summaryReport(ctx, result) };
  }
  function summaryReport(ctx, records) {
    return {
      format: 2,
      foundation: records.some(record => record.key === 'foundation'),
      articles: records.filter(record => record.key !== 'foundation').length,
      sections: records.find(record => record.key === 'foundation')?.data.sections.map(section => section.id) || [],
      unmapped: ctx.report.unmapped,
      brokenLinks: ctx.report.brokenLinks,
      droppedNavigation: ctx.report.droppedNavigation,
      warnings: ctx.report.warnings
    };
  }
  /** Convert a bounded batch: the v1 foundation supplies context; set includeFoundation for the v2 foundation. */
  function convertBatch(foundation, records = [], includeFoundation = false) {
    const ctx = context(foundation, records);
    const out = [...(includeFoundation ? convertFoundation(foundation, ctx) : []),
      ...records.filter(record => record.key !== 'foundation').map(record => convertArticle(record, foundation, ctx))];
    return { records: out, report: summaryReport(ctx, out) };
  }
  return Object.freeze({ convertSnapshot, convertBatch, convertFoundation, convertArticle, sections: SECTIONS });
});
