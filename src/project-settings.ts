import { z } from 'zod';
import { audiences, repositoryTypes } from './workflows.js';
import { purposes } from './authoring.js';

// Saved project settings shared by the MCP tools and the dashboard. Settings and
// Firestore locations only: never source code, drafts, secrets, credentials or tokens.
const short = (max: number) => z.string().trim().min(1).max(max);
const environment = z.enum(['development', 'beta', 'production']);

export const projectName = short(120);
export const workspaceId = z.string().uuid();
export const projectSettings = z.strictObject({
  // Who reads the documentation: one or more readers, or "everyone". `audience` is the older single choice.
  audiences: z.array(z.enum(audiences)).min(1).max(audiences.length).optional(),
  audience: z.enum(audiences).optional(),
  audienceNotes: short(500).optional(),
  purposes: z.array(z.enum(purposes)).max(purposes.length).optional(),
  sections: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(40).optional(),
  language: short(40).optional(),
  tone: short(120).optional(),
  // Public Firebase web API key (an identifier, not a secret); needed for personal sign-in.
  firebaseApiKey: z.string().regex(/^AIza[0-9A-Za-z_-]{35}$/, 'Use the Firebase web API key from the project settings.').optional(),
  firebaseProject: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'Use the Firebase project ID (lowercase letters, digits and hyphens).').optional(),
  documentationSite: z.string().url().max(200).refine(value => value.startsWith('https://'), 'Use an https:// address.').optional(),
  environments: z.array(environment).max(3).optional(),
  defaultEnvironment: environment.optional(),
  // Names and roles are shared; a path is the saving member's own folder, stored for them only.
  repositories: z.array(z.strictObject({ name: short(120), role: z.enum(repositoryTypes), path: short(400).optional() })).max(12).optional(),
  versionScheme: short(120).optional(),
  notes: short(1000).optional()
});
export type ProjectSettings = z.infer<typeof projectSettings>;

const SECRET = /dmcp_[A-Za-z0-9_-]{20,}|sb_(?:secret|publishable)_|\bsk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|GOCSPX-|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.eyJ|"private_key"/;

/** True when a name or settings value looks like a credential that must not be stored. */
export const containsSecret = (name: string, settings: unknown): boolean => {
  const { firebaseApiKey: _publicKey, ...rest } = (settings ?? {}) as Record<string, unknown>;
  return SECRET.test(name + JSON.stringify(rest));
};
