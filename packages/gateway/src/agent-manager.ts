import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentManagerOptions {
  gatewayPort: number;
  agentScript?: string;
}

export class AgentManager {
  private readonly agents = new Map<string, ChildProcess>();
  private readonly gatewayPort: number;
  private readonly agentScript: string;

  constructor(options: AgentManagerOptions) {
    this.gatewayPort = options.gatewayPort;
    // Default: resolve agent's dist/index.js relative to gateway
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.agentScript = options.agentScript ?? join(thisDir, "..", "..", "agent", "dist", "index.js");
  }

  hasAgent(channelId: string): boolean {
    const child = this.agents.get(channelId);
    if (child === undefined) return false;
    // Check if process is still alive
    if (child.exitCode !== null || child.signalCode !== null) {
      this.agents.delete(channelId);
      return false;
    }
    return true;
  }

  spawnAgent(channelId: string): void {
    if (this.hasAgent(channelId)) return;

    const child = spawn(process.execPath, [this.agentScript], {
      env: {
        ...process.env,
        COPILOTCLAW_GATEWAY_URL: `http://localhost:${this.gatewayPort}`,
        COPILOTCLAW_CHANNEL_ID: channelId,
      },
      stdio: "pipe",
    });

    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[agent:${channelId.slice(0, 8)}] ${data.toString()}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[agent:${channelId.slice(0, 8)}] ${data.toString()}`);
    });

    child.on("exit", (code, signal) => {
      console.error(`[gateway] agent for channel ${channelId.slice(0, 8)} exited (code=${code}, signal=${signal})`);
      this.agents.delete(channelId);
    });

    this.agents.set(channelId, child);
    console.error(`[gateway] spawned agent for channel ${channelId.slice(0, 8)}`);
  }

  killAll(): void {
    for (const [channelId, child] of this.agents) {
      child.kill("SIGTERM");
      this.agents.delete(channelId);
    }
  }
}
