import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getStateDir } from "./config.js";

/**
 * Workspace root = {{stateDir}}/workspace/ per profile.
 * State dir holds system-managed data (config, data/, logs).
 * Workspace holds user-editable files (SOUL.md, memory/, .git).
 * Default profile: ~/.copilotclaw/workspace/
 * Named profile:   ~/.copilotclaw-{{profile}}/workspace/
 */
export function getWorkspaceRoot(profile?: string): string {
  return join(getStateDir(profile), "workspace");
}

export function getDataDir(profile?: string): string {
  return join(getStateDir(profile), "data");
}

export function getStoreDbPath(profile?: string): string {
  return join(getDataDir(profile), "store.db");
}

/** @deprecated Use getStoreDbPath instead. Kept for legacy JSON migration. */
export function getStoreFilePath(profile?: string): string {
  return join(getDataDir(profile), "store.json");
}

export function ensureWorkspace(profile?: string): void {
  mkdirSync(getDataDir(profile), { recursive: true });
  mkdirSync(getWorkspaceRoot(profile), { recursive: true });
}

/** Source directory for update (profile-independent — shared across all profiles). */
export function getUpdateDir(): string {
  return join(homedir(), ".copilotclaw", "source");
}
