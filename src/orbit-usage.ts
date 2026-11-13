import type { V3Access } from './documentation-v3.js';

/** Optional daily question limits for Orbit. Self-hosted servers have no limit unless they plug one in. */
export interface OrbitAttempt { model: string; status: 'success' | 'failed' }
export interface OrbitUsage {
  reserve(access: V3Access): Promise<string>;
  complete(id: string, outcome: 'success' | 'failed', attempts: OrbitAttempt[]): Promise<void>;
}
