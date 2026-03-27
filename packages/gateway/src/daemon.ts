import { AgentManager } from "./agent-manager.js";
import { getProfileName, resolvePort } from "./config.js";
import { LogBuffer } from "./log-buffer.js";
import { startServer } from "./server.js";
import { Store } from "./store.js";
import { ensureWorkspace, getStoreFilePath } from "./workspace.js";

const AGENT_MONITOR_INTERVAL_MS = 30_000; // 30 seconds
const AGENT_MONITOR_ERROR_THRESHOLD = 3;

async function main(): Promise<void> {
  const forceAgentRestart = process.env["COPILOTCLAW_FORCE_AGENT_RESTART"] === "1";

  ensureWorkspace(getProfileName());
  const logBuffer = new LogBuffer();
  logBuffer.interceptConsole();
  const store = new Store({ persistPath: getStoreFilePath(getProfileName()) });
  const port = resolvePort(getProfileName());
  const agentManager = new AgentManager({ gatewayPort: port });

  // Always ensure agent process on gateway start (version check + spawn if absent)
  try {
    const oldBootId = await agentManager.ensureAgent({ forceRestart: forceAgentRestart });
    // If force-restart was performed, wait for the new agent to come up
    if (oldBootId !== undefined) {
      console.error("[gateway] waiting for new agent to start...");
      const ok = await agentManager.waitForNewAgent(oldBootId);
      if (ok) {
        console.error("[gateway] new agent started successfully");
      } else {
        console.error("[gateway] WARNING: new agent did not start within timeout");
      }
    }
  } catch (err: unknown) {
    console.error("[gateway] agent ensure failed:", err);
  }

  await startServer({ port, store, agentManager, logBuffer });

  // Periodic agent process monitoring
  let consecutiveFailures = 0;
  const monitor = setInterval(async () => {
    try {
      await agentManager.ensureAgent();
      if (consecutiveFailures > 0) {
        console.error("[gateway] agent process recovered");
      }
      consecutiveFailures = 0;
    } catch (err: unknown) {
      consecutiveFailures++;
      if (consecutiveFailures >= AGENT_MONITOR_ERROR_THRESHOLD) {
        console.error(`[gateway] agent process ERROR: health check failed after ${consecutiveFailures} attempts:`, err);
      } else {
        console.error(`[gateway] agent ensure failed (attempt ${consecutiveFailures}/${AGENT_MONITOR_ERROR_THRESHOLD}):`, err);
      }
    }
  }, AGENT_MONITOR_INTERVAL_MS);
  monitor.unref();
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
