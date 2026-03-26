import { CONFIG_ENV_VARS, type CopilotclawConfig, ensureConfigFile, loadConfig, loadFileConfig, saveConfig } from "./config.js";

const VALID_KEYS: readonly string[] = Object.keys(CONFIG_ENV_VARS);

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

  const resolved = loadConfig();
  const value = resolved[key as keyof CopilotclawConfig];

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
  ensureConfigFile();
  const fileConfig = loadFileConfig();
  (fileConfig as Record<string, unknown>)[key] = value;
  saveConfig(fileConfig);
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
