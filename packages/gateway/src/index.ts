import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProfileName, resolvePort } from "./config.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const GATEWAY_VERSION = (JSON.parse(readFileSync(join(thisDir, "..", "package.json"), "utf-8")) as { version: string }).version;

const HEALTH_RETRY_COUNT = 5;
const HEALTH_RETRY_INTERVAL_MS = 1000;

function log(message: string): void {
  console.error(`[gateway] ${message}`);
}

function checkHealth(port: number): Promise<"healthy" | "unhealthy" | "port-free"> {
  return (async () => {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return "healthy" as const;
      return "unhealthy" as const;
    } catch {
      return "port-free" as const;
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function spawnDaemon(options?: { forceAgentRestart?: boolean }): void {
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

async function waitForHealthy(port: number): Promise<boolean> {
  for (let i = 0; i < HEALTH_RETRY_COUNT; i++) {
    await sleep(HEALTH_RETRY_INTERVAL_MS);
    const status = await checkHealth(port);
    if (status === "healthy") return true;
  }
  return false;
}

async function checkAgentCompatibility(port: number, waitForAgent = false): Promise<void> {
  const maxAttempts = waitForAgent ? 30 : 1; // 30 * 500ms = 15s
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(500);
    try {
      const statusRes = await fetch(`http://localhost:${port}/api/status`);
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
  const port = resolvePort(getProfileName());
  const forceAgentRestart = process.argv.includes("--force-agent-restart") || process.env["COPILOTCLAW_FORCE_AGENT_RESTART_FLAG"] === "1";

  if (forceAgentRestart) {
    log("--force-agent-restart: will stop outdated agent on startup");
  }

  const initialStatus = await checkHealth(port);

  if (initialStatus === "healthy") {
    // Check if the running gateway belongs to a different profile
    const myProfile = getProfileName() ?? null;
    try {
      const statusRes = await fetch(`http://localhost:${port}/api/status`);
      if (statusRes.ok) {
        const status = await statusRes.json() as { gateway?: { profile?: string | null } };
        const runningProfile = status.gateway?.profile ?? null;
        if (runningProfile !== myProfile) {
          const mine = myProfile ?? "(default)";
          const theirs = runningProfile ?? "(default)";
          log(`ERROR: port ${port} is occupied by a gateway with profile ${theirs}, but this is profile ${mine}`);
          process.exit(1);
        }
      }
    } catch {
      // Cannot determine profile — proceed normally
    }
    log(`v${GATEWAY_VERSION} already running on port ${port}`);
    await checkAgentCompatibility(port, forceAgentRestart);
    log(`open http://localhost:${port} in your browser to chat with the agent`);
    log(`run 'copilotclaw stop' to shut down`);
    return;
  }

  if (initialStatus === "unhealthy") {
    log(`port ${port} is occupied but unhealthy, retrying...`);
    for (let i = 0; i < HEALTH_RETRY_COUNT; i++) {
      await sleep(HEALTH_RETRY_INTERVAL_MS);
      const status = await checkHealth(port);
      if (status === "healthy") {
        log(`v${GATEWAY_VERSION} became healthy`);
        await checkAgentCompatibility(port, forceAgentRestart);
        log(`open http://localhost:${port} in your browser to chat with the agent`);
        log(`run 'copilotclaw stop' to shut down`);
        return;
      }
      if (status === "port-free") {
        log("port freed, starting daemon...");
        spawnDaemon({ forceAgentRestart });
        if (await waitForHealthy(port)) {
          log(`v${GATEWAY_VERSION} running on http://localhost:${port}`);
          await checkAgentCompatibility(port, forceAgentRestart);
          log(`open http://localhost:${port} in your browser to chat with the agent`);
          log(`run 'copilotclaw stop' to shut down`);
          return;
        }
        throw new Error("daemon failed to start");
      }
    }
    throw new Error(`port ${port} is occupied but not healthy after ${HEALTH_RETRY_COUNT} retries`);
  }

  log("starting gateway daemon...");
  spawnDaemon({ forceAgentRestart });

  if (!(await waitForHealthy(port))) {
    throw new Error("daemon failed to start");
  }

  log(`v${GATEWAY_VERSION} running on http://localhost:${port}`);
  await checkAgentCompatibility(port, forceAgentRestart);
  log(`open http://localhost:${port} in your browser to chat with the agent`);
  log(`run 'copilotclaw stop' to shut down`);
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
