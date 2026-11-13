(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./documentation-model'));
  else root.DOCS_RENDERER = factory(root.DOCS_MODEL, root.DOCS_ICONS);
})(typeof window === 'object' ? window : globalThis, function (model, icons) {
  'use strict';
  const own = (value, key) => value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  const identifier = /^[a-zA-Z0-9_-]{1,120}$/;
  function escape(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function safePath(path) {
    return typeof path === 'string' && path.length <= 512 &&
      (!model.schema?.safePath || model.schema.safePath(path)) &&
      path.split('.').every(key => /^[a-zA-Z0-9_-]+$/.test(key) && !forbidden.has(key));
  }
  function at(value, path) {
    if (!safePath(path)) return undefined;
    for (const key of path.split('.')) {
      if (!own(value, key)) return undefined;
      value = value[key];
    }
    return value;
  }
  function safeUrl(value) {
    if (typeof value !== 'string' || /[\s\u0000-\u0020\u007f-\u009f\\]/u.test(value)) return null;
    if (value === '#/') return value;
    const route = /^#\/([a-zA-Z0-9_-]{1,120})(?:\/([a-zA-Z0-9_-]{1,120}))?$/.exec(value);
    if (route) {
      return (!model.schema?.safeSection || model.schema.safeSection(route[1])) &&
        (!route[2] || !model.schema?.safeId || model.schema.safeId(route[2])) ? value : null;
    }
    if (!/^https:\/\//i.test(value)) return null;
    if (model.schema?.publicUrl && !model.schema.publicUrl(value)) return null;
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.username || url.password || !host || host.includes(':') || !host.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|localdomain)$/.test(host)) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
          a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 ||
          a === 198 && (b === 18 || b === 19)) return null;
    }
    return value;
  }
  function readable(value, depth = 0, seen = new Set()) {
    if (value === undefined) return '[Missing]';
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
    if (depth >= 32) return '[Maximum depth reached]';
    if (seen.has(value)) return '[Circular value]';
    if (typeof value !== 'object') return '[Unsupported value]';
    seen.add(value);
    const result = Array.isArray(value) ? value.map(item => readable(item, depth + 1, seen)) :
      Object.fromEntries(Object.keys(value).map(key => [key, readable(value[key], depth + 1, seen)]));
    seen.delete(value);
    return result;
  }
  function json(value) {
    return '<pre class="docs-pre"><code>' + escape(JSON.stringify(readable(value), null, 2)) + '</code></pre>';
  }
  function formatValue(value, type, options = {}) {
    if (value === undefined) return '<span class="docs-missing">Not provided</span>';
    if (type === 'link' && typeof value === 'string') return link(value, value);
    if (type === 'json') return json(value);
    if (value !== null && typeof value === 'object') {
      const count = Object.keys(value).length;
      return '<details class="docs-value"' + (options.expanded ? ' open' : '') + '><summary>' +
        (Array.isArray(value) ? 'Array' : 'Object') + ' (' + count + ')</summary>' + json(value) + '</details>';
    }
    // Dates and mismatched field types retain the published text, never a guessed conversion.
    return '<span class="docs-scalar">' + escape(value) + '</span>';
  }
  // Table cells get visual focus points from their own text: the first column names the row, and
  // HTTP methods, paths, status codes, priorities, change types and yes/no answers become chips.
  // Only presentation changes; the published text is shown unchanged.
  const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\s+(?:…|\.\.\.)?\/\S*)?$/;
  function chip(tone, text) { return '<span class="docs-chip docs-chip-' + tone + '">' + escape(text) + '</span>'; }
  // Running text keeps its words; endpoints, paths, snake_case names and UPPER_CASE codes inside it
  // are shown as inline code so they stand out. The text is escaped first, so nothing becomes markup.
  // Endpoint mentions ("GET /v1/items", "GET …/items?status=open") come first so the whole mention is one chip.
  // HTTP status codes count only when nothing but punctuation or an UPPER_CASE code follows ("answers 401.", "409 LIST_FULL"),
  // so "200 open tasks" or "500 ms" stay plain numbers.
  const STATUS = '(?:200|201|202|204|301|302|304|400|401|403|404|405|409|410|413|415|422|429|500|502|503|504|[1-5]xx)';
  const STATUS_END = '(?=$|\\s*[,;:.)]|\\s+[A-Z][A-Z0-9]*_[A-Z0-9_]+)';
  const INLINE_CODE = new RegExp('\\b(GET|POST|PUT|PATCH|DELETE)\\s+((?:…|\\.\\.\\.)?(?:\\/[\\w{}:-]+)+\\/?(?:\\?[\\w=&;%.-]*[\\w=])?)|' +
    '\\b(' + STATUS + ')\\b(?:' + STATUS_END + '|(?=\\s+(?:answers?|responses?|errors?|status)\\b)|(?<=\\b(?:[Oo]n|answers?|returns?|gets?|HTTP|[Ss]tatus|code)\\s+(?:a\\s+|an\\s+)?' + STATUS + '))|' + /(?<![\w.])\/(?:[\w{}:-]+\/)*[\w{}:-]*\{?[\w-]+\}?(?=[\s,;)]|\.(?:\s|$)|$)|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.source, 'g');
  const statusTone = code => code[0] === '2' || code[0] === '1' ? 'success' : code[0] === '3' ? 'info' : code[0] === '4' ? 'warning' : 'danger';
  // Availability and lifecycle words read at a glance: green works, amber needs care, red is gone, grey is off.
  const AVAILABILITY = [
    [/^(Available|Supported|Enabled|Active|On|Stable|Live|Allowed|Done|Completed|Healthy|Operational|Passed)$/i, 'success'],
    [/^(Required|Limited|Partial|Deprecated|Pending|In progress|Degraded|Warning)$/i, 'warning'],
    [/^(Unavailable|Not available|Unsupported|Not supported|Removed|Blocked|Denied|Failed|Down|Outage|Breaking)$/i, 'danger'],
    [/^(Beta|Preview|Experimental|Planned|Coming soon|New)$/i, 'info'],
    [/^(Optional|Disabled|Off|Inactive|None|N\/A|Not required)$/i, 'neutral']
  ];
  const availabilityTone = text => AVAILABILITY.find(([pattern]) => pattern.test(text))?.[1] || null;
  // A row whose status column holds an HTTP status takes that status's colour on its stripe and codes.
  function rowTone(row, columns) {
    const column = columns.find(item => /status/i.test(String(item.label || item.key)));
    const value = column && at(row, column.key);
    const status = (typeof value === 'string' || typeof value === 'number') && new RegExp('^(?:HTTP\\s+)?(' + STATUS + ')\\b').exec(String(value).trim());
    return status ? ' class="docs-row-' + statusTone(status[1]) + '"' : '';
  }
  function methodChip(method, path) {
    return '<span class="docs-method docs-method-' + method.toLowerCase() + '">' + method + '</span>' + (path ? ' ' + path : '');
  }
  // While a page renders, the API articles it may link to: [{ method, pattern, suffix, href }].
  let endpoints = [];
  function endpointIndex(docs, reader) {
    if (!docs?.sections || !docs.navigation) return [];
    return docs.sections.flatMap(section => {
      const tab = docs.navigation.tabs?.find(item => item.id === section.id && item.visible !== false);
      if (!tab || section.visible === false || !forReader(tab, reader)) return [];
      return model.dynamicItems(docs, section.id).filter(record => typeof record.data.value?.method === 'string' && typeof record.data.value?.path === 'string')
        .map(record => {
          const template = record.data.value.path.split('?')[0];
          const pattern = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}/]+\}/g, '(?:\\{[^/]+\\}|[^/]+)');
          return { method: record.data.value.method.toUpperCase(), template, pattern: new RegExp('^' + pattern + '$'), href: '#/' + record.key };
        });
    });
  }
  // The API article for a mention: an exact path (with values or {params}), or a "…/tail" that only one endpoint ends with.
  function endpointHref(method, path) {
    const clean = path.replace(/&amp;/g, '&').split('?')[0].replace(/\/$/, '');
    const shortened = /^(?:…|\.\.\.)/.test(clean);
    const tail = clean.replace(/^(?:…|\.\.\.)/, '');
    const found = endpoints.filter(item => item.method === method && (shortened ? item.template.endsWith(tail) : item.pattern.test(clean)));
    return found.length === 1 ? found[0].href : null;
  }
  function inline(value) {
    return escape(value).replace(INLINE_CODE, (match, method, path, status) => {
      if (status) return '<span class="docs-chip docs-chip-' + statusTone(status) + '">' + status + '</span>';
      if (method) {
        const href = endpointHref(method, path);
        const chip = methodChip(method, path);
        return href ? '<a class="docs-inline-code docs-endpoint-link" href="' + escape(href) + '">' + chip + '</a>' : '<code class="docs-inline-code">' + chip + '</code>';
      }
      return match.length > 2 ? '<code class="docs-inline-code">' + match + '</code>' : match;
    });
  }
  function cell(value, column) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return formatValue(value);
    const text = String(value).trim();
    const label = String(column.label || column.key);
    const method = METHOD.exec(text);
    if (method) {
      const href = method[2] ? endpointHref(method[1], method[2].trim()) : null;
      const chip = methodChip(method[1], method[2] ? escape(method[2].trim()) : '');
      return href ? '<a class="docs-code-cell docs-endpoint-link" href="' + escape(href) + '">' + chip + '</a>' : '<code class="docs-code-cell">' + chip + '</code>';
    }
    if (/^\/[\w{}:./-]*$/.test(text) && text.length > 1) return '<code class="docs-code-cell">' + escape(text) + '</code>';
    // A leading HTTP status becomes a chip; any explanation after it stays plain text.
    const status = new RegExp('^(?:HTTP\\s+)?(' + STATUS + ')(?:\\s+(?:OK|Created|Accepted|No Content|Gone|Not Found|Bad Request|Unauthorized|Forbidden|Conflict|Unprocessable Entity|Too Many Requests))?' +
      STATUS_END.replace('$|', '$|\\s+[A-Z][A-Z0-9]{2,}\\b|')).exec(text);
    if (status) {
      const rest = text.slice(status[0].length).replace(/^[\s,;:–-]+/, '');
      return chip(statusTone(status[1]), status[0]) + (rest ? ' <span class="docs-scalar">' + inline(rest) + '</span>' : '');
    }
    if (/^P[0-3]$/.test(text)) return chip(text === 'P0' || text === 'P1' ? 'danger' : text === 'P2' ? 'warning' : 'neutral', text);
    if (/^(New|Changed|Hotfix)$/.test(text) && /type|tag|change/i.test(label)) return chip(text === 'New' ? 'success' : text === 'Hotfix' ? 'danger' : 'info', text);
    if (/^(Yes|No|true|false)$/i.test(text)) return chip(/^(yes|true)$/i.test(text) ? 'success' : 'neutral', text);
    const availability = availabilityTone(text);
    if (availability) return chip(availability, text);
    // Dotted names in a name column ("task.completed") are events or keys, so they read as code.
    if (/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9_]*)+$/.test(text)) return '<code class="docs-code-cell">' + escape(text) + '</code>';
    if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(text) || /code$/i.test(label) && /^[\w.:-]{1,40}$/.test(text)) return '<code class="docs-code-cell">' + escape(text) + '</code>';
    if (/message|user sees|what you see|shown/i.test(label)) return '<span class="docs-quote-cell">' + escape(text) + '</span>';
    return typeof value === 'string' ? '<span class="docs-scalar">' + inline(value) + '</span>' : formatValue(value);
  }
  function link(href, label, cls = '') {
    const url = safeUrl(href);
    return url ? '<a' + (cls ? ' class="' + escape(cls) + '"' : '') + ' href="' + escape(url) + '"' +
      (/^https:/i.test(url) ? ' rel="noopener noreferrer"' : '') + '>' + escape(label) + '</a>' :
      '<span' + (cls ? ' class="' + escape(cls) + '"' : '') + '>' + escape(label) + '</span>';
  }
  function ordered(items) {
    return (Array.isArray(items) ? items : []).map((item, index) => ({ item, index }))
      .sort((a, b) => (Number.isSafeInteger(a.item.order) ? a.item.order : 0) -
        (Number.isSafeInteger(b.item.order) ? b.item.order : 0) ||
        String(a.item.id || '').localeCompare(String(b.item.id || ''), 'en') || a.index - b.index)
      .map(({ item }) => item);
  }
  function fieldDefinitions(value, fields) {
    if (Array.isArray(fields)) return ordered(fields.filter(field => field.visible !== false && safePath(field.key)));
    return value && typeof value === 'object' && !Array.isArray(value) ?
      Object.keys(value).map(key => ({ key, label: key, inferred: true })) : [];
  }
  // Field values use the same formatting as table cells: method chips, code paths, status and yes/no chips.
  function fieldValue(value, field, options) {
    return field.type === 'link' || field.type === 'json' || value === undefined || value === null || typeof value === 'object' ?
      formatValue(value, field.type, options) : cell(value, field);
  }
  function renderFields(value, fields, options = {}) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return formatValue(value, undefined, options);
    const definitions = fieldDefinitions(value, fields);
    return '<dl class="docs-fields' + (options.summary ? ' docs-summary' : '') + '">' + definitions.map(field => '<div class="docs-field"><dt>' +
      escape(field.label || field.key) + '</dt><dd>' +
      fieldValue(field.inferred ? value[field.key] : at(value, field.key), field, options) + '</dd></div>').join('') + '</dl>';
  }
  function artwork(reference, docs) {
    return reference && icons && typeof icons.render === 'function' ? icons.render(reference, 'icon', docs) : '';
  }
  // A reader sees blocks meant for everyone plus those listing their reader type; without a reader
  // (administrators, or nobody assigned) everything is shown and limited blocks carry a reader badge.
  const READER_LABELS = { 'end-users': 'End users', support: 'Support', testers: 'Testers', 'product-owners': 'Product owners',
    administrators: 'Administrators', developers: 'Developers', internal: 'Engineering' };
  function forReader(item, reader) {
    return !reader || !Array.isArray(item.audiences) || item.audiences.includes(reader);
  }
  function readerBadges(item, reader) {
    return !reader && Array.isArray(item.audiences) ? ' <span class="docs-audience">' +
      item.audiences.map(value => escape(READER_LABELS[value] || value)).join(' · ') + '</span>' : '';
  }
  function cardKind(href, docs) {
    if (/^https:/i.test(href)) return 'External link';
    const tab = docs?.navigation?.tabs?.find(item => item.id === href.split('/')[1]);
    return tab ? tab.label : 'Open page';
  }
  function cardTitle(title) {
    const method = METHOD.exec(String(title).trim());
    return method && method[2] ? '<code class="docs-code-cell">' + methodChip(method[1], escape(method[2].trim())) + '</code>' : escape(title);
  }
  function card(item, docs) {
    const url = item.href ? safeUrl(item.href) : null;
    const text = item.text !== undefined ? '<p class="docs-prose">' + inline(item.text) + '</p>' : '';
    if (!url) return '<article class="docs-card docs-card-static">' + artwork(item.icon, docs) + '<h3>' + cardTitle(item.title) + '</h3>' + text + '</article>';
    return '<article class="docs-card docs-card-link">' + artwork(item.icon, docs) +
      '<span class="docs-card-kind">' + escape(cardKind(url, docs)) + '</span><h3><a href="' + escape(url) + '"' +
      (/^https:/i.test(url) ? ' rel="noopener noreferrer"' : '') + '>' + cardTitle(item.title) + '</a></h3>' + text +
      '<span class="docs-card-cta" aria-hidden="true">' + (/^https:/i.test(url) ? 'Open link ↗' : 'Open →') + '</span></article>';
  }
  function renderBlocks(blocks, docs, depth = 0, reader = null) {
    if (depth > 32) throw new Error('Documentation blocks exceed maximum nesting depth');
    if (!Array.isArray(blocks)) throw new Error('Documentation blocks must be an array');
    return ordered(blocks).filter(block => block.visible !== false && forReader(block, reader)).map(block => {
      switch (block.type) {
        case 'heading': {
          const level = [2, 3, 4].includes(block.level) ? block.level : 2;
          return '<h' + level + '>' + escape(block.text) + readerBadges(block, reader) + '</h' + level + '>';
        }
        case 'paragraph': return '<p class="docs-prose">' + inline(block.text) + '</p>';
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul';
          return '<' + tag + '>' + block.items.map(item => '<li>' + inline(item) + '</li>').join('') + '</' + tag + '>';
        }
        case 'table': {
          const columns = ordered(block.columns).filter(column => column.visible !== false);
          return '<div class="docs-table-wrap"><table class="docs-table"><thead><tr>' +
            columns.map(column => '<th scope="col">' + escape(column.label || column.key) + '</th>').join('') +
            '</tr></thead><tbody>' + block.rows.map(row => '<tr' + rowTone(row, columns) + '>' + columns.map((column, index) => index === 0 && columns.length > 1 ?
              '<th scope="row">' + cell(at(row, column.key), column) + '</th>' :
              '<td>' + cell(at(row, column.key), column) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
        }
        case 'callout': {
          const tone = ['info', 'warning', 'success', 'danger'].includes(block.tone) ? block.tone : 'info';
          return '<aside class="docs-callout docs-callout-' + tone + '">' + inline(block.text) + '</aside>';
        }
        case 'code': return '<pre class="docs-pre"><code' +
          (typeof block.language === 'string' && !/\s/.test(block.language) && /^[a-zA-Z0-9_+-]{1,40}$/.test(block.language) ?
            ' class="language-' + block.language + '"' : '') + '>' + escape(block.code) + '</code></pre>';
        case 'diagram': return '<div class="mermaid">' + escape(block.source) + '</div>';
        case 'image': {
          const src = safeUrl(block.src);
          return '<figure class="docs-image">' + (src && /^https:\/\//i.test(src) ?
            '<img src="' + escape(src) + '" alt="' + escape(block.alt || '') + '" loading="lazy" referrerpolicy="no-referrer">' :
            '<span>' + escape(block.alt || 'Image unavailable') + '</span>') +
            (block.caption ? '<figcaption>' + escape(block.caption) + '</figcaption>' : '') + '</figure>';
        }
        case 'link': return '<p>' + link(block.href, block.label) + '</p>';
        case 'cards': {
          // A card pointing into a section this reader cannot open is left out.
          const items = ordered(block.items).filter(item => item.visible !== false && !(reader && typeof item.href === 'string' &&
            docs?.navigation?.tabs?.some(tab => tab.id === item.href.split('/')[1] && !forReader(tab, reader))));
          return items.length ? '<div class="docs-cards">' + items.map(item => card(item, docs)).join('') + '</div>' : '';
        }
        case 'details': return '<details class="docs-details"' + (block.expanded ? ' open' : '') + '><summary>' +
          escape(block.title) + readerBadges(block, reader) + '</summary>' + renderBlocks(block.blocks, docs, depth + 1, reader) + '</details>';
        case 'json': return json(block.value);
        case 'fields': return renderFields(block.value, block.fields);
        default: throw new Error('Unsupported documentation block type: ' + String(block.type));
      }
    }).join('');
  }
  // Long articles: level-2 headings with a `group` split the article into tabs (Overview, How to use,
  // Questions, Technical…). Every panel is rendered; the reader script shows one at a time, print shows all.
  function renderArticleBlocks(blocks, docs, reader) {
    const shown = ordered(blocks).filter(block => block.visible !== false && forReader(block, reader));
    if (!shown.some(block => block.type === 'heading' && block.level === 2 && typeof block.group === 'string')) return renderBlocks(blocks, docs, 0, reader);
    const groups = new Map(), lead = [];
    let current = null;
    for (const block of shown) {
      if (block.type === 'heading' && block.level === 2 && typeof block.group === 'string') current = block.group;
      if (current === null) { lead.push(block); continue; }
      if (!groups.has(current)) groups.set(current, []);
      groups.get(current).push(block);
    }
    const names = [...groups.keys()];
    if (names.length < 2) return renderBlocks(blocks, docs, 0, reader);
    const count = name => groups.get(name).filter(block => block.type === 'heading' && block.level === 2).length;
    return renderBlocks(lead, docs, 0, reader) + '<div class="docs-groups" data-docs-groups><div class="docs-group-tabs" role="tablist" aria-label="Article parts">' +
      names.map((name, index) => '<button type="button" role="tab" class="docs-group-tab" data-group-tab="' + index + '" aria-selected="' + (index === 0) + '">' +
        escape(name) + '<span class="docs-group-count">' + count(name) + '</span></button>').join('') +
      '<button type="button" class="docs-group-tab docs-group-all" data-group-tab="all">Show all</button></div>' +
      names.map((name, index) => '<section class="docs-group" role="tabpanel" data-group-panel="' + index + '" data-group-name="' + escape(name) + '">' +
        renderBlocks(groups.get(name), docs, 0, reader) + '</section>').join('') + '</div>';
  }
  function renderPage(docs, sectionId, id, options = {}) {
    endpoints = endpointIndex(docs, options.reader || null);
    try { return renderPageBody(docs, sectionId, id, options); } finally { endpoints = []; }
  }
  function renderPageBody(docs, sectionId, id, options) {
    if (!docs || docs.schemaVersion !== 2 || !identifier.test(sectionId)) return null;
    const section = Array.isArray(docs.sections) ? docs.sections.find(item => item.id === sectionId) : null;
    const reader = options.reader || null;
    const tab = docs.navigation?.tabs?.find(item => item.id === sectionId && item.visible !== false && forReader(item, reader));
    if (!section || section.visible === false || !tab) return null;
    const manifest = options.manifest || Object.fromEntries((docs.records || []).map(record => [record.key, true]));
    const entries = model.navigationEntries(docs.navigation, manifest, sectionId);
    const visible = new Map(entries.map(entry => [entry.key, entry]));
    const items = model.dynamicItems(docs, sectionId).filter(record => visible.has(record.key));
    const title = tab.label;
    const overviewHref = '#/' + sectionId;
    if (id !== undefined && id !== null && id !== '') {
      if (!identifier.test(id)) return null;
      const record = items.find(item => item.data.id === id && item.key === sectionId + '/' + id);
      if (!record) return null;
      const blocks = record.data.blocks || [];
      const hasBlocks = blocks.some(block => block.visible !== false);
      // Authored blocks replace inferred values; explicitly configured fields always opt in.
      const fields = Array.isArray(section.fields) || !hasBlocks ?
        renderFields(record.data.value, section.fields, { expanded: section.defaultExpanded, summary: hasBlocks }) : '';
      // With written blocks, the fields are a short summary under the title (for example Method, Path, Authentication).
      return { title: record.title,
        html: '<article class="dynamic-documentation docs-article"><h1>' + escape(record.title) + '</h1>' +
          (hasBlocks ? fields + renderArticleBlocks(blocks, docs, reader) : renderArticleBlocks(blocks, docs, reader) + fields) + '</article>',
        crumbs: [{ label: title, href: overviewHref }, { label: record.title }] };
    }
    let content;
    if (section.layout === 'table') {
      const definitions = Array.isArray(section.fields) ? fieldDefinitions({}, section.fields) :
        [...new Set(items.flatMap(record => Object.keys(record.data.value && typeof record.data.value === 'object' &&
          !Array.isArray(record.data.value) ? record.data.value : {})))].map(key => ({ key, label: key, inferred: true }));
      content = '<div class="docs-table-wrap"><table class="docs-table"><thead><tr><th scope="col">Title</th>' +
        definitions.map(field => '<th scope="col">' + escape(field.label || field.key) + '</th>').join('') +
        '</tr></thead><tbody>' + items.map(record => '<tr data-documentation-key="' + escape(record.key) + '"><th scope="row">' +
          link(visible.get(record.key).href, record.title) + '</th>' + definitions.map(field =>
          '<td>' + fieldValue(field.inferred ? own(record.data.value, field.key) ? record.data.value[field.key] : undefined :
            at(record.data.value, field.key), field, { expanded: section.defaultExpanded }) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    } else {
      const list = section.layout === 'list';
      content = '<' + (list ? 'ul class="docs-list"' : 'div class="docs-cards"') + '>' +
        items.map(record => {
          const entry = visible.get(record.key);
          const group = docs.navigation.groups?.find(item => item.id === entry.group);
          return '<' + (list ? 'li' : 'article') + ' class="docs-card" data-documentation-key="' + escape(record.key) + '">' +
            artwork(entry.icon || group?.icon || tab.icon, docs) +
            '<h2>' + link(entry.href, record.title) + '</h2>' +
            renderFields(record.data.value, section.fields, { expanded: section.defaultExpanded }) + '</' + (list ? 'li' : 'article') + '>';
        }).join('') + '</' + (list ? 'ul' : 'div') + '>';
    }
    return { title, html: '<section class="dynamic-documentation docs-section"><h1>' + escape(title) + '</h1>' +
      renderBlocks(section.blocks || [], docs, 0, reader) + content + '</section>', crumbs: [{ label: title }] };
  }
  function valueText(value) {
    if (value === undefined) return 'Not provided';
    return value !== null && typeof value === 'object' ? JSON.stringify(readable(value), null, 2) : String(value);
  }
  function fieldsText(value, fields) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return valueText(value);
    return fieldDefinitions(value, fields).map(field => (field.label || field.key) + ' ' +
      valueText(field.inferred ? value[field.key] : at(value, field.key))).join(' ');
  }
  function blocksText(blocks, depth = 0, reader = null) {
    if (depth > 32) throw new Error('Documentation blocks exceed maximum nesting depth');
    return ordered(blocks).filter(block => block.visible !== false && forReader(block, reader)).map(block => {
      switch (block.type) {
        case 'heading':
        case 'paragraph':
        case 'callout': return block.text;
        case 'list': return block.items.join(' ');
        case 'table': {
          const columns = ordered(block.columns).filter(column => column.visible !== false);
          return columns.map(column => column.label || column.key).join(' ') + ' ' +
            block.rows.map(row => columns.map(column => valueText(at(row, column.key))).join(' ')).join(' ');
        }
        case 'code': return block.code;
        case 'diagram': return block.source;
        case 'image': return (block.alt || '') + ' ' + (block.caption || '');
        case 'link': return block.label;
        case 'cards': return ordered(block.items).filter(item => item.visible !== false)
          .map(item => item.title + ' ' + (item.text === undefined ? '' : item.text)).join(' ');
        case 'details': return block.title + ' ' + blocksText(block.blocks, depth + 1, reader);
        case 'json': return valueText(block.value);
        case 'fields': return fieldsText(block.value, block.fields);
        default: throw new Error('Unsupported documentation block type: ' + String(block.type));
      }
    }).join(' ');
  }
  function searchText(docs, record, reader = null) {
    if (!docs || docs.schemaVersion !== 2 || !record) return '';
    const section = docs.sections?.find(item => item.id === record.page && item.visible !== false);
    if (!section) return '';
    const manifest = Object.fromEntries((docs.records || []).map(item => [item.key, true]));
    const entry = model.navigationEntries(docs.navigation, manifest, record.page)
      .find(item => item.key === record.key && item.searchable !== false);
    if (!entry) return '';
    const blocks = record.data.blocks || [];
    const hasBlocks = blocks.some(block => block.visible !== false);
    const values = Array.isArray(section.fields) || !hasBlocks ? fieldsText(record.data.value, section.fields) : '';
    return [record.title, blocksText(blocks, 0, reader), values].join(' ').replace(/\s+/g, ' ').trim();
  }
  function searchSection(docs, sectionId, reader = null) {
    const section = docs?.sections?.find(item => item.id === sectionId && item.visible !== false);
    const tab = docs?.navigation?.tabs?.find(item => item.id === sectionId && item.visible);
    return section && tab && forReader(tab, reader) ? blocksText(section.blocks || [], 0, reader).replace(/\s+/g, ' ').trim() : '';
  }
  return Object.freeze({ renderPage, renderBlocks, formatValue, safeUrl, searchText, searchSection, forReader, readerLabels: READER_LABELS });
});
