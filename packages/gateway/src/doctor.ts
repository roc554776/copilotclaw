import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { MIN_AGENT_VERSION, semverSatisfies } from "./agent-manager.js";
import { type AuthConfig, NON_PREMIUM_MODELS, ensureConfigFile, getConfigFilePath, getProfileName, loadConfig, resolvePort } from "./config.js";
import { getAgentStatus } from "./ipc-client.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { ensureWorkspace, getDataDir, getWorkspaceRoot } from "./workspace.js";

type CheckResult = "pass" | "warn" | "fail";

interface DiagnosticResult {
  name: string;
  result: CheckResult;
  message: string;
  fixable?: boolean;
}

function log(result: DiagnosticResult): void {
  const tag = result.result === "pass" ? "pass" : result.result === "warn" ? "warn" : "FAIL";
  const fixHint = result.fixable && result.result !== "pass" ? " (fixable with --fix)" : "";
  console.error(`[doctor] ${tag}: ${result.name} — ${result.message}${fixHint}`);
}

export function checkWorkspace(): DiagnosticResult {
  const root = getWorkspaceRoot(getProfileName());
  const dataDir = getDataDir(getProfileName());
  if (!existsSync(root)) {
    return { name: "workspace", result: "fail", message: `workspace directory missing: ${root}`, fixable: true };
  }
  if (!existsSync(dataDir)) {
    return { name: "workspace", result: "fail", message: `data directory missing: ${dataDir}`, fixable: true };
  }
  return { name: "workspace", result: "pass", message: root };
}

export function checkConfig(): DiagnosticResult {
  const configPath = getConfigFilePath(getProfileName());
  if (!existsSync(configPath)) {
    return { name: "config", result: "warn", message: `config file missing: ${configPath}`, fixable: true };
  }

  // Parse raw file to detect malformed JSON (loadFileConfig silently swallows errors)
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { name: "config", result: "warn", message: `config file is malformed: ${configPath}` };
  }

  // Validate port if set
  const port = config["port"];
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isFinite(port) || port <= 0 || port > 65535) {
      return { name: "config", result: "warn", message: `invalid port value in config: ${String(port)}` };
    }
  }
  return { name: "config", result: "pass", message: configPath };
}

export async function checkGateway(): Promise<DiagnosticResult> {
  const port = resolvePort(getProfileName());
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return { name: "gateway", result: "pass", message: `running on port ${port}` };
    }
    return { name: "gateway", result: "warn", message: `unhealthy response on port ${port}` };
  } catch {
    return { name: "gateway", result: "warn", message: `not running (port ${port})` };
  }
}

export async function checkAgent(): Promise<DiagnosticResult> {
  const socketPath = getAgentSocketPath(getProfileName());
  if (!existsSync(socketPath)) {
    return { name: "agent", result: "warn", message: "not running (no socket file)" };
  }

  const status = await getAgentStatus(socketPath);
  if (status === null) {
    return { name: "agent", result: "warn", message: `socket exists but agent not reachable: ${socketPath}`, fixable: true };
  }

  if (status.version === undefined) {
    return { name: "agent", result: "fail", message: "agent version unknown (too old)" };
  }

  if (!semverSatisfies(status.version, MIN_AGENT_VERSION)) {
    return { name: "agent", result: "fail", message: `agent version ${status.version} below minimum ${MIN_AGENT_VERSION}` };
  }

  return { name: "agent", result: "pass", message: `v${status.version} (boot: ${status.bootId ?? "?"})` };
}

export function checkZeroPremium(): DiagnosticResult {
  const config = loadConfig(getProfileName());
  if (!config.zeroPremium) {
    return { name: "zero-premium", result: "pass", message: "disabled" };
  }

  // NON_PREMIUM_MODELS imported from config.ts (single source of truth within gateway)

  if (config.model !== undefined && !NON_PREMIUM_MODELS.includes(config.model)) {
    return {
      name: "zero-premium",
      result: "warn",
      message: `zeroPremium is enabled but model "${config.model}" consumes premium requests — will be overridden to ${NON_PREMIUM_MODELS[0]}`,
    };
  }

  return { name: "zero-premium", result: "pass", message: `enabled (model: ${config.model ?? NON_PREMIUM_MODELS[0]})` };
}

