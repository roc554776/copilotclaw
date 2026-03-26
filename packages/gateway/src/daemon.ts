import { AgentManager } from "./agent-manager.js";
import { LogBuffer } from "./log-buffer.js";
import { DEFAULT_PORT, startServer } from "./server.js";
import { Store } from "./store.js";
import { ensureWorkspace, getStoreFilePath } from "./workspace.js";

const AGENT_MONITOR_INTERVAL_MS = 30_000; // 30 seconds
const AGENT_MONITOR_ERROR_THRESHOLD = 3;

async function main(): Promise<void> {
  const forceAgentRestart = process.env["COPILOTCLAW_FORCE_AGENT_RESTART"] === "1";

  ensureWorkspace();
  const logBuffer = new LogBuffer();
  logBuffer.interceptConsole();
  const store = new Store({ persistPath: getStoreFilePath() });
  const agentManager = new AgentManager({ gatewayPort: DEFAULT_PORT });

  // Always ensure agent process on gateway start (version check + spawn if absent)
  try {
    await agentManager.ensureAgent({ forceRestart: forceAgentRestart });
  } catch (err: unknown) {
    console.error("[gateway] agent ensure failed:", err);
  }

  await startServer({ store, agentManager, logBuffer });

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
