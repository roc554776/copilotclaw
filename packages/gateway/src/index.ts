import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_PORT } from "./server.js";

const HEALTH_RETRY_COUNT = 5;
const HEALTH_RETRY_INTERVAL_MS = 1000;

function log(message: string): void {
  console.error(`[gateway] ${message}`);
}

async function checkHealth(): Promise<"healthy" | "unhealthy" | "port-free"> {
  try {
    const res = await fetch(`http://localhost:${DEFAULT_PORT}/healthz`);
    if (res.ok) return "healthy";
    return "unhealthy";
  } catch {
    return "port-free";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function spawnDaemon(options?: { forceAgentRestart?: boolean }): void {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const daemonScript = join(thisDir, "daemon.js");

  const env = { ...process.env };
  if (options?.forceAgentRestart) {
    env["COPILOTCLAW_FORCE_AGENT_RESTART"] = "1";
  }

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

async function waitForHealthy(): Promise<boolean> {
  for (let i = 0; i < HEALTH_RETRY_COUNT; i++) {
    await sleep(HEALTH_RETRY_INTERVAL_MS);
    const status = await checkHealth();
    if (status === "healthy") return true;
  }
  return false;
}

async function checkAgentCompatibility(waitForAgent = false): Promise<void> {
  const maxAttempts = waitForAgent ? 30 : 1; // 30 * 500ms = 15s
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(500);
    try {
      const statusRes = await fetch(`http://localhost:${DEFAULT_PORT}/api/status`);
      if (!statusRes.ok) continue;
      const status = await statusRes.json() as { agentCompatibility?: string; agent?: { version?: string } | null };
      const compat = status.agentCompatibility ?? "unavailable";
      if (compat === "compatible") {
        log(`agent: compatible (v${status.agent?.version ?? "?"})`);
        return;
      } else if (compat === "incompatible") {
        log(`ERROR: agent is incompatible (v${status.agent?.version ?? "?"}). Use --force-agent-restart to upgrade.`);
        process.exit(1);
      } else if (!waitForAgent) {
        log(`WARNING: agent is not running`);
        return;
      }
      // If waitForAgent, keep trying until agent appears
    } catch {
      if (!waitForAgent) {
        log("WARNING: could not verify agent status");
        return;
      }
    }
  }
  log("WARNING: agent did not start within timeout");
}

async function main(): Promise<void> {
  const forceAgentRestart = process.argv.includes("--force-agent-restart") || process.env["COPILOTCLAW_FORCE_AGENT_RESTART_FLAG"] === "1";

  if (forceAgentRestart) {
    log("--force-agent-restart: will stop outdated agent on startup");
  }

  const initialStatus = await checkHealth();

  if (initialStatus === "healthy") {
    log(`already running on port ${DEFAULT_PORT}`);
    await checkAgentCompatibility(forceAgentRestart);
    log(`open http://localhost:${DEFAULT_PORT} in your browser to chat with the agent`);
    log(`run 'copilotclaw stop' to shut down`);
    return;
  }

  if (initialStatus === "unhealthy") {
    log(`port ${DEFAULT_PORT} is occupied but unhealthy, retrying...`);
    for (let i = 0; i < HEALTH_RETRY_COUNT; i++) {
      await sleep(HEALTH_RETRY_INTERVAL_MS);
      const status = await checkHealth();
      if (status === "healthy") {
        log("became healthy");
        await checkAgentCompatibility(forceAgentRestart);
        log(`open http://localhost:${DEFAULT_PORT} in your browser to chat with the agent`);
        log(`run 'copilotclaw stop' to shut down`);
        return;
      }
      if (status === "port-free") {
        log("port freed, starting daemon...");
        spawnDaemon({ forceAgentRestart });
        if (await waitForHealthy()) {
          log(`running on http://localhost:${DEFAULT_PORT}`);
          await checkAgentCompatibility(forceAgentRestart);
          log(`open http://localhost:${DEFAULT_PORT} in your browser to chat with the agent`);
          log(`run 'copilotclaw stop' to shut down`);
          return;
        }
        throw new Error("daemon failed to start");
      }
    }
    throw new Error(`port ${DEFAULT_PORT} is occupied but not healthy after ${HEALTH_RETRY_COUNT} retries`);
  }

  log("starting gateway daemon...");
  spawnDaemon({ forceAgentRestart });

  if (!(await waitForHealthy())) {
    throw new Error("daemon failed to start");
  }

  log(`running on http://localhost:${DEFAULT_PORT}`);
  await checkAgentCompatibility(forceAgentRestart);
  log(`open http://localhost:${DEFAULT_PORT} in your browser to chat with the agent`);
  log(`run 'copilotclaw stop' to shut down`);
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
