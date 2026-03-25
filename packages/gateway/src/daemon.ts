import { AgentManager } from "./agent-manager.js";
import { DEFAULT_PORT, startServer } from "./server.js";
import { Store } from "./store.js";
import { ensureWorkspace, getStoreFilePath } from "./workspace.js";

async function main(): Promise<void> {
  const forceAgentRestart = process.env["COPILOTCLAW_FORCE_AGENT_RESTART"] === "1";

  ensureWorkspace();
  const store = new Store({ persistPath: getStoreFilePath() });
  const agentManager = new AgentManager({ gatewayPort: DEFAULT_PORT });

  // Always ensure agent process on gateway start (version check + spawn if absent)
  try {
    await agentManager.ensureAgent({ forceRestart: forceAgentRestart });
  } catch (err: unknown) {
    console.error("[gateway] agent ensure failed:", err);
    // Gateway starts anyway — agent can be started manually later
  }

  await startServer({ store, agentManager });
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
