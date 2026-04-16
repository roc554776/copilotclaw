import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentStatusResponse, type IpcStream, createStreamConnection, getAgentModels, getAgentQuota, getAgentSessionMessages, getAgentStatus, stopAgent } from "./ipc-client.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { getDataDir } from "./workspace.js";
import type { AgentToGatewayEvent, GatewayToAgentEvent } from "./ipc-types.js";

export const MIN_AGENT_VERSION = "0.83.0";

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
  onSessionEvent?: (sessionId: string, copilotSessionId: string | undefined, type: string, timestamp: string, data: Record<string, unknown>) => void;
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
      const msg: GatewayToAgentEvent = { type: "config", config: this.configToSend };
      this.stream.send(msg as Record<string, unknown>);
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
        const configMsg: GatewayToAgentEvent = { type: "config", config: this.configToSend };
        this.stream!.send(configMsg as Record<string, unknown>);
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

  /** Send message_acknowledged IPC to agent if the message was buffered (has _queueId).
   *  This lets the agent remove the message from its persistent disk queue. */
  private sendAckIfQueued(msg: AgentToGatewayEvent): void {
    const queueId = "_queueId" in msg ? (msg as Record<string, unknown>)["_queueId"] : undefined;
    if (typeof queueId === "string" && this.stream !== null && this.stream.isConnected()) {
      const ack: GatewayToAgentEvent = { type: "message_acknowledged", queueId };
      this.stream.send(ack as Record<string, unknown>);
    }
  }

  /** Handle an incoming message from the agent on the stream. */
  private handleAgentMessage(rawMsg: Record<string, unknown>): void {
    const type = rawMsg["type"] as string | undefined;
    const handler = this.streamMessageHandler;
    if (type === undefined || handler === null) return;

    // Cast to typed union for structured access in event cases below.
    const msg = rawMsg as AgentToGatewayEvent;

    switch (type) {
      case "tool_call": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "tool_call" }>;
        const toolCallRequest: ToolCallRequest = {
          toolName: m.toolName,
          sessionId: m.sessionId,
          args: m.args ?? {},
        };
        // Await the result to support async tool handlers. Sending the response
        // synchronously when the handler returns a Promise would serialize the
        // Promise object itself, not its resolved value, causing the agent to
        // receive garbage data without any error.
        Promise.resolve(handler.onToolCall?.(toolCallRequest) ?? null)
          .then((toolResult) => {
            this.stream?.send({ type: "response", id: m.id, data: toolResult });
          })
          .catch(() => {
            this.stream?.send({ type: "response", id: m.id, data: { error: "Tool handler failed" } });
          });
        break;
      }
      case "lifecycle": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "lifecycle" }>;
        const lifecycleRequest: LifecycleRequest = {
          event: m.event,
          sessionId: m.sessionId,
          elapsedMs: m.elapsedMs ?? 0,
          error: m.error,
        };
        const response = handler.onLifecycle?.(lifecycleRequest) ?? { action: "stop" };
        this.stream?.send({ type: "response", id: m.id, data: response });
        break;
      }
      case "hook": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "hook" }>;
        const hookRequest: HookRequest = {
          hookName: m.hookName,
          sessionId: m.sessionId,
          copilotSessionId: m.copilotSessionId,
          input: m.input ?? {},
        };
        const result = handler.onHook?.(hookRequest) ?? null;
        this.stream?.send({ type: "response", id: m.id, data: result });
        break;
      }
      case "channel_message": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "channel_message" }>;
        handler.onChannelMessage?.(m.sessionId, m.sender, m.message);
        this.sendAckIfQueued(m);
        break;
      }
      case "session_event": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "session_event" }>;
        const eventType = m.eventType ?? "unknown";
        const timestamp = m.timestamp ?? new Date().toISOString();
        const data = (typeof m.data === "object" && m.data !== null ? m.data : {}) as Record<string, unknown>;
        handler.onSessionEvent?.(m.sessionId, m.copilotSessionId, eventType, timestamp, data);
        this.sendAckIfQueued(m);
        break;
      }
      case "system_prompt_original": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "system_prompt_original" }>;
        const capturedAt = m.capturedAt ?? new Date().toISOString();
        handler.onSystemPromptOriginal?.(m.model, m.prompt, capturedAt);
        this.sendAckIfQueued(m);
        break;
      }
      case "system_prompt_session": { // IPC type retained for compatibility; internally this is the "effective system prompt"
        const m = msg as Extract<AgentToGatewayEvent, { type: "system_prompt_session" }>;
        handler.onSystemPromptSession?.(m.sessionId, m.model, m.prompt);
        this.sendAckIfQueued(m);
        break;
      }
      case "drain_pending": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "drain_pending" }>;
        const data = handler.onDrainPending?.(m.sessionId) ?? [];
        this.stream?.send({ type: "response", id: m.id, data });
        break;
      }
      case "peek_pending": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "peek_pending" }>;
        const data = handler.onPeekPending?.(m.sessionId) ?? null;
        this.stream?.send({ type: "response", id: m.id, data });
        break;
      }
      case "flush_pending": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "flush_pending" }>;
        const flushed = handler.onFlushPending?.(m.sessionId) ?? 0;
        this.stream?.send({ type: "response", id: m.id, data: { flushed } });
        break;
      }
      case "list_messages": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "list_messages" }>;
        const limit = typeof m.limit === "number" ? m.limit : 5;
        const data = handler.onListMessages?.(m.sessionId, limit) ?? [];
        this.stream?.send({ type: "response", id: m.id, data });
        break;
      }
      case "running_sessions": {
        // Legacy self-initiated report (pre-v0.83.0 agent compatibility).
        // v0.83.0+ agents respond to request_running_sessions with running_sessions_report instead.
        const m = msg as Extract<AgentToGatewayEvent, { type: "running_sessions" }>;
        const sessions = m.sessions ?? [];
        handler.onRunningSessionsReport?.(sessions);
        this.sendAckIfQueued(m);
        break;
      }
      case "running_sessions_report": {
        // Item F (v0.83.0): response to gateway's request_running_sessions.
        const m = msg as Extract<AgentToGatewayEvent, { type: "running_sessions_report" }>;
        const physicalSessionIds = m.physicalSessionIds ?? [];
        handler.onRunningSessionsReport?.(physicalSessionIds.map((id) => ({ sessionId: id, status: "running" })));
        break;
      }
      case "physical_session_started": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "physical_session_started" }>;
        handler.onPhysicalSessionStarted?.(m.sessionId, m.copilotSessionId, m.model);
        this.sendAckIfQueued(m);
        break;
      }
      case "physical_session_ended": {
        const m = msg as Extract<AgentToGatewayEvent, { type: "physical_session_ended" }>;
        const error = typeof m.error === "string" ? m.error : undefined;
        handler.onPhysicalSessionEnded?.(m.sessionId, m.reason, m.copilotSessionId, m.elapsedMs, error);
        this.sendAckIfQueued(m);
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
    const msg: GatewayToAgentEvent = { type: "agent_notify", sessionId };
    this.stream.send(msg as Record<string, unknown>);
  }

  /** Send a start_physical_session command to the agent via the stream. */
  startPhysicalSession(sessionId: string, physicalSessionId?: string, model?: string): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    const msg: GatewayToAgentEvent = { type: "start_physical_session", sessionId, physicalSessionId, model };
    this.stream.send(msg as Record<string, unknown>);
  }

  /** Send a stop_physical_session command to the agent via the stream. */
  stopPhysicalSession(sessionId: string): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    const msg: GatewayToAgentEvent = { type: "stop_physical_session", sessionId };
    this.stream.send(msg as Record<string, unknown>);
  }

  /** Send a disconnect_physical_session command (end-turn-run: disconnect but keep CLI alive for resume). */
  disconnectPhysicalSession(sessionId: string): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    const msg: GatewayToAgentEvent = { type: "disconnect_physical_session", sessionId };
    this.stream.send(msg as Record<string, unknown>);
  }

  /**
   * Send request_running_sessions to the agent (Item F, v0.83.0).
   * Initiates the reconcile coordinator request-response protocol.
   * The agent responds with running_sessions_report listing all non-suspended physical session IDs.
   */
  requestRunningSessions(): void {
    if (this.stream === null || !this.stream.isConnected()) return;
    const msg: GatewayToAgentEvent = { type: "request_running_sessions" };
    this.stream.send(msg as Record<string, unknown>);
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
