import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentStatusResponse, type IpcStream, createStreamConnection, getAgentModels, getAgentQuota, getAgentSessionMessages, getAgentStatus, stopAgent } from "./ipc-client.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { getDataDir } from "./workspace.js";

export const MIN_AGENT_VERSION = "0.68.0";

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
  agentScript?: string;
}

export interface RunningSessionReport {
  sessionId: string;
  status: string;
}

export interface LifecycleRequest {
  event: "idle" | "error";
  sessionId: string;
  elapsedMs: number;
  error?: string | undefined;
}

export interface LifecycleResponse {
  action: "stop" | "reinject" | "wait";
  clearCopilotSessionId?: boolean;
}

export interface ToolCallRequest {
  toolName: string;
  sessionId: string;
  args: Record<string, unknown>;
}

export interface HookRequest {
  hookName: string;
  sessionId: string;
  copilotSessionId?: string | undefined;
  input: Record<string, unknown>;
}

export interface StreamMessageHandler {
  onToolCall?: (request: ToolCallRequest) => unknown | Promise<unknown>;
  onLifecycle?: (request: LifecycleRequest) => LifecycleResponse;
  onHook?: (request: HookRequest) => Record<string, unknown> | null;
  onChannelMessage?: (sessionId: string, sender: string, message: string) => void;
  onSessionEvent?: (sessionId: string, copilotSessionId: string | undefined, type: string, timestamp: string, data: Record<string, unknown>, parentId?: string) => void;
  onSystemPromptOriginal?: (model: string, prompt: string, capturedAt: string) => void;
  onSystemPromptSession?: (sessionId: string, model: string, prompt: string) => void;
  onPhysicalSessionStarted?: (sessionId: string, copilotSessionId: string, model: string) => void;
  onPhysicalSessionEnded?: (sessionId: string, reason: "idle" | "error" | "aborted", copilotSessionId: string, elapsedMs: number, error?: string) => void;
  onRunningSessionsReport?: (sessions: RunningSessionReport[]) => void;
  onDrainPending?: (sessionId: string) => unknown[];
  onPeekPending?: (sessionId: string) => unknown | null;
  onFlushPending?: (sessionId: string) => number;
  onListMessages?: (sessionId: string, limit: number) => unknown[];
}

export class AgentManager {
  private readonly agentScript: string;
  private spawning = false;
  private spawningTimer: ReturnType<typeof setTimeout> | undefined;
  private stream: IpcStream | null = null;
  private streamMessageHandler: StreamMessageHandler | null = null;
  private configToSend: Record<string, unknown> | null = null;
  private streamConnectedCallbacks: Array<() => void> = [];
  private streamDisconnectedCallbacks: Array<() => void> = [];

  constructor(options?: AgentManagerOptions) {
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
    this.agentScript = options?.agentScript ?? defaultAgentScript;
  }

  /** Set the handler for stream messages from the agent. */
  setStreamMessageHandler(handler: StreamMessageHandler): void {
    this.streamMessageHandler = handler;
  }

  /** Set the config to send to the agent when the stream connects. */
  setConfigToSend(config: Record<string, unknown>): void {
    this.configToSend = config;
    // If stream is already connected, send immediately
    if (this.stream !== null && this.stream.isConnected() && this.configToSend !== null) {
      this.stream.send({ type: "config", config: this.configToSend });
    }
  }

  /** Establish a persistent IPC stream connection to the agent. */
  connectStream(): void {
    if (this.stream !== null) return;
    const socketPath = getAgentSocketPath();
    this.stream = createStreamConnection(socketPath);

    this.stream.on("connected", () => {
      console.error("[gateway] IPC stream connected to agent");
      // Push config immediately on connect
      if (this.configToSend !== null) {
        this.stream!.send({ type: "config", config: this.configToSend });
      }
      // Fire registered connected callbacks
      for (const cb of this.streamConnectedCallbacks) {
        try { cb(); } catch { /* ignore callback errors */ }
      }
    });

    this.stream.on("disconnected", () => {
      console.error("[gateway] IPC stream disconnected from agent");
      // Fire registered disconnected callbacks
      for (const cb of this.streamDisconnectedCallbacks) {
        try { cb(); } catch { /* ignore callback errors */ }
      }
    });

    this.stream.on("message", (msg: Record<string, unknown>) => {
      this.handleAgentMessage(msg);
    });
  }

