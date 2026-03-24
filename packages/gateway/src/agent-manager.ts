import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentStatus, stopAgent } from "./ipc-client.js";
import { getAgentSocketPath } from "./ipc-paths.js";

export interface AgentManagerOptions {
  gatewayPort: number;
  agentScript?: string;
}

export class AgentManager {
  private readonly gatewayPort: number;
  private readonly agentScript: string;
  private spawning = false;

  constructor(options: AgentManagerOptions) {
    this.gatewayPort = options.gatewayPort;
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.agentScript = options.agentScript ?? join(thisDir, "..", "..", "agent", "dist", "index.js");
  }

  async ensureAgent(): Promise<void> {
    if (this.spawning) return;
    const socketPath = getAgentSocketPath();
    const status = await getAgentStatus(socketPath);
    if (status !== null) return;

    this.spawning = true;
    try {
      this.spawnAgent();
    } finally {
      // Reset after grace period for socket to be bound
      setTimeout(() => { this.spawning = false; }, 3000);
    }
  }

  private spawnAgent(): void {
    const child = spawn(process.execPath, [this.agentScript], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        COPILOTCLAW_GATEWAY_URL: `http://localhost:${this.gatewayPort}`,
      },
    });
    child.unref();
    console.error(`[gateway] spawned agent process (pid=${child.pid})`);
  }

  async stopAgent(): Promise<void> {
    const socketPath = getAgentSocketPath();
    await stopAgent(socketPath);
  }
}
