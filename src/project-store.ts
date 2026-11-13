import { z } from 'zod';
import type { ReadAccess } from './published.js';
import type { createIssues } from './issues.js';

const roles = ['owner', 'admin', 'author', 'viewer'] as const;
export const savedProject = z.object({
  name: z.string(), settings: z.record(z.string(), z.unknown()),
  updatedAt: z.string().datetime({ offset: true }), lastUsedAt: z.string().datetime({ offset: true }),
  workspace: z.object({ id: z.string().uuid(), name: z.string(), role: z.enum(roles) }),
  // Secret-free summaries: documentation access and the deployed site.
  access: z.record(z.string(), z.unknown()).optional(),
  site: z.record(z.string(), z.unknown()).nullable().optional()
});
export type SavedProject = z.infer<typeof savedProject>;
/** Who an authenticated MCP request belongs to. */
export interface Principal { userId: string; clientId: string }
/** Documentation projects available to the caller, used by the MCP tools. */
export interface ProjectStore {
  list(): Promise<SavedProject[]>;
  save(name: string, settings: Record<string, unknown>, workspace?: string): Promise<SavedProject>;
  forget(name: string, workspace?: string): Promise<boolean>;
  /** Everything needed to read this project's published documentation as the caller (server-only, may include secrets). */
  readAccess(name: string, workspace?: string): Promise<ReadAccess>;
  /** The caller's verified email, recorded as the author of releases they publish. */
  memberEmail(): Promise<string>;
  /** Issues and FAQ questions raised on the project's documentation website. */
  issues?(name: string, workspace?: string): ReturnType<ReturnType<typeof createIssues>['member']>;
  /** Large documentation staged in parts before one publication. Payloads arrive sealed; storage never sees documentation. */
  drafts?: DraftStore;
  /** Code notes per project area, saved with the user's consent. Payloads arrive sealed; storage never sees the notes. */
  notes?: NotesStore;
}
export interface NotesArea { area: string; files: number; updatedAt: string }
export interface NotesStore {
  put(name: string, workspace: string | undefined, notes: { area: string; payload: string; files: Record<string, string> }): Promise<NotesArea[]>;
  read(name: string, workspace: string | undefined, area: string): Promise<{ area: string; payload: string; files: Record<string, string>; updatedAt: string } | null>;
  list(name: string, workspace: string | undefined): Promise<NotesArea[]>;
}
export interface DraftStore {
  put(name: string, workspace: string | undefined, draft: { id: string; environment: string; part: number; records: number; payload: string }):
    Promise<{ environment: string; parts: { part: number; records: number }[] }>;
  read(name: string, workspace: string | undefined, id: string): Promise<{ environment: string; parts: { part: number; payload: string }[] }>;
  remove(id: string): Promise<void>;
}