  /** Force-reconnect the stream (e.g. after spawning a new agent). */
  private reconnectStream(): void {
    if (this.stream !== null) {
      this.stream.close();
      this.stream = null;
    }
    this.connectStream();
  }

  /** Handle an incoming message from the agent on the stream. */
  private handleAgentMessage(msg: Record<string, unknown>): void {
    const type = msg["type"] as string | undefined;
    const handler = this.streamMessageHandler;
    if (type === undefined || handler === null) return;

    switch (type) {
      case "tool_call": {
        const id = msg["id"] as string;
        const toolCallRequest: ToolCallRequest = {
          toolName: msg["toolName"] as string,
          sessionId: msg["sessionId"] as string,
          args: (msg["args"] as Record<string, unknown>) ?? {},
        };
        // Await the result to support async tool handlers. Sending the response
        // synchronously when the handler returns a Promise would serialize the
        // Promise object itself, not its resolved value, causing the agent to
        // receive garbage data without any error.
        Promise.resolve(handler.onToolCall?.(toolCallRequest) ?? null)
          .then((toolResult) => {
            this.stream?.send({ type: "response", id, data: toolResult });
          })
          .catch(() => {
            this.stream?.send({ type: "response", id, data: { error: "Tool handler failed" } });
          });
        break;
      }
      case "lifecycle": {
        const id = msg["id"] as string;
        const lifecycleRequest: LifecycleRequest = {
          event: msg["event"] as "idle" | "error",
          sessionId: msg["sessionId"] as string,
          elapsedMs: (msg["elapsedMs"] as number) ?? 0,
          error: typeof msg["error"] === "string" ? msg["error"] : undefined,
        };
        const response = handler.onLifecycle?.(lifecycleRequest) ?? { action: "stop" };
        this.stream?.send({ type: "response", id, data: response });
        break;
      }
      case "hook": {
        const id = msg["id"] as string;
        const hookRequest: HookRequest = {
          hookName: msg["hookName"] as string,
          sessionId: msg["sessionId"] as string,
          copilotSessionId: msg["copilotSessionId"] as string | undefined,
          input: (msg["input"] as Record<string, unknown>) ?? {},
        };
        const result = handler.onHook?.(hookRequest) ?? null;
        this.stream?.send({ type: "response", id, data: result });
        break;
      }
      case "channel_message": {
        const sessionId = msg["sessionId"] as string;
        const sender = msg["sender"] as string;
        const message = msg["message"] as string;
        handler.onChannelMessage?.(sessionId, sender, message);
        break;
      }
      case "session_event": {
        const sessionId = msg["sessionId"] as string;
        const copilotSessionId = typeof msg["copilotSessionId"] === "string" ? msg["copilotSessionId"] as string : undefined;
        const eventType = (msg["eventType"] as string) ?? "unknown";
        const timestamp = (msg["timestamp"] as string) ?? new Date().toISOString();
        const data = (typeof msg["data"] === "object" && msg["data"] !== null ? msg["data"] : {}) as Record<string, unknown>;
        const parentId = typeof msg["parentId"] === "string" ? msg["parentId"] as string : undefined;
        handler.onSessionEvent?.(sessionId, copilotSessionId, eventType, timestamp, data, parentId);
        break;
      }
      case "system_prompt_original": {
        const model = msg["model"] as string;
        const prompt = msg["prompt"] as string;
        const capturedAt = (msg["capturedAt"] as string) ?? new Date().toISOString();
        handler.onSystemPromptOriginal?.(model, prompt, capturedAt);
        break;
      }
      case "system_prompt_session": { // IPC type retained for compatibility; internally this is the "effective system prompt"
        const sessionId = msg["sessionId"] as string;
        const model = msg["model"] as string;
        const prompt = msg["prompt"] as string;
        handler.onSystemPromptSession?.(sessionId, model, prompt);
        break;
      }
      case "drain_pending": {
        const sessionId = msg["sessionId"] as string;
        const id = msg["id"] as string;
        const data = handler.onDrainPending?.(sessionId) ?? [];
        this.stream?.send({ type: "response", id, data });
        break;
      }
      case "peek_pending": {
        const sessionId = msg["sessionId"] as string;
        const id = msg["id"] as string;
        const data = handler.onPeekPending?.(sessionId) ?? null;
        this.stream?.send({ type: "response", id, data });
        break;
      }
      case "flush_pending": {
        const sessionId = msg["sessionId"] as string;
        const id = msg["id"] as string;
        const flushed = handler.onFlushPending?.(sessionId) ?? 0;
        this.stream?.send({ type: "response", id, data: { flushed } });
        break;
      }
      case "list_messages": {
        const sessionId = msg["sessionId"] as string;
        const id = msg["id"] as string;
        const limit = typeof msg["limit"] === "number" ? msg["limit"] as number : 5;
        const data = handler.onListMessages?.(sessionId, limit) ?? [];
        this.stream?.send({ type: "response", id, data });
        break;
      }
      case "running_sessions": {
        const sessions = (msg["sessions"] as RunningSessionReport[]) ?? [];
        handler.onRunningSessionsReport?.(sessions);
        break;
      }
      case "physical_session_started": {
        const sessionId = msg["sessionId"] as string;
        const copilotSessionId = msg["copilotSessionId"] as string;
        const model = msg["model"] as string;
        handler.onPhysicalSessionStarted?.(sessionId, copilotSessionId, model);
        break;
      }
      case "physical_session_ended": {
        const sessionId = msg["sessionId"] as string;
        const reason = msg["reason"] as "idle" | "error" | "aborted";
        const copilotSessionId = msg["copilotSessionId"] as string;
        const elapsedMs = msg["elapsedMs"] as number;
        const error = typeof msg["error"] === "string" ? msg["error"] as string : undefined;
        handler.onPhysicalSessionEnded?.(sessionId, reason, copilotSessionId, elapsedMs, error);
        break;
      }
      default:
        // Unknown message type — ignore
        break;
    }
  }

