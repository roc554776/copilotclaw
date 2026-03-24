import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentStatusResponse, getAgentStatus, restartAgent, stopAgent } from "./ipc-client.js";
import { getAgentSocketPath } from "./ipc-paths.js";

const STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface AgentManagerOptions {
  gatewayPort: number;
  agentScript?: string;
  staleTimeoutMs?: number;
}

export class AgentManager {
  private readonly gatewayPort: number;
  private readonly agentScript: string;
  private readonly staleTimeoutMs: number;

  constructor(options: AgentManagerOptions) {
    this.gatewayPort = options.gatewayPort;
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.agentScript = options.agentScript ?? join(thisDir, "..", "..", "agent", "dist", "index.js");
    this.staleTimeoutMs = options.staleTimeoutMs ?? STALE_TIMEOUT_MS;
  }

  async getStatus(channelId: string): Promise<AgentStatusResponse | null> {
    const socketPath = getAgentSocketPath(channelId);
    return getAgentStatus(socketPath);
  }

  async ensureAgent(channelId: string): Promise<void> {
    const status = await this.getStatus(channelId);

    if (status !== null) {
      // Agent is running — check for stale processing
      if (status.status === "processing") {
        const processingStartedAt = status.restartedAt ?? status.startedAt;
        const elapsed = Date.now() - new Date(processingStartedAt).getTime();
        if (elapsed > this.staleTimeoutMs) {
          console.error(`[gateway] agent for ${channelId.slice(0, 8)} stuck processing for ${Math.round(elapsed / 1000)}s, requesting restart`);
          await this.requestRestart(channelId);
        }
      }
      return;
    }

    // Agent not running — spawn it detached
    this.spawnAgent(channelId);
  }

  private spawnAgent(channelId: string): void {
    const child = spawn(process.execPath, [this.agentScript], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        COPILOTCLAW_GATEWAY_URL: `http://localhost:${this.gatewayPort}`,
        COPILOTCLAW_CHANNEL_ID: channelId,
      },
    });
    child.unref();
    console.error(`[gateway] spawned agent for channel ${channelId.slice(0, 8)} (pid=${child.pid})`);
  }

  private async requestRestart(channelId: string): Promise<void> {
    const socketPath = getAgentSocketPath(channelId);
    const ok = await restartAgent(socketPath);
    if (!ok) {
      console.error(`[gateway] failed to restart agent for ${channelId.slice(0, 8)}`);
    }
  }

  async stopAll(channelIds: string[]): Promise<void> {
    await Promise.allSettled(
      channelIds.map((id) => stopAgent(getAgentSocketPath(id))),
    );
  }
}
