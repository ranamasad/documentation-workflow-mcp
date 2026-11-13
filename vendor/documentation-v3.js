(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('node:crypto').webcrypto, require('./documentation-model'), require('./documentation-convert'));
  } else root.DOCS_V3 = factory(root.crypto, root.DOCS_MODEL, root.DOCS_CONVERT);
})(typeof window === 'object' ? window : globalThis, function (crypto, model, converter) {
  'use strict';
  const MAX_ENVELOPE = 950000, MAX_PLAIN = 32 * 1024 * 1024, MAX_RECORD = 700000;
  const MIN_ITERATIONS = 600000, MAX_ITERATIONS = 2000000;
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;
  const digestPattern = /^[0-9a-f]{64}(?![\s\S])/;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function fail(message) { throw new Error('Invalid v3 documentation: ' + message); }
  function exact(value, fields, label) {
    if (!object(value) || Object.keys(value).length !== fields.length ||
        fields.some(field => !Object.prototype.hasOwnProperty.call(value, field))) fail(label + ' fields');
  }
  function canonical(value) {
    function visit(item, depth) {
      if (depth > 64) fail('canonical JSON depth');
      if (item === null || typeof item === 'boolean') return JSON.stringify(item);
      if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
      if (typeof item === 'string') return JSON.stringify(item).replace(/[\u007f-\uffff]/g,
        character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length ||
            Object.keys(item).some((key, index) => key !== String(index))) fail('canonical JSON sparse array or extra properties');
        return '[' + item.map(child => visit(child, depth + 1)).join(',') + ']';
      }
      if (object(item) && (Object.getPrototypeOf(item) === null || Object.getPrototypeOf(Object.getPrototypeOf(item)) === null)) {
        return '{' + Object.keys(item).sort().map(key => visit(key, depth + 1) + ':' + visit(item[key], depth + 1)).join(',') + '}';
      }
      fail('canonical JSON value');
    }
    return visit(value, 0);
  }
  async function hash(value) {
    if (typeof value !== 'string') fail('hash expects a string');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
      byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function encode(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function base64(value, min, max, label) {
    if (typeof value !== 'string' || value.length < Math.ceil(min * 4 / 3) ||
        value.length > Math.ceil(max * 4 / 3) || /[^A-Za-z0-9_-]/.test(value) || value.length % 4 === 1) fail(label + ' base64url');
    const bytes = Math.floor(value.length * 3 / 4);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(value[value.length - 1]);
    if (bytes < min || bytes > max || value.length % 4 === 2 && last % 16 || value.length % 4 === 3 && last % 4) fail(label + ' length or padding');
    return bytes;
  }
  function decode(value, min, max, label) {
    base64(value, min, max, label);
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  }
  const random = size => crypto.getRandomValues(new Uint8Array(size));
  function scopeValue(scope) {
    exact(scope, ['projectId', 'environment', 'keyId'], 'scope');
    if (typeof scope.projectId !== 'string' || !uuid.test(scope.projectId) ||
        typeof scope.keyId !== 'string' || !uuid.test(scope.keyId) ||
        !['development', 'beta', 'production'].includes(scope.environment)) fail('scope');
    return scope;
  }
  function sameScope(actual, expected) {
    scopeValue(actual);
    if (expected !== undefined && canonical(actual) !== canonical(scopeValue(expected))) fail('scope mismatch');
  }
  function validateEnvelope(envelope, scope) {
    exact(envelope, ['format', 'scope', 'iv', 'ciphertext', 'encoding', 'plainBytes'], 'envelope');
    if (envelope.format !== 3 || envelope.encoding !== 'gzip' || !Number.isSafeInteger(envelope.plainBytes) ||
        envelope.plainBytes < 1 || envelope.plainBytes > MAX_PLAIN) fail('envelope encoding or plaintext size');
    sameScope(envelope.scope, scope);
    base64(envelope.iv, 12, 12, 'envelope IV');
    base64(envelope.ciphertext, 16, MAX_ENVELOPE, 'envelope ciphertext');
    if (canonical(envelope).length > MAX_ENVELOPE) fail('serialized envelope exceeds 950000 bytes');
    return envelope;
  }
  function validateRelease(release, scope) {
    exact(release, ['format', 'scope', 'manifest', 'bundles', 'recordCount'], 'release');
    if (release.format !== 3 || !Number.isSafeInteger(release.recordCount) || release.recordCount < 1 ||
        release.recordCount > 2000 || !Array.isArray(release.bundles) || !release.bundles.length ||
        release.bundles.length > release.recordCount || new Set(release.bundles).size !== release.bundles.length ||
        release.bundles.some(id => typeof id !== 'string' || !digestPattern.test(id))) fail('release count or bundle IDs');
    sameScope(release.scope, scope);
    validateEnvelope(release.manifest, release.scope);
    return release;
  }
  function publicKey(value) {
    if (!object(value) || Object.keys(value).some(key => !['kty', 'n', 'e', 'alg', 'ext', 'key_ops'].includes(key)) ||
        value.kty !== 'RSA' || value.e !== 'AQAB' ||
        value.alg !== undefined && value.alg !== 'RSA-OAEP-256' ||
        value.ext !== undefined && value.ext !== true ||
        value.key_ops !== undefined && (!Array.isArray(value.key_ops) ||
          value.key_ops.some(op => op !== 'encrypt' && op !== 'wrapKey') || new Set(value.key_ops).size !== value.key_ops.length)) fail('RSA public JWK');
    const size = base64(value.n, 256, 512, 'RSA modulus');
    if (![256, 384, 512].includes(size)) fail('RSA modulus size');
    return { e: value.e, kty: value.kty, n: value.n };
  }
  function sealed(value, password) {
    exact(value, password ? ['iv', 'ciphertext', 'kdf'] : ['iv', 'ciphertext'], 'sealed private key');
    base64(value.iv, 12, 12, 'sealed IV');
    base64(value.ciphertext, 16, 16400, 'sealed ciphertext');
    if (password) {
      exact(value.kdf, ['name', 'hash', 'iterations', 'salt'], 'KDF');
      if (value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256' ||
          !Number.isSafeInteger(value.kdf.iterations) || value.kdf.iterations < MIN_ITERATIONS ||
          value.kdf.iterations > MAX_ITERATIONS) fail('PBKDF2 iterations or algorithm');
      base64(value.kdf.salt, 16, 16, 'KDF salt');
    }
  }
  function validateVault(vault) {
    exact(vault, ['format', 'publicKey', 'fingerprint', 'password', 'recovery'], 'vault');
    if (vault.format !== 3 || typeof vault.fingerprint !== 'string' || !digestPattern.test(vault.fingerprint)) fail('vault version or fingerprint');
    publicKey(vault.publicKey);
    sealed(vault.password, true);
    sealed(vault.recovery, false);
    return vault;
  }
  function validateGrant(grant, scope) {
    exact(grant, ['format', 'scope', 'recipient', 'wrappedKey'], 'grant');
    if (grant.format !== 3 || typeof grant.recipient !== 'string' || !digestPattern.test(grant.recipient)) fail('grant version or recipient');
    sameScope(grant.scope, scope);
    if (![256, 384, 512].includes(base64(grant.wrappedKey, 256, 512, 'wrapped key'))) fail('wrapped key size');
    return grant;
  }
  function releaseMetadata(value) {
    exact(value, ['version', 'tags', 'summary', 'operation',
      ...(object(value) && Object.prototype.hasOwnProperty.call(value, 'sourceRelease') ? ['sourceRelease'] : []),
      ...(object(value) && Object.prototype.hasOwnProperty.call(value, 'rollbackRelease') ? ['rollbackRelease'] : [])], 'manifest metadata');
    if (typeof value.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?![\s\S])/.test(value.version) ||
        !Array.isArray(value.tags) || !value.tags.length || value.tags.length > 3 ||
        new Set(value.tags).size !== value.tags.length || value.tags.some(tag => !['New', 'Changed', 'Hotfix'].includes(tag)) ||
        typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 4000 ||
        !['apply', 'promote', 'rollback', 'import'].includes(value.operation)) fail('manifest metadata version, tags, summary or operation');
    for (const field of ['sourceRelease', 'rollbackRelease']) {
      if (Object.prototype.hasOwnProperty.call(value, field) &&
          (typeof value[field] !== 'string' || !uuid.test(value[field]))) fail('manifest metadata ' + field);
    }
    return value;
  }
  function contentModel() {
    if (!model) fail('DOCS_MODEL is required for content operations');
    return model;
  }
  function normalize(records) {
    contentModel();
    if (!Array.isArray(records) || records.length < 1 || records.length > 2000) fail('snapshot must contain 1..2000 records');
    let bytes = 2;
    records.forEach(record => {
      model.record(record);
      const size = canonical(record).length;
      if (size > MAX_RECORD) fail('record exceeds 700000 ASCII bytes');
      bytes += size + 1;
      if (bytes > MAX_PLAIN) fail('snapshot exceeds 32 MiB');
    });
    const foundation = records.find(record => record.key === 'foundation');
    if (!foundation) fail('snapshot lacks foundation');
    let result;
    if (!model.isDynamic(foundation.data)) {
      if (!converter) fail('DOCS_CONVERT is required for legacy conversion');
      const convert = converter.convert || converter.convertSnapshot;
      if (typeof convert !== 'function') fail('legacy converter unavailable');
      result = convert(records);
    } else result = { records, report: {
      format: 2, foundation: true, articles: records.length - 1,
      sections: foundation.data.sections.map(section => section.id),
      unmapped: [], brokenLinks: [], droppedNavigation: [], warnings: []
    } };
    const output = JSON.parse(canonical(result.records));
    if (output.length > 2000 || canonical(output).length > MAX_PLAIN) fail('normalized snapshot size');
    output.forEach(record => {
      model.record(record);
      if (canonical(record).length > MAX_RECORD || !model.isDynamic(record.data)) fail('normalized record size or format');
    });
    model.navigationRecords(output, true);
    model.assemble(output);
    const keys = new Set(output.map(record => record.key));
    output.find(record => record.key === 'foundation').data.navigation.entries.forEach(entry => {
      if (!keys.has(entry.key)) fail('navigation points to missing record: ' + entry.key);
    });
    return { records: output, report: result.report };
  }
  async function aes(raw) {
    return crypto.subtle.importKey('raw', decode(raw, 32, 32, 'content key'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function passwordKey(password, kdf) {
    if (typeof password !== 'string' || !password.length || encoder.encode(password).length > 1024) fail('password must contain 1..1024 UTF-8 bytes');
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations,
      salt: decode(kdf.salt, 16, 16, 'KDF salt') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function vaultHeader(fingerprint, purpose, kdf) {
    return encoder.encode(canonical({ format: 3, purpose, fingerprint, ...(kdf ? { kdf } : {}) }));
  }
  async function sealPrivate(bytes, key, fingerprint, purpose, kdf) {
    const iv = random(12);
    return { iv: encode(iv), ciphertext: encode(new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, additionalData: vaultHeader(fingerprint, purpose, kdf), tagLength: 128
    }, key, bytes))), ...(kdf ? { kdf } : {}) };
  }
  async function createVault(password) {
    const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: MIN_ITERATIONS, salt: encode(random(16)) };
    const passwordAes = await passwordKey(password, kdf);
    const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const exportedPublic = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const fingerprint = await hash(canonical(publicKey(exportedPublic)));
    const bytes = encoder.encode(canonical(jwk)), recoveryBytes = random(32), recoveryCode = encode(recoveryBytes);
    const recoveryAes = await crypto.subtle.importKey('raw', recoveryBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    try {
      const vault = { format: 3, publicKey: exportedPublic, fingerprint,
        password: await sealPrivate(bytes, passwordAes, fingerprint, 'password', kdf),
        recovery: await sealPrivate(bytes, recoveryAes, fingerprint, 'recovery') };
      const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
      privateIdentities.set(privateKey, fingerprint);
      validateVault(vault);
      return { vault, recoveryCode, privateKey };
    } finally { bytes.fill(0); recoveryBytes.fill(0); }
  }
  async function unlockVault(vault, secret, recovery = false) {
    validateVault(vault);
    if (typeof recovery !== 'boolean') fail('recovery must be boolean');
    if (await hash(canonical(publicKey(vault.publicKey))) !== vault.fingerprint) fail('vault fingerprint mismatch');
    const envelope = recovery ? vault.recovery : vault.password;
    let bytes;
    try {
      const key = recovery ? await aes(secret) : await passwordKey(secret, envelope.kdf);
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', tagLength: 128,
        iv: decode(envelope.iv, 12, 12, 'sealed IV'),
        additionalData: vaultHeader(vault.fingerprint, recovery ? 'recovery' : 'password', envelope.kdf)
      }, key, decode(envelope.ciphertext, 16, 16400, 'sealed ciphertext')));
      const jwk = JSON.parse(decoder.decode(bytes));
      if (jwk.kty !== 'RSA' || jwk.n !== vault.publicKey.n || jwk.e !== vault.publicKey.e) fail('private/public key mismatch');
      const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
      privateIdentities.set(privateKey, vault.fingerprint);
      return privateKey;
    } catch (_) { fail('vault unlock failed'); }
    finally { if (bytes) bytes.fill(0); }
  }
  async function changeVaultPassword(vault, secret, newPassword, recovery = false) {
    await unlockVault(vault, secret, recovery);
    const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: MIN_ITERATIONS, salt: encode(random(16)) };
    const nextKey = await passwordKey(newPassword, kdf);
    const envelope = recovery ? vault.recovery : vault.password;
    const oldKey = recovery ? await aes(secret) : await passwordKey(secret, envelope.kdf);
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', tagLength: 128,
      iv: decode(envelope.iv, 12, 12, 'sealed IV'),
      additionalData: vaultHeader(vault.fingerprint, recovery ? 'recovery' : 'password', envelope.kdf)
    }, oldKey, decode(envelope.ciphertext, 16, 16400, 'sealed ciphertext')));
    try {
      return { ...JSON.parse(canonical(vault)),
        password: await sealPrivate(bytes, nextKey, vault.fingerprint, 'password', kdf) };
    } finally { bytes.fill(0); }
  }
  function createScopeKey() { return encode(random(32)); }
  async function wrapKey(scope, key, publicJwk) {
    scopeValue(scope);
    const identity = publicKey(publicJwk);
    const publicCryptoKey = await crypto.subtle.importKey('jwk', identity, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const bytes = decode(key, 32, 32, 'content key');
    try {
      return { format: 3, scope: JSON.parse(canonical(scope)), recipient: await hash(canonical(identity)),
        wrappedKey: encode(new Uint8Array(await crypto.subtle.encrypt({
          name: 'RSA-OAEP', label: encoder.encode(canonical(scope))
        }, publicCryptoKey, bytes))) };
    } finally { bytes.fill(0); }
  }
  function rsaPrivate(key) {
    if (!key || key.type !== 'private' || key.extractable !== false || key.algorithm?.name !== 'RSA-OAEP' ||
        key.algorithm.hash?.name !== 'SHA-256' || !key.usages.includes('decrypt')) fail('nonextractable RSA-OAEP SHA-256 private key required');
  }
  async function unwrapKey(scope, grant, privateKey) {
    validateGrant(grant, scope);
    rsaPrivate(privateKey);
    let bytes;
    try {
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: encoder.encode(canonical(scope)) },
        privateKey, decode(grant.wrappedKey, 256, 512, 'wrapped key')));
      if (bytes.length !== 32) fail('unwrapped content key length');
      if (privateIdentities.get(privateKey) !== grant.recipient) fail('grant recipient mismatch or unknown private key');
      return encode(bytes);
    } finally { if (bytes) bytes.fill(0); }
  }
  const privateIdentities = new WeakMap();
  function header(envelope) {
    return encoder.encode(canonical({ format: 3, scope: envelope.scope, encoding: 'gzip', plainBytes: envelope.plainBytes }));
  }
  async function transform(bytes, compress, limit) {
    const Stream = compress ? globalThis.CompressionStream : globalThis.DecompressionStream;
    if (typeof Stream !== 'function') fail('gzip streams unavailable');
    const reader = new Blob([bytes]).stream().pipeThrough(new Stream('gzip')).getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) { await reader.cancel(); fail('gzip plaintext/compressed size limit'); }
        chunks.push(value);
      }
    } catch (_) { fail('gzip stream invalid or exceeds size limit'); }
    const result = new Uint8Array(length);
    let offset = 0;
    chunks.forEach(chunk => { result.set(chunk, offset); offset += chunk.length; });
    return result;
  }
  async function encryptValue(value, scope, key) {
    const text = canonical(value);
    if (text.length > MAX_PLAIN) fail('plaintext exceeds 32 MiB');
    const envelope = { format: 3, scope: JSON.parse(canonical(scope)), iv: encode(random(12)),
      ciphertext: '', encoding: 'gzip', plainBytes: text.length };
    const compressed = await transform(encoder.encode(text), true, MAX_ENVELOPE);
    envelope.ciphertext = encode(new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM', iv: decode(envelope.iv, 12, 12, 'IV'), additionalData: header(envelope), tagLength: 128
    }, key, compressed)));
    return validateEnvelope(envelope, scope);
  }
  async function decryptValue(envelope, scope, key) {
    validateEnvelope(envelope, scope);
    let compressed;
    try {
      compressed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', tagLength: 128,
        iv: decode(envelope.iv, 12, 12, 'IV'), additionalData: header(envelope)
      }, key, decode(envelope.ciphertext, 16, MAX_ENVELOPE, 'ciphertext')));
    } catch (_) { fail('envelope authentication failed'); }
    const bytes = await transform(compressed, false, envelope.plainBytes);
    if (bytes.length !== envelope.plainBytes || bytes.some(byte => byte > 127)) fail('plaintext size or ASCII encoding mismatch');
    let value;
    try { value = JSON.parse(decoder.decode(bytes)); } catch (_) { fail('plaintext JSON'); }
    if (canonical(value) !== decoder.decode(bytes)) fail('noncanonical plaintext');
    return value;
  }
  async function encryptSnapshot(records, scope, key, previous, metadata) {
    scopeValue(scope);
    if (metadata !== undefined) metadata = JSON.parse(canonical(releaseMetadata(metadata)));
    const normalized = normalize(records).records, contentKey = await aes(key);
    const reusable = new Map();
    if (previous !== undefined) {
      exact(previous, ['release', 'bundles'], 'previous snapshot');
      const prior = await decryptSnapshot(previous.release, previous.bundles, scope, key);
      const byKey = new Map(prior.map(record => [record.key, record]));
      for (const bundle of previous.bundles) {
        const values = await decryptValue(bundle.data, scope, contentKey);
        if (!Array.isArray(values) || values.some(record => canonical(record) !== canonical(byKey.get(record.key)))) fail('previous bundle content mismatch');
        reusable.set(canonical(values), bundle);
      }
    }
    const buckets = new Map();
    for (const record of normalized) {
      const bucket = (await hash(record.key)).slice(0, 2);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(record);
    }
    const bundles = [], descriptors = [];
    for (const bucket of [...buckets.keys()].sort()) {
      const sorted = buckets.get(bucket).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      let group = [], size = 2;
      async function flush() {
        if (!group.length) return;
        const old = reusable.get(canonical(group));
        const data = old ? JSON.parse(canonical(old.data)) : await encryptValue(group, scope, contentKey);
        const id = old ? old.id : await hash(canonical(data));
        bundles.push({ id, data });
        descriptors.push({ id, keys: group.map(record => record.key) });
        group = []; size = 2;
      }
      for (const record of sorted) {
        const length = canonical(record).length;
        if (size + length + 1 > MAX_RECORD && group.length) await flush();
        group.push(record); size += length + 1;
      }
      await flush();
    }
    const manifest = await encryptValue({ contentFormat: 2, recordCount: normalized.length,
      records: normalized.map(record => record.key), bundles: descriptors,
      ...(metadata === undefined ? {} : { metadata: JSON.parse(canonical(metadata)) }) }, scope, contentKey);
    if (manifest.plainBytes + bundles.reduce((total, bundle) => total + bundle.data.plainBytes, 0) > MAX_PLAIN) fail('snapshot exceeds 32 MiB including manifest');
    const release = { format: 3, scope: JSON.parse(canonical(scope)), manifest,
      bundles: bundles.map(bundle => bundle.id), recordCount: normalized.length };
    validateRelease(release, scope);
    return { release, bundles };
  }
  function manifestValue(manifest, release) {
    exact(manifest, ['contentFormat', 'recordCount', 'records', 'bundles',
      ...(object(manifest) && Object.prototype.hasOwnProperty.call(manifest, 'metadata') ? ['metadata'] : [])], 'manifest');
    if (manifest.contentFormat !== 2 || manifest.recordCount !== release.recordCount ||
        !Array.isArray(manifest.records) || manifest.records.length !== release.recordCount ||
        manifest.records.some(key => typeof key !== 'string' || !/^(?:foundation|[a-z][a-z0-9-]{0,63}\/[a-zA-Z0-9_-]{1,120})(?![\s\S])/.test(key)) ||
        new Set(manifest.records).size !== manifest.records.length || !manifest.records.includes('foundation') ||
        !Array.isArray(manifest.bundles) || manifest.bundles.length !== release.bundles.length) fail('manifest format, count or keys');
    const described = new Set(), keys = new Set(manifest.records);
    manifest.bundles.forEach((descriptor, index) => {
      exact(descriptor, ['id', 'keys'], 'bundle descriptor');
      if (descriptor.id !== release.bundles[index] || !Array.isArray(descriptor.keys) || !descriptor.keys.length ||
          descriptor.keys.length > release.recordCount) fail('descriptor/list mismatch');
      descriptor.keys.forEach(key => {
        if (!keys.has(key) || described.has(key)) fail('descriptor keys missing or duplicated');
        described.add(key);
      });
    });
    if (described.size !== release.recordCount) fail('manifest descriptor record count');
    if (Object.prototype.hasOwnProperty.call(manifest, 'metadata')) releaseMetadata(manifest.metadata);
    return manifest;
  }
  async function decryptManifest(release, scope, key) {
    scopeValue(scope);
    validateRelease(release, scope);
    return manifestValue(await decryptValue(release.manifest, scope, await aes(key)), release);
  }
  async function decryptSnapshotDetails(release, bundles, scope, key) {
    contentModel();
    scopeValue(scope);
    validateRelease(release, scope);
    if (!Array.isArray(bundles) || bundles.length !== release.bundles.length) fail('missing or extra bundles');
    const byId = new Map();
    let total = release.manifest.plainBytes;
    for (const bundle of bundles) {
      exact(bundle, ['id', 'data'], 'bundle');
      if (typeof bundle.id !== 'string' || !digestPattern.test(bundle.id) ||
          !release.bundles.includes(bundle.id) || byId.has(bundle.id)) fail('duplicate or extra bundle');
      validateEnvelope(bundle.data, scope);
      total += bundle.data.plainBytes;
      if (total > MAX_PLAIN) fail('snapshot exceeds 32 MiB');
      if (await hash(canonical(bundle.data)) !== bundle.id) fail('bundle content hash mismatch');
      byId.set(bundle.id, bundle.data);
    }
    const contentKey = await aes(key), manifest = await decryptValue(release.manifest, scope, contentKey);
    manifestValue(manifest, release);
    const records = new Map();
    for (let index = 0; index < manifest.bundles.length; index++) {
      const descriptor = manifest.bundles[index];
      const values = await decryptValue(byId.get(descriptor.id), scope, contentKey);
      if (!Array.isArray(values) || values.length !== descriptor.keys.length) fail('bundle plaintext record count');
      for (let item = 0; item < values.length; item++) {
        const record = values[item];
        if (!object(record) || record.key !== descriptor.keys[item] || records.has(record.key) || !model.isDynamic(record.data)) fail('bundle plaintext keys or content format');
        model.record(record);
        if (canonical(record).length > MAX_RECORD) fail('record exceeds 700000 ASCII bytes');
        records.set(record.key, record);
      }
    }
    if (records.size !== release.recordCount) fail('missing records');
    return { records: normalize(manifest.records.map(key => records.get(key))).records, metadata: manifest.metadata };
  }
  async function decryptSnapshot(release, bundles, scope, key) {
    return (await decryptSnapshotDetails(release, bundles, scope, key)).records;
  }
  return Object.freeze({ canonical, hash, normalize, createVault, unlockVault, changeVaultPassword, createScopeKey, wrapKey, unwrapKey,
    encryptSnapshot, decryptSnapshot, decryptSnapshotDetails, decryptManifest, validateEnvelope, validateRelease, validateVault, validateGrant });
});