  /** Send a generic agent_notify to the agent via the stream.
   *  Used for all notification types: pending messages, subagent completion, etc.
   *  Agent side listens for this single event type and drains pending queue. */
  notifyAgent(sessionId: string): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    this.stream.send({ type: "agent_notify", sessionId });
  }

  /** Send a start_physical_session command to the agent via the stream. */
  startPhysicalSession(sessionId: string, copilotSessionId?: string, model?: string): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    const msg: Record<string, unknown> = { type: "start_physical_session", sessionId };
    if (copilotSessionId !== undefined) msg["copilotSessionId"] = copilotSessionId;
    if (model !== undefined) msg["model"] = model;
    this.stream.send(msg);
  }

  /** Send a stop_physical_session command to the agent via the stream. */
  stopPhysicalSession(sessionId: string): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    this.stream.send({ type: "stop_physical_session", sessionId });
  }

  /** Send a disconnect_physical_session command (end-turn-run: disconnect but keep CLI alive for resume). */
  disconnectPhysicalSession(sessionId: string): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    this.stream.send({ type: "disconnect_physical_session", sessionId });
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
            this.reconnectStream();
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
      this.reconnectStream();
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
        // COPILOTCLAW_GATEWAY_URL is no longer set — agent uses IPC stream for all communication
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

  /** Register a callback to be called when the stream connects. */
  onStreamConnected(callback: () => void): void {
    this.streamConnectedCallbacks.push(callback);
  }

  /** Register a callback to be called when the stream disconnects. */
  onStreamDisconnected(callback: () => void): void {
    this.streamDisconnectedCallbacks.push(callback);
  }

  /** Close the stream connection (for shutdown). */
  closeStream(): void {
    if (this.stream !== null) {
      this.stream.close();
      this.stream = null;
    }
  }
}
