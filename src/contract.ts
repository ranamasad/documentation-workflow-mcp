import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export interface ContractResource {
  id: string;
  uri: string;
  text: string;
  bytes: number;
  sha256: string;
}

export function loadContractResources(): ReadonlyMap<string, ContractResource> {
  const directory = new URL('../contract/', import.meta.url);
  const resources = new Map<string, ContractResource>();
  function visit(relative = '', depth = 0, base = directory, prefix = ''): void {
    if (depth > 4) throw new Error('Contract directories exceed the supported depth.');
    for (const entry of readdirSync(new URL(relative, base), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = relative + entry.name;
      const id = prefix + name;
      if (entry.isDirectory()) visit(name + '/', depth + 1, base, prefix);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const text = readFileSync(fileURLToPath(new URL(name, base)), 'utf8');
        JSON.parse(text);
        resources.set(id, { id, uri: prefix ? 'docs-contract://v3/' + name : 'docs-contract://v2/' + id, text,
          bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
      }
    }
  }
  visit();
  visit('', 0, new URL('../contract-v3/', import.meta.url), 'v3/');
  if (!resources.has('manifest.json')) throw new Error('The versioned documentation contract manifest is missing.');
  return resources;
}
