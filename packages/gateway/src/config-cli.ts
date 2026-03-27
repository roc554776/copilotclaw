import { CONFIG_ENV_VARS, type CopilotclawConfig, ensureConfigFile, getProfileName, loadConfig, loadFileConfig, saveConfig } from "./config.js";

const TOP_LEVEL_KEYS: readonly string[] = Object.keys(CONFIG_ENV_VARS);

/** Auth config keys supported under auth.github.* */
const AUTH_GITHUB_KEYS: readonly string[] = ["type", "user", "hostname", "tokenEnv", "tokenFile", "tokenCommand"];

const VALID_KEYS: readonly string[] = [
  ...TOP_LEVEL_KEYS,
  ...AUTH_GITHUB_KEYS.map((k) => `auth.github.${k}`),
];

function log(message: string): void {
  console.error(`[config] ${message}`);
}

const BOOLEAN_KEYS = new Set(["zeroPremium", "debugMockCopilotUnsafeTools"]);

function parseValue(key: string, raw: string): string | number | boolean {
  if (key === "port") {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      log(`invalid port value: ${raw} (must be 1-65535)`);
      process.exit(1);
    }
    return n;
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    log(`invalid boolean value: ${raw} (must be true/false)`);
    process.exit(1);
  }
  return raw;
}

export function configGet(key: string): void {
  if (!VALID_KEYS.includes(key)) {
    log(`unknown key: ${key}`);
    log(`valid keys: ${VALID_KEYS.join(", ")}`);
    process.exit(1);
  }

  const resolved = loadConfig(getProfileName());

  let value: unknown;
  if (key.startsWith("auth.github.")) {
    const subKey = key.slice("auth.github.".length);
    value = (resolved.auth?.github as Record<string, unknown> | undefined)?.[subKey];
  } else {
    value = resolved[key as keyof CopilotclawConfig];
  }

  if (value === undefined) {
    log(`${key}: (not set)`);
  } else {
    console.log(String(value));
    const envVar = CONFIG_ENV_VARS[key];
    if (envVar !== undefined && process.env[envVar] !== undefined && process.env[envVar] !== "") {
      log(`(overridden by ${envVar})`);
    }
  }
}

export function configSet(key: string, rawValue: string): void {
  if (!VALID_KEYS.includes(key)) {
    log(`unknown key: ${key}`);
    log(`valid keys: ${VALID_KEYS.join(", ")}`);
    process.exit(1);
  }

  const value = parseValue(key, rawValue);
  ensureConfigFile(getProfileName());
  const fileConfig = loadFileConfig(getProfileName());

  if (key.startsWith("auth.github.")) {
    const subKey = key.slice("auth.github.".length);
    if (fileConfig.auth === undefined) fileConfig.auth = {};
    if (fileConfig.auth.github === undefined) fileConfig.auth.github = { type: "gh-auth" };
    (fileConfig.auth.github as unknown as Record<string, unknown>)[subKey] = value;
  } else {
    (fileConfig as Record<string, unknown>)[key] = value;
  }

  saveConfig(fileConfig, getProfileName());
  log(`${key} = ${String(value)}`);

  const envVar = CONFIG_ENV_VARS[key];
  if (envVar !== undefined && process.env[envVar] !== undefined && process.env[envVar] !== "") {
    log(`WARNING: ${envVar} is set — environment variable takes precedence over config file`);
  }
}

export function main(argv: string[] = process.argv.slice(2)): void {
  // argv: ["config", subcommand, key, value?]
  const subcommand = argv[1]; // argv[0] is "config"
  const key = argv[2];
  const value = argv[3];

  if (subcommand === "get" && key !== undefined) {
    configGet(key);
    return;
  }

  if (subcommand === "set" && key !== undefined && value !== undefined) {
    configSet(key, value);
    return;
  }

  log("usage: copilotclaw config <get|set> [args]");
  log("  config get <key>          Show config value");
  log("  config set <key> <value>  Set config value");
  log(`  valid keys: ${VALID_KEYS.join(", ")}`);
  process.exit(1);
}

// Run when executed directly (not imported as module for testing)
const isDirectExecution = process.argv[1]?.endsWith("config-cli.js") === true;
if (isDirectExecution) {
  main();
}
