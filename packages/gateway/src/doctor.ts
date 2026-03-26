import { existsSync, unlinkSync } from "node:fs";
import { ensureConfigFile, getConfigFilePath, loadFileConfig, resolvePort } from "./config.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { getAgentStatus } from "./ipc-client.js";
import { semverSatisfies } from "./agent-manager.js";
import { ensureWorkspace, getDataDir, getWorkspaceRoot } from "./workspace.js";

const MIN_AGENT_VERSION = "0.3.0";

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
  const root = getWorkspaceRoot();
  const dataDir = getDataDir();
  if (!existsSync(root)) {
    return { name: "workspace", result: "fail", message: `workspace directory missing: ${root}`, fixable: true };
  }
  if (!existsSync(dataDir)) {
    return { name: "workspace", result: "fail", message: `data directory missing: ${dataDir}`, fixable: true };
  }
  return { name: "workspace", result: "pass", message: root };
}

export function checkConfig(): DiagnosticResult {
  const configPath = getConfigFilePath();
  if (!existsSync(configPath)) {
    return { name: "config", result: "warn", message: `config file missing: ${configPath}`, fixable: true };
  }
  try {
    const config = loadFileConfig();
    // Validate port if set
    if (config.port !== undefined) {
      if (typeof config.port !== "number" || !Number.isFinite(config.port) || config.port <= 0 || config.port > 65535) {
        return { name: "config", result: "warn", message: `invalid port value in config: ${String(config.port)}` };
      }
    }
    return { name: "config", result: "pass", message: configPath };
  } catch {
    return { name: "config", result: "warn", message: `config file is malformed: ${configPath}` };
  }
}

export async function checkGateway(): Promise<DiagnosticResult> {
  const port = resolvePort();
  try {
    const res = await fetch(`http://localhost:${port}/healthz`);
    if (res.ok) {
      return { name: "gateway", result: "pass", message: `running on port ${port}` };
    }
    return { name: "gateway", result: "warn", message: `unhealthy response on port ${port}` };
  } catch {
    return { name: "gateway", result: "warn", message: `not running (port ${port})` };
  }
}

export async function checkAgent(): Promise<DiagnosticResult> {
  const socketPath = getAgentSocketPath();
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

export function checkStaleSocket(): DiagnosticResult {
  const socketPath = getAgentSocketPath();
  if (!existsSync(socketPath)) {
    return { name: "ipc-socket", result: "pass", message: "no socket file" };
  }

  // Try to connect to verify it's alive
  return { name: "ipc-socket", result: "pass", message: socketPath };
}

export function fixWorkspace(): boolean {
  try {
    ensureWorkspace();
    return true;
  } catch {
    return false;
  }
}

export function fixConfig(): boolean {
  try {
    ensureConfigFile();
    return true;
  } catch {
    return false;
  }
}

export function fixStaleSocket(): boolean {
  const socketPath = getAgentSocketPath();
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
