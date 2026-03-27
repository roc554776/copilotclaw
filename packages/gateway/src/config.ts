import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PORT = 19741;

/** Known non-premium models (billing.multiplier === 0). Used by doctor for static checks.
 * The agent resolves this dynamically from the SDK at runtime via client.rpc.models.list(). */
export const NON_PREMIUM_MODELS: readonly string[] = ["gpt-4.1-nano", "gpt-4.1-mini"];

export interface CopilotclawConfig {
  upstream?: string;
  port?: number;
  model?: string;
  zeroPremium?: boolean;
  debugMockCopilotUnsafeTools?: boolean;
}

export function getProfileName(): string | undefined {
  return process.env["COPILOTCLAW_PROFILE"] || undefined;
}

/** Resolve the state directory for a given profile.
 *  Shared logic used by both config.ts and workspace.ts to avoid circular imports. */
export function getStateDir(profile?: string): string {
  const p = profile ?? getProfileName();
  if (p !== undefined) {
    return join(homedir(), `.copilotclaw-${p}`);
  }
  return join(homedir(), ".copilotclaw");
}

export function getConfigFilePath(profile?: string): string {
  return join(getStateDir(profile), "config.json");
}

function parsePort(raw: string): number | undefined {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseBool(raw: string): boolean | undefined {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
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
  const envModel = process.env["COPILOTCLAW_MODEL"];
  const envZeroPremium = process.env["COPILOTCLAW_ZERO_PREMIUM"];
  const envMockTools = process.env["COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS"];

  const result: CopilotclawConfig = {};

  const upstream = (envUpstream !== undefined && envUpstream !== "") ? envUpstream : fileConfig.upstream;
  if (upstream !== undefined) result.upstream = upstream;

  const port = (envPort !== undefined && envPort !== "") ? parsePort(envPort) : fileConfig.port;
  if (port !== undefined && Number.isFinite(port) && port > 0 && port <= 65535) result.port = port;

  const model = (envModel !== undefined && envModel !== "") ? envModel : fileConfig.model;
  if (model !== undefined) result.model = model;

  const zeroPremium = (envZeroPremium !== undefined && envZeroPremium !== "") ? parseBool(envZeroPremium) : fileConfig.zeroPremium;
  if (zeroPremium !== undefined) result.zeroPremium = zeroPremium;

  const debugMockCopilotUnsafeTools = (envMockTools !== undefined && envMockTools !== "") ? parseBool(envMockTools) : fileConfig.debugMockCopilotUnsafeTools;
  if (debugMockCopilotUnsafeTools !== undefined) result.debugMockCopilotUnsafeTools = debugMockCopilotUnsafeTools;

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
  model: "COPILOTCLAW_MODEL",
  zeroPremium: "COPILOTCLAW_ZERO_PREMIUM",
  debugMockCopilotUnsafeTools: "COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS",
};

export function saveConfig(config: CopilotclawConfig, profile?: string): void {
  const filePath = getConfigFilePath(profile);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Ensure config file exists. Creates parent directory and empty config if missing. */
export function ensureConfigFile(profile?: string): void {
  const filePath = getConfigFilePath(profile);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{}\n", "utf-8");
  }
}

/** Resolve gateway port: env var > config file > default (19741). */
export function resolvePort(profile?: string): number {
  const config = loadConfig(profile);
  return config.port ?? DEFAULT_PORT;
}
