import { z } from 'zod';

const environment = z.enum(['development', 'beta', 'production']);
export const visitEntry = z.strictObject({
  id: z.uuid(), uid: z.string().min(1).max(128), sessionId: z.uuid(),
  route: z.string().min(1).max(512), title: z.string().min(1).max(256),
  openedAt: z.number().int().nonnegative(), activeMs: z.number().int().min(0).max(604800000),
  elapsedMs: z.number().int().min(0).max(604800000), ended: z.boolean(),
  endReason: z.enum(['', 'navigation', 'signout', 'pagehide', 'session-ended']),
  nextRoute: z.string().max(512), environment, releaseId: z.uuid(),
  documentationVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
}).refine(value => value.elapsedMs >= value.activeMs &&
  (value.ended ? value.endReason !== '' : value.endReason === '') &&
  (value.endReason === 'navigation' ? value.nextRoute.length > 0 : value.nextRoute === ''),
'Invalid visit progress.');
export const feedbackTarget = {
  environment, releaseId: z.uuid(), key: z.string().min(1).max(1600),
  route: z.string().min(1).max(512), title: z.string().min(1).max(256),
  revisionId: z.string().regex(/^[a-f0-9]{64}$/)
};
