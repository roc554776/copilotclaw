import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_DIR = join(homedir(), ".copilotclaw");

export interface CopilotclawConfig {
  upstream?: string;
  port?: number;
}

function getProfileName(): string | undefined {
  return process.env["COPILOTCLAW_PROFILE"] || undefined;
}

export function getConfigFilePath(profile?: string): string {
  const p = profile ?? getProfileName();
  if (p !== undefined) {
    return join(BASE_DIR, `config-${p}.json`);
  }
  return join(BASE_DIR, "config.json");
}

export function loadConfig(profile?: string): CopilotclawConfig {
  const filePath = getConfigFilePath(profile);
  let fileConfig: CopilotclawConfig = {};
  if (existsSync(filePath)) {
    try {
      fileConfig = JSON.parse(readFileSync(filePath, "utf-8")) as CopilotclawConfig;
    } catch {
      // Ignore malformed config
    }
  }

  // Environment variables take precedence over config file
  const envUpstream = process.env["COPILOTCLAW_UPSTREAM"];
  const envPort = process.env["COPILOTCLAW_PORT"];

  const result: CopilotclawConfig = {};
  const upstream = envUpstream ?? fileConfig.upstream;
  if (upstream !== undefined) result.upstream = upstream;
  const port = envPort !== undefined ? parseInt(envPort, 10) : fileConfig.port;
  if (port !== undefined) result.port = port;
  return result;
}

export function saveConfig(config: CopilotclawConfig, profile?: string): void {
  const filePath = getConfigFilePath(profile);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

const DEFAULT_PORT = 19741;

/** Resolve gateway port: env var > config file > default (19741). */
export function resolvePort(profile?: string): number {
  const envPort = process.env["COPILOTCLAW_PORT"];
  if (envPort !== undefined) {
    const n = parseInt(envPort, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const config = loadConfig(profile);
  if (config.port !== undefined && Number.isFinite(config.port) && config.port > 0) return config.port;
  return DEFAULT_PORT;
}
