import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProfileName } from "./config.js";

const BASE_DIR = join(homedir(), ".copilotclaw");

export function getWorkspaceRoot(profile?: string): string {
  const p = profile ?? getProfileName();
  if (p !== undefined) {
    return join(BASE_DIR, `workspace-${p}`);
  }
  return BASE_DIR;
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
