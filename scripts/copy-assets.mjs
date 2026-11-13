import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const destination = fileURLToPath(new URL('../dist/', import.meta.url));
mkdirSync(destination, { recursive: true });
for (const name of ['contract', 'contract-v3', 'vendor', 'public']) {
  rmSync(destination + name, { recursive: true, force: true });
  cpSync(fileURLToPath(new URL('../' + name, import.meta.url)), destination + name, { recursive: true });
}
