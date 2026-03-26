import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKSPACE_ROOT = join(homedir(), ".copilotclaw");

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export function getDataDir(): string {
  return join(WORKSPACE_ROOT, "data");
}

export function getStoreFilePath(): string {
  return join(getDataDir(), "store.json");
}

export function ensureWorkspace(): void {
  mkdirSync(getDataDir(), { recursive: true });
}
