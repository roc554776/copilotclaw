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

async function main(): Promise<void> {
  const forceAgentRestart = process.argv.includes("--force-agent-restart") || process.env["COPILOTCLAW_FORCE_AGENT_RESTART_FLAG"] === "1";

  if (forceAgentRestart) {
    log("--force-agent-restart: will stop outdated agent on startup");
  }

  const initialStatus = await checkHealth();

  if (initialStatus === "healthy") {
    log(`already running on port ${DEFAULT_PORT}`);
    return;
  }

  if (initialStatus === "unhealthy") {
    log(`port ${DEFAULT_PORT} is occupied but unhealthy, retrying...`);
    for (let i = 0; i < HEALTH_RETRY_COUNT; i++) {
      await sleep(HEALTH_RETRY_INTERVAL_MS);
      const status = await checkHealth();
      if (status === "healthy") {
        log("became healthy");
        return;
      }
      if (status === "port-free") {
        log("port freed, starting daemon...");
        spawnDaemon({ forceAgentRestart });
        if (await waitForHealthy()) {
          log(`running on http://localhost:${DEFAULT_PORT}`);
          return;
        }
        throw new Error("daemon failed to start");
      }
    }
    throw new Error(`port ${DEFAULT_PORT} is occupied but not healthy after ${HEALTH_RETRY_COUNT} retries`);
  }

  log("starting gateway daemon...");
  spawnDaemon({ forceAgentRestart });

  if (await waitForHealthy()) {
    log(`running on http://localhost:${DEFAULT_PORT}`);
    log(`open http://localhost:${DEFAULT_PORT} in your browser to chat with the agent`);
    log(`run 'copilotclaw stop' to shut down`);
  } else {
    throw new Error("daemon failed to start");
  }
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
