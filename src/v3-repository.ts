import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonical, DocumentationV3Error, hash, v3Bundle, v3Release, type V3Access, type V3Store } from './documentation-v3.js';
import { ciphertextCacheKey, type createCiphertextCache } from './ciphertext-cache.js';

export function createV3Repository(access: Pick<V3Access, 'projectId' | 'firebaseProject'>, environment: string,
  store: V3Store, cache: ReturnType<typeof createCiphertextCache>, signingKey: string) {
  const key = (id: string) => ciphertextCacheKey(access.firebaseProject, access.projectId, environment, id);
  const check = (scope: { projectId: string; environment: string }) => {
    if (scope.projectId !== access.projectId || scope.environment !== environment) {
      throw new DocumentationV3Error(403, 'Encrypted content does not match the authorized project and environment.');
    }
  };
  const mac = (id: string, contentHash: string) => createHmac('sha256', signingKey)
    .update('documentation-v3-release-cache\0' + key('release:' + id) + '\0' + contentHash).digest('hex');
  const entry = (id: string, release: z.infer<typeof v3Release>) => {
    const contentHash = hash(canonical(release));
    return { releaseId: id, release, contentHash, mac: mac(id, contentHash) };
  };
  const readRelease = async (id: string) => {
    const result = await cache.get(key('release:' + id), value => {
      const parsed = z.strictObject({ releaseId: z.uuid(), release: v3Release,
        contentHash: z.string().regex(/^[a-f0-9]{64}$/), mac: z.string().regex(/^[a-f0-9]{64}$/) }).parse(value);
      if (parsed.releaseId !== id || parsed.contentHash !== hash(canonical(parsed.release)) ||
          !timingSafeEqual(Buffer.from(parsed.mac, 'hex'), Buffer.from(mac(id, parsed.contentHash), 'hex'))) {
        throw new DocumentationV3Error(502, 'Invalid cached encrypted release.');
      }
      check(parsed.release.scope);
      return parsed;
    }, async () => {
      const stored = await store.get('documentationV3Releases/' + id);
      if (!stored) throw new DocumentationV3Error(404, 'Encrypted release not found.');
      const release = v3Release.parse(stored.data);
      check(release.scope);
      return entry(id, release);
    });
    return result.release;
  };
  return {
    readRelease,
    saveRelease: (id: string, release: z.infer<typeof v3Release>) => cache.set(key('release:' + id), entry(id, release)),
    async readBundle(id: string, releaseId: string) {
      const release = await readRelease(releaseId);
      if (!release.bundles.includes(id)) throw new DocumentationV3Error(403, 'Bundle does not belong to this release.');
      return cache.get(key(id), value => {
        const bundle = v3Bundle.parse(value);
        if (bundle.id !== id || canonical(bundle.data.scope) !== canonical(release.scope)) {
          throw new DocumentationV3Error(502, 'Invalid cached bundle.');
        }
        return bundle;
      }, async () => v3Bundle.parse({ id, data: (await store.get('documentationV3Bundles/' + id))?.data }));
    }
  };
}
