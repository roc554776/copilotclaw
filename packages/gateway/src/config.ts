import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PORT = 19741;

/** Known non-premium models (billing.multiplier === 0). Used by doctor for static checks.
 * The agent resolves this dynamically from the SDK at runtime via client.rpc.models.list(). */
export const NON_PREMIUM_MODELS: readonly string[] = ["gpt-4.1-nano", "gpt-4.1-mini"];

export interface AuthConfig {
  /** Authentication type: "gh-auth" (gh CLI), "pat" (Fine-grained PAT), "oauth" (future). */
  type: "gh-auth" | "pat" | "oauth";
  /** GitHub username for gh auth token --user. Only used with type "gh-auth". */
  user?: string;
  /** Hostname for gh auth token --hostname. Only used with type "gh-auth". */
  hostname?: string;
  /** Environment variable name containing the token. Used with "pat" and "oauth". */
  tokenEnv?: string;
  /** File path containing the token. Used with "pat" and "oauth". */
  tokenFile?: string;
  /** Custom command to execute to obtain the token. Overrides default gh auth token invocation. */
  tokenCommand?: string;
}

export interface CopilotclawConfig {
  /** Schema version for config migration. Absent in legacy configs (treated as 0). */
  configVersion?: number;
  upstream?: string;
  port?: number;
  model?: string;
  zeroPremium?: boolean;
  debugMockCopilotUnsafeTools?: boolean;
  auth?: AuthConfig;
}

/** Current schema version. Increment when a breaking config change is introduced. */
export const LATEST_CONFIG_VERSION = 1;

/** Migration function type: transforms a raw config object from version N to N+1. */
type MigrationFn = (config: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registry of migration functions. Each entry migrates from version N to N+1.
 * Key is the source version (0 → migrates to 1, 1 → migrates to 2, etc.).
 * All functions must be pure — no side effects (file write happens after the chain).
 */
const MIGRATIONS: Record<number, MigrationFn> = {
  // v0 → v1: Add configVersion field. No schema changes to existing fields.
  0: (config) => ({ ...config, configVersion: 1 }),
};

/**
 * Apply sequential migrations from the config's current version to LATEST_CONFIG_VERSION.
 * Returns { config, migrated } where migrated is true if any migration was applied.
 */
export function migrateConfig(raw: Record<string, unknown>): { config: Record<string, unknown>; migrated: boolean } {
  let version = typeof raw["configVersion"] === "number" ? raw["configVersion"] : 0;
  let config = raw;
  let migrated = false;

  while (version < LATEST_CONFIG_VERSION) {
    const fn = MIGRATIONS[version];
    if (fn === undefined) {
      // No migration path — stop and return what we have
      break;
    }
    config = fn(config);
    version = version + 1;
    migrated = true;
  }

  return { config, migrated };
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
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      const { config: migrated, migrated: didMigrate } = migrateConfig(raw);
      fileConfig = migrated as CopilotclawConfig;
      if (didMigrate) {
        // Write back migrated config to persist the version bump
        try {
          writeFileSync(filePath, JSON.stringify(migrated, null, 2) + "\n", "utf-8");
        } catch {
          // Write-back failure is non-fatal — config is usable in memory
        }
      }
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

  // Auth config is file-only (no env var override — secrets are resolved by the agent)
  if (fileConfig.auth !== undefined) result.auth = fileConfig.auth;

  // Preserve configVersion from migrated file config
  if (fileConfig.configVersion !== undefined) result.configVersion = fileConfig.configVersion;

  return result;
}

/** Load config from file only (no env var override). Applies migration if needed. */
export function loadFileConfig(profile?: string): CopilotclawConfig {
  const filePath = getConfigFilePath(profile);
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const { config: migrated } = migrateConfig(raw);
    return migrated as CopilotclawConfig;
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
  // Always stamp the latest configVersion when saving
  const toWrite = { ...config, configVersion: LATEST_CONFIG_VERSION };
  writeFileSync(filePath, JSON.stringify(toWrite, null, 2) + "\n", "utf-8");
}

/** Ensure config file exists. Creates parent directory and versioned empty config if missing. */
export function ensureConfigFile(profile?: string): void {
  const filePath = getConfigFilePath(profile);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ configVersion: LATEST_CONFIG_VERSION }, null, 2) + "\n", "utf-8");
  }
}

/** Resolve gateway port: env var > config file > default (19741). */
export function resolvePort(profile?: string): number {
  const config = loadConfig(profile);
  return config.port ?? DEFAULT_PORT;
}
