import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProfileName } from "./config.js";

/**
 * State directory per profile (OpenClaw-style separation).
 * Default profile: ~/.copilotclaw/
 * Named profile:   ~/.copilotclaw-{{profile}}/
 */
export function getWorkspaceRoot(profile?: string): string {
  const p = profile ?? getProfileName();
  if (p !== undefined) {
    return join(homedir(), `.copilotclaw-${p}`);
  }
  return join(homedir(), ".copilotclaw");
}

export function getDataDir(profile?: string): string {
  return join(getWorkspaceRoot(profile), "data");
}

export function getStoreFilePath(profile?: string): string {
  return join(getDataDir(profile), "store.json");
}

export function ensureWorkspace(profile?: string): void {
  mkdirSync(getDataDir(profile), { recursive: true });
}

/** Source directory for update (profile-independent — shared across all profiles). */
export function getUpdateDir(): string {
  return join(homedir(), ".copilotclaw", "source");
}
