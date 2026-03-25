import { AgentManager } from "./agent-manager.js";
import { DEFAULT_PORT, startServer } from "./server.js";

async function main(): Promise<void> {
  const forceAgentRestart = process.env["COPILOTCLAW_FORCE_AGENT_RESTART"] === "1";

  if (forceAgentRestart) {
    const mgr = new AgentManager({ gatewayPort: DEFAULT_PORT });
    try {
      await mgr.ensureAgent({ forceRestart: true });
    } catch (err: unknown) {
      console.error("[gateway] force-agent-restart failed:", err);
    }
  }

  await startServer();
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