export function checkAuth(): DiagnosticResult {
  const config = loadConfig(getProfileName());
  if (config.auth === undefined) {
    return { name: "auth", result: "pass", message: "not configured (using default Copilot CLI auth)" };
  }

  const auth: AuthConfig = config.auth;

  if (auth.type === "gh-auth") {
    // Check tokenCommand or gh CLI availability
    if (auth.tokenCommand !== undefined) {
      return { name: "auth", result: "pass", message: `gh-auth via custom command` };
    }
    try {
      const args = ["auth", "token"];
      if (auth.user !== undefined) args.push("--user", auth.user);
      if (auth.hostname !== undefined) args.push("--hostname", auth.hostname);
      execFileSync("gh", args, { encoding: "utf-8", timeout: 5000 });
      const detail = auth.user !== undefined ? ` (user: ${auth.user})` : "";
      return { name: "auth", result: "pass", message: `gh-auth${detail}` };
    } catch {
      const detail = auth.user !== undefined ? ` --user ${auth.user}` : "";
      return { name: "auth", result: "fail", message: `gh auth token${detail} failed — run "gh auth login" first` };
    }
  }

  if (auth.type === "pat" || auth.type === "oauth") {
    if (auth.tokenCommand !== undefined) {
      return { name: "auth", result: "pass", message: `${auth.type} via custom command` };
    }
    if (auth.tokenEnv !== undefined) {
      const val = process.env[auth.tokenEnv];
      if (val === undefined || val === "") {
        return { name: "auth", result: "fail", message: `${auth.type}: env var "${auth.tokenEnv}" is not set` };
      }
      return { name: "auth", result: "pass", message: `${auth.type} via env ${auth.tokenEnv}` };
    }
    if (auth.tokenFile !== undefined) {
      if (!existsSync(auth.tokenFile)) {
        return { name: "auth", result: "fail", message: `${auth.type}: token file not found: ${auth.tokenFile}` };
      }
      return { name: "auth", result: "pass", message: `${auth.type} via file ${auth.tokenFile}` };
    }
    return { name: "auth", result: "fail", message: `${auth.type}: no tokenEnv, tokenFile, or tokenCommand configured` };
  }

  return { name: "auth", result: "warn", message: `unknown auth type: ${String(auth.type)}` };
}

export function fixWorkspace(): boolean {
  try {
    ensureWorkspace(getProfileName());
    return true;
  } catch {
    return false;
  }
}

export function fixConfig(): boolean {
  try {
    ensureConfigFile(getProfileName());
    return true;
  } catch {
    return false;
  }
}

export function fixStaleSocket(): boolean {
  const socketPath = getAgentSocketPath(getProfileName());
  if (!existsSync(socketPath)) return true;
  try {
    unlinkSync(socketPath);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(fix: boolean): Promise<boolean> {
  const results: DiagnosticResult[] = [];

  // Synchronous checks
  results.push(checkWorkspace());
  results.push(checkConfig());
  results.push(checkZeroPremium());
  results.push(checkAuth());

  // Async checks
  results.push(await checkGateway());
  results.push(await checkAgent());

  // Log all results
  for (const r of results) {
    log(r);
  }

  // Apply fixes if requested
  if (fix) {
    let fixed = false;
    for (const r of results) {
      if (r.fixable && r.result !== "pass") {
        let ok = false;
        if (r.name === "workspace") ok = fixWorkspace();
        else if (r.name === "config") ok = fixConfig();
        else if (r.name === "agent") ok = fixStaleSocket();

        if (ok) {
          console.error(`[doctor] fixed: ${r.name}`);
          fixed = true;
        } else {
          console.error(`[doctor] fix failed: ${r.name}`);
        }
      }
    }
    if (!fixed) {
      console.error("[doctor] nothing to fix");
    }
  }

  const hasFailures = results.some((r) => r.result === "fail");
  return !hasFailures;
}

async function main(): Promise<void> {
  const fix = process.argv.includes("--fix");
  const ok = await runDoctor(fix);
  if (!ok) {
    process.exit(1);
  }
}

const isDirectExecution = process.argv[1]?.endsWith("doctor.js") === true;
if (isDirectExecution) {
  main().catch((err: unknown) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
