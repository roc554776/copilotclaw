import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentStatusResponse, getAgentStatus, stopAgent } from "./ipc-client.js";
import { getAgentSocketPath } from "./ipc-paths.js";

const MIN_AGENT_VERSION = "0.3.0";

export function semverSatisfies(version: string, minVersion: string): boolean {
  // Strip pre-release suffixes (e.g. "1.2.3-beta" → "1.2.3") before comparing
  const parse = (v: string) => v.replace(/-.*$/, "").split(".").map(Number);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(version);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(minVersion);
  if ([aMaj, aMin, aPat, bMaj, bMin, bPat].some(Number.isNaN)) return false;
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

export interface AgentManagerOptions {
  gatewayPort: number;
  agentScript?: string;
}

export class AgentManager {
  private readonly gatewayPort: number;
  private readonly agentScript: string;
  private spawning = false;
  private spawningTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AgentManagerOptions) {
    this.gatewayPort = options.gatewayPort;
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.agentScript = options.agentScript ?? join(thisDir, "..", "..", "agent", "dist", "index.js");
  }

  /** Ensure agent process is running and compatible.
   * Returns the old bootId if force-restart was performed (for waitForNewAgent). */
  async ensureAgent(options?: { forceRestart?: boolean }): Promise<string | undefined> {
    if (this.spawning) return undefined;
    this.spawning = true;
    try {
      const socketPath = getAgentSocketPath();
      const status = await getAgentStatus(socketPath);
      if (status !== null) {
        const versionTooOld = status.version === undefined || !semverSatisfies(status.version, MIN_AGENT_VERSION);
        if (versionTooOld) {
          if (options?.forceRestart) {
            const oldBootId = status.bootId;
            console.error(`[gateway] agent version ${status.version ?? "unknown"} is below minimum ${MIN_AGENT_VERSION}, force-restarting`);
            await stopAgent(socketPath);
            this.spawnAgent();
            return oldBootId;
          }
          throw new Error(
            status.version === undefined
              ? "agent is too old (no version reported)"
              : `agent version ${status.version} is below minimum ${MIN_AGENT_VERSION}`,
          );
        }
        return undefined;
      }
      this.spawnAgent();
      return undefined;
    } finally {
      if (this.spawningTimer !== undefined) clearTimeout(this.spawningTimer);
      this.spawningTimer = setTimeout(() => { this.spawning = false; }, 3000);
      this.spawningTimer.unref();
    }
  }

  /** Wait for agent to come up with a different bootId than the one provided.
   * Used after force-restart to confirm the new agent has started. */
  async waitForNewAgent(oldBootId: string | undefined, timeoutMs = 15000): Promise<boolean> {
    const socketPath = getAgentSocketPath();
    const start = Date.now();
    const interval = 500;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => { setTimeout(r, interval); });
      try {
        const status = await getAgentStatus(socketPath);
        if (status !== null && status.bootId !== oldBootId) {
          return true;
        }
      } catch {
        // Agent not yet reachable
      }
    }
    return false;
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

  async getStatus(): Promise<AgentStatusResponse | null> {
    const socketPath = getAgentSocketPath();
    return getAgentStatus(socketPath);
  }

  /** Check agent compatibility. Returns "compatible", "incompatible", or "unavailable". */
  async checkCompatibility(): Promise<"compatible" | "incompatible" | "unavailable"> {
    const status = await this.getStatus();
    if (status === null) return "unavailable";
    if (status.version === undefined) return "incompatible";
    if (!semverSatisfies(status.version, MIN_AGENT_VERSION)) return "incompatible";
    return "compatible";
  }

  getMinAgentVersion(): string {
    return MIN_AGENT_VERSION;
  }

  async stopAgent(): Promise<void> {
    const socketPath = getAgentSocketPath();
    await stopAgent(socketPath);
  }
}
