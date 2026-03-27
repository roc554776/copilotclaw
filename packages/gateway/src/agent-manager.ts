import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentStatusResponse, getAgentModels, getAgentQuota, getAgentSessionMessages, getAgentStatus, stopAgent } from "./ipc-client.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { getDataDir } from "./workspace.js";

export const MIN_AGENT_VERSION = "0.3.0";

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
    const require = createRequire(import.meta.url);
    let defaultAgentScript: string;
    try {
      defaultAgentScript = join(dirname(require.resolve("@copilotclaw/agent/package.json")), "dist", "index.js");
    } catch {
      // Fallback for monorepo dev (workspace symlinks)
      console.error("[gateway] @copilotclaw/agent not found via package resolution, using relative path fallback");
      const thisDir = dirname(fileURLToPath(import.meta.url));
      defaultAgentScript = join(thisDir, "..", "..", "agent", "dist", "index.js");
    }
    this.agentScript = options.agentScript ?? defaultAgentScript;
  }

  /** Ensure agent process is running and compatible.
   * When forceRestart is true and the agent version is outdated, stops the old agent and spawns a new one.
   * Returns the old bootId if a force-restart was performed (pass to waitForNewAgent).
   * If the agent is already at a compatible version, forceRestart has no effect. */
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
   * Used after force-restart to confirm the new agent has started.
   * oldBootId must be a non-undefined string — comparing against undefined is meaningless. */
  async waitForNewAgent(oldBootId: string, timeoutMs = 15000): Promise<boolean> {
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
    // Redirect agent stderr to a log file for post-mortem diagnosis.
    // Agent also writes structured JSON logs internally, but this captures
    // unhandled crashes and SDK-level output that occur before logger setup.
    const agentLogPath = join(getDataDir(), "agent.log");
    let stderrFd: number | "ignore" = "ignore";
    try {
      stderrFd = openSync(agentLogPath, "a");
    } catch {
      console.error(`[gateway] WARNING: could not open agent log file ${agentLogPath}`);
    }

    const child = spawn(process.execPath, [this.agentScript], {
      detached: true,
      stdio: ["ignore", "ignore", stderrFd],
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

  async getQuota(): Promise<Record<string, unknown> | null> {
    const socketPath = getAgentSocketPath();
    return getAgentQuota(socketPath);
  }

  async getModels(): Promise<Record<string, unknown> | null> {
    const socketPath = getAgentSocketPath();
    return getAgentModels(socketPath);
  }

  async getSessionMessages(sessionId: string): Promise<unknown[] | null> {
    const socketPath = getAgentSocketPath();
    return getAgentSessionMessages(socketPath, sessionId);
  }

  async stopAgent(): Promise<void> {
    const socketPath = getAgentSocketPath();
    await stopAgent(socketPath);
  }
}
