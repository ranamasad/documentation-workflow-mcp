#!/usr/bin/env node
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// v2: the schema module is required by the model; the renderer defines safe presentation.
const snapshots = ['documentation-schema.js', 'documentation-model.js', 'documentation-discovery.js', 'documentation-engine.js', 'documentation-renderer.js', 'documentation-convert.js', 'documentation-v3.js'];
const CONTRACT_VERSION = '2.0.0';

/** Compose the checked-in generic fixtures; never reads website article content. */
export function assembleExamples() {
  const contract = JSON.parse(readFileSync(join(root, 'contract/manifest.json'), 'utf8'));
  const records = Object.entries(contract.examples).filter(([key]) => key !== 'complete' && !key.startsWith('v2-'))
    .flatMap(([, file]) => JSON.parse(readFileSync(join(root, 'contract', file), 'utf8')));
  const nav = records.find(record => record.key === 'foundation').data.navigation;
  records.filter(record => record.key !== 'foundation').forEach((record, index) => {
    if (!nav.tabs.some(tab => tab.id === record.page)) {
      nav.tabs.push({ id: record.page, label: record.page, overviewLabel: record.page + ' overview',
        icon: 'book', href: '#/' + record.page, order: nav.tabs.length, visible: true });
    }
    nav.entries.push({ id: 'example-' + index, tab: record.page, group: '', key: record.key,
      label: record.title, href: '#/' + record.key, order: index + 10, visible: true, searchable: true });
  });
  writeFileSync(join(root, 'contract/examples/complete.json'), JSON.stringify(records, null, 2) + '\n');
  return records;
}

/** Explicit, deliberate source synchronization; never loads source content or credentials. */
export function syncContract(sourceDirectory) {
  if (!sourceDirectory) throw new Error('Usage: node scripts/sync-contract.mjs <website-root>');
  const source = resolve(sourceDirectory);
  const inputs = [...snapshots, 'app.js'].map(name => ({
    name, bytes: readFileSync(join(source, 'assets/js', name))
  }));
  const vendor = join(root, 'vendor');
  mkdirSync(vendor, { recursive: true });
  mkdirSync(join(root, 'contract-v3'), { recursive: true });
  // Public contract files only; this never copies a customer's snapshots or encryption keys.
  cpSync(join(source, 'contract-v3'), join(root, 'contract-v3'), { recursive: true });
  const files = inputs.map(({ name, bytes }) => {
    const copied = snapshots.includes(name);
    if (copied) copyFileSync(join(source, 'assets/js', name), join(vendor, name));
    return { source: 'assets/js/' + name, snapshot: copied ? 'vendor/' + name : null,
      sha256: digest(bytes), bytes: bytes.length, role: copied ? 'semantic authority' : 'renderer field reference (not copied)' };
  });
  writeFileSync(join(vendor, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n');
  // Machine-readable capabilities come from the vendored schema itself, never a hand-kept list.
  const require = createRequire(import.meta.url);
  const capabilities = require(join(vendor, 'documentation-schema.js')).contract;
  writeFileSync(join(root, 'contract/capabilities.json'), JSON.stringify(capabilities, null, 2) + '\n');
  // Generic v2 fixtures from the website's own tests (two unrelated domains, no customer content).
  const fixtures = require(join(source, 'tests/fixtures/dynamic-documentation.js'));
  mkdirSync(join(root, 'contract/examples'), { recursive: true });
  for (const name of ['catalog', 'handbook']) {
    writeFileSync(join(root, 'contract/examples/v2-' + name + '.json'), JSON.stringify(fixtures[name](), null, 2) + '\n');
  }
  const provenance = {
    schema: 1, contractVersion: CONTRACT_VERSION, synchronizedAt: new Date().toISOString(),
    source: { project: 'documentation website', directoryArgument: '<website-root>', authority: 'Current website assets/js schema, model, discovery, engine and renderer (v1 and v2 dynamic content).' },
    procedure: 'node scripts/sync-contract.mjs <website-root>',
    policy: 'Deliberate local snapshot update only. Review source diffs, update schemas/examples if needed, run contract tests. No automatic refresh, network, customer article data, credentials, or Firebase access.',
    files
  };
  writeFileSync(join(vendor, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  assembleExamples();
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/sync-contract.mjs <website-root>');
    const result = syncContract(process.argv[2]);
    console.log(JSON.stringify({ ok: true, files: result.files.length, contractVersion: result.contractVersion }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
