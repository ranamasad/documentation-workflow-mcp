import { readFileSync } from 'node:fs';

export const websiteHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'X-Frame-Options': 'DENY'
};

export function loadWebsite() {
  const assets = [
    ['index.html', 'text/html; charset=utf-8'],
    ['favicon.svg', 'image/svg+xml'],
    ['favicon-64.png', 'image/png'],
    ['apple-touch-icon.png', 'image/png'],
    ['robots.txt', 'text/plain; charset=utf-8'],
    // Downloaded by AI hosts to send record files without pasting them into tool calls.
    ['tools/push-records.mjs', 'text/javascript; charset=utf-8']
  ] as const;
  const files = new Map<string, { body: Buffer; contentType: string }>();
  for (const [name, contentType] of assets) {
    files.set('/' + name, { body: readFileSync(new URL('../public/' + name, import.meta.url)), contentType });
  }
  for (const name of ['documentation-schema', 'documentation-model', 'documentation-discovery', 'documentation-engine', 'documentation-convert', 'documentation-v3']) {
    files.set('/v3/' + name + '.js', { body: readFileSync(new URL('../vendor/' + name + '.js', import.meta.url)),
      contentType: 'text/javascript; charset=utf-8' });
  }
  const index = files.get('/index.html');
  if (!index) throw new Error('The public landing page is missing.');
  files.set('/', index);
  return files;
}
