import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { MIN_AGENT_VERSION, semverSatisfies } from "./agent-manager.js";
import { ensureConfigFile, getConfigFilePath, resolvePort } from "./config.js";
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
  const port = resolvePort();
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

export async function checkIpcSocket(): Promise<DiagnosticResult> {
  const socketPath = getAgentSocketPath();
  if (!existsSync(socketPath)) {
    return { name: "ipc-socket", result: "pass", message: "no socket file" };
  }

  // Probe liveness by attempting to get agent status
  const status = await getAgentStatus(socketPath);
  if (status !== null) {
    return { name: "ipc-socket", result: "pass", message: socketPath };
  }
  return { name: "ipc-socket", result: "warn", message: `stale socket detected: ${socketPath}`, fixable: true };
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
  results.push(await checkIpcSocket());

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
        else if (r.name === "agent" || r.name === "ipc-socket") ok = fixStaleSocket();

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
