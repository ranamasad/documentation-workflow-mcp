/** Ciphertext only. Callers must authorize and prove release membership before using this cache. */
export function createCiphertextCache(options: {
  redis?: { url: string; token: string } | undefined;
  fetch?: typeof fetch;
  maxBytes?: number;
  ttlSeconds?: number;
  now?: () => number;
  warn?: (message: string) => void;
} = {}) {
  const memory = new Map<string, { text: string; expires: number; bytes: number }>();
  const flights = new Map<string, Promise<unknown>>();
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? 16 * 1024 * 1024, 16 * 1024 * 1024));
  const ttl = Math.max(1, Math.min(options.ttlSeconds ?? 7200, 7200));
  const now = options.now ?? Date.now;
  const warn = options.warn ?? (message => console.warn(message));
  let bytes = 0;
  function remove(key: string) {
    const item = memory.get(key);
    if (item) { bytes -= item.bytes; memory.delete(key); }
  }
  function put(key: string, text: string) {
    remove(key);
    const size = Buffer.byteLength(key) + Buffer.byteLength(text);
    if (size > maxBytes) return;
    for (const [id, item] of memory) if (item.expires <= now()) remove(id);
    while (bytes + size > maxBytes && memory.size) remove(memory.keys().next().value!);
    memory.set(key, { text, bytes: size, expires: now() + ttl * 1000 }); bytes += size;
  }
  // When Redis fails, skip it for a minute: otherwise every bundle request waits up to 3 s for a cache that is down.
  let downUntil = 0;
  async function redis(command: string[]): Promise<unknown> {
    const config = options.redis;
    if (!config) return null;
    if (now() < downUntil) throw new Error('cache unavailable');
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(config.url, {
        method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(command), redirect: 'error', signal: AbortSignal.timeout(3000)
      });
    } catch (error) { downUntil = now() + 60_000; throw error; }
    if (!response.ok) {
      downUntil = now() + 60_000;
      // Upstash explains the failure (quota, auth, size) in the body; log it without any credentials.
      const reason = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      warn('Ciphertext cache answered HTTP ' + response.status + ' (' + reason + '); skipping it for 60 s.');
      throw new Error('cache unavailable');
    }
    const length = Number(response.headers.get('content-length'));
    if (length > 2_000_000) throw new Error('oversized cache response');
    let text = '';
    if (response.body) for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(text) > 2_000_000) throw new Error('oversized cache response');
    }
    const result = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (result.error) {
      warn('Ciphertext cache error: ' + String(result.error).slice(0, 200));
      throw new Error('cache unavailable');
    }
    return result.result;
  }
  return {
    async set(key: string, value: unknown): Promise<string[]> {
      const text = JSON.stringify(value);
      put(key, text);
      // Upstash rejects requests over 1 MB on common plans; keep such bundles in memory only instead of failing.
      if (Buffer.byteLength(text) > 900_000) return [];
      try { await redis(['SET', key, text, 'EX', String(ttl)]); return []; }
      catch { warn('Ciphertext cache SET failed; durable storage retained.'); return ['Ciphertext cache unavailable; durable storage retained.']; }
    },
    async get<T>(key: string, validate: (value: unknown) => T, load: () => Promise<T>): Promise<T> {
      const existing = flights.get(key);
      if (existing) return existing as Promise<T>;
      const flight = (async () => {
        const item = memory.get(key);
        if (item && item.expires <= now()) remove(key);
        let text: unknown = memory.get(key)?.text;
        if (!text) {
          try { text = await redis(['GET', key]); }
          catch { warn('Ciphertext cache GET failed; using durable storage.'); }
        }
        if (typeof text === 'string') {
          try { const value = validate(JSON.parse(text)); put(key, text); return value; }
          catch {
            warn('Corrupt ciphertext cache entry discarded.');
            remove(key);
            try { await redis(['DEL', key]); } catch { warn('Ciphertext cache DELETE failed.'); }
          }
        }
        const value = validate(await load());
        await this.set(key, value);
        return value;
      })();
      flights.set(key, flight);
      try { return await flight; } finally { flights.delete(key); }
    },
    get bytes() { return bytes; }
  };
}

export const ciphertextCacheKey = (firebaseProject: string, projectId: string, environment: string, hash: string) =>
  ['documentation-v3', firebaseProject, projectId, environment, hash].join(':');
