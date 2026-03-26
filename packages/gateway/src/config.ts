import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_DIR = join(homedir(), ".copilotclaw");

export const DEFAULT_PORT = 19741;

export interface CopilotclawConfig {
  upstream?: string;
  port?: number;
}

export function getProfileName(): string | undefined {
  return process.env["COPILOTCLAW_PROFILE"] || undefined;
}

export function getConfigFilePath(profile?: string): string {
  const p = profile ?? getProfileName();
  if (p !== undefined) {
    return join(BASE_DIR, `config-${p}.json`);
  }
  return join(BASE_DIR, "config.json");
}

function parsePort(raw: string): number | undefined {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
  const port = envPort !== undefined ? parsePort(envPort) : fileConfig.port;
  if (port !== undefined && Number.isFinite(port) && port > 0) result.port = port;
  return result;
}

/** Load config from file only (no env var override). */
export function loadFileConfig(profile?: string): CopilotclawConfig {
  const filePath = getConfigFilePath(profile);
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as CopilotclawConfig;
  } catch {
    return {};
  }
}

/** Map of config keys to their corresponding environment variable names. */
export const CONFIG_ENV_VARS: Record<string, string> = {
  upstream: "COPILOTCLAW_UPSTREAM",
  port: "COPILOTCLAW_PORT",
};

export function saveConfig(config: CopilotclawConfig, profile?: string): void {
  const filePath = getConfigFilePath(profile);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Ensure config file exists. Creates parent directory and empty config if missing. */
export function ensureConfigFile(profile?: string): void {
  const filePath = getConfigFilePath(profile);
  if (!existsSync(filePath)) {
    mkdirSync(BASE_DIR, { recursive: true });
    writeFileSync(filePath, "{}\n", "utf-8");
  }
}

/** Resolve gateway port: env var > config file > default (19741). */
export function resolvePort(profile?: string): number {
  const config = loadConfig(profile);
  return config.port ?? DEFAULT_PORT;
}
