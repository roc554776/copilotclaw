import { randomUUID } from "node:crypto";
import { CopilotClient, type CopilotSession, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { createChannelTools } from "./tools/channel.js";

export type AgentSessionStatus = "starting" | "waiting" | "processing" | "stopped";

export interface PhysicalSessionSummary {
  sessionId: string;
  model: string;
  startedAt: string;
  currentState: string;
}

export interface SubagentInfo {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
}

export interface AgentSessionInfo {
  status: AgentSessionStatus;
  startedAt: string;
  processingStartedAt?: string;
  boundChannelId?: string;
  physicalSession?: PhysicalSessionSummary;
  subagentSessions?: SubagentInfo[];
}

interface AgentSessionEntry {
  sessionId: string;
  copilotSessionId?: string; // SDK session ID for resumeSession
  copilotSession?: CopilotSession; // Live SDK session for getMessages()
  info: AgentSessionInfo;
  client: CopilotClient;
  abortController: AbortController;
  sessionPromise: Promise<void>;
  generation: number;
}

export interface AgentSessionManagerOptions {
  gatewayBaseUrl: string;
  staleTimeoutMs?: number;
  maxSessionAgeMs?: number;
  fetch?: typeof globalThis.fetch;
  model?: string;
  zeroPremium?: boolean;
  debugMockCopilotUnsafeTools?: boolean;
  workingDirectory?: string;
}

export interface StartSessionOptions {
  boundChannelId?: string;
  /** SDK session ID to resume instead of creating a new one. Used by deferred resume. */
  copilotSessionId?: string;
}

const DEFAULT_STALE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSION_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSessionEntry>();
  private readonly channelBindings = new Map<string, string>(); // channelId → sessionId
  private readonly restartCounts = new Map<string, number>(); // channelId → count (persists across session restarts)
  private readonly savedCopilotSessionIds = new Map<string, string>(); // channelId → SDK session ID (for deferred resume)
  private readonly gatewayBaseUrl: string;
  private readonly staleTimeoutMs: number;
  private readonly maxSessionAgeMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly model: string | undefined;
  private readonly zeroPremium: boolean;
  private readonly debugMockCopilotUnsafeTools: boolean;
  private readonly workingDirectory: string | undefined;
  private generationCounter = 0;

  constructor(options: AgentSessionManagerOptions) {
    this.gatewayBaseUrl = options.gatewayBaseUrl;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.maxSessionAgeMs = options.maxSessionAgeMs ?? DEFAULT_MAX_SESSION_AGE_MS;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.model = options.model;
    this.zeroPremium = options.zeroPremium ?? false;
    this.debugMockCopilotUnsafeTools = options.debugMockCopilotUnsafeTools ?? false;
    this.workingDirectory = options.workingDirectory;
  }

  /** Get the first active CopilotClient (for server-level RPCs like quota/models). */
  private getActiveClient(): CopilotClient | undefined {
    for (const [, entry] of this.sessions) {
      return entry.client;
    }
    return undefined;
  }

  async getQuota(): Promise<Record<string, unknown> | null> {
    const client = this.getActiveClient();
    if (client === undefined) return null;
    try {
      return await client.rpc.account.getQuota() as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async getModels(): Promise<Record<string, unknown> | null> {
    const client = this.getActiveClient();
    if (client === undefined) return null;
    try {
      return await client.rpc.models.list() as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Get session messages (conversation history) from the SDK for a given copilot session ID. */
  async getSessionMessages(copilotSessionId: string): Promise<unknown[] | null> {
    for (const [, entry] of this.sessions) {
      if (entry.copilotSessionId === copilotSessionId && entry.copilotSession !== undefined) {
        try {
          return await entry.copilotSession.getMessages();
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  getSessionStatuses(): Record<string, AgentSessionInfo> {
    const result: Record<string, AgentSessionInfo> = {};
    for (const [sessionId, entry] of this.sessions) {
      result[sessionId] = { ...entry.info };
    }
    return result;
  }

  getSessionStatus(sessionId: string): AgentSessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return undefined;
    return { ...entry.info };
  }

  hasSessionForChannel(channelId: string): boolean {
    return this.channelBindings.has(channelId);
  }

  startSession(options?: StartSessionOptions): string {
    const boundChannelId = options?.boundChannelId;

    // Prevent duplicate session for same channel
    if (boundChannelId !== undefined && this.channelBindings.has(boundChannelId)) {
      return this.channelBindings.get(boundChannelId)!;
    }

    const sessionId = randomUUID();
    const abortController = new AbortController();
    const client = new CopilotClient();
    const generation = ++this.generationCounter;
    const entry: AgentSessionEntry = {
      sessionId,
      info: {
        status: "starting",
        startedAt: new Date().toISOString(),
      },
      client,
      abortController,
      sessionPromise: Promise.resolve(),
      generation,
    };

    if (boundChannelId !== undefined) {
      entry.info.boundChannelId = boundChannelId;
      this.channelBindings.set(boundChannelId, sessionId);
    }

    // Propagate SDK session ID for resume before runSession reads it
    if (options?.copilotSessionId !== undefined) {
      entry.copilotSessionId = options.copilotSessionId;
    }

    const promise = this.runSession(entry).then(() => {
      // Session ended normally (idle) — this is unexpected, mark as stopped
      if (!entry.abortController.signal.aborted) {
        entry.info.status = "stopped";
        this.notifyChannelSessionStopped(boundChannelId);
      }
    }).catch((err: unknown) => {
      console.error(`[agent] session ${sessionId.slice(0, 8)} error:`, err);
      if (!entry.abortController.signal.aborted) {
        entry.info.status = "stopped";
        this.notifyChannelSessionStopped(boundChannelId);
      }
    }).finally(() => {
      // Only delete if this is still the current generation
      const current = this.sessions.get(sessionId);
      if (current !== undefined && current.generation === generation) {
        this.sessions.delete(sessionId);
        if (boundChannelId !== undefined) {
          // Only unbind if still bound to this session
          if (this.channelBindings.get(boundChannelId) === sessionId) {
            this.channelBindings.delete(boundChannelId);
            this.restartCounts.delete(boundChannelId);
          }
        }
      }
      client.stop().catch(() => {});
    });

    entry.sessionPromise = promise;
    this.sessions.set(sessionId, entry);
    return sessionId;
  }

  private async runSession(entry: AgentSessionEntry): Promise<void> {
    const channelId = entry.info.boundChannelId;
    if (channelId === undefined) {
      throw new Error("channel-less sessions not yet supported");
    }

    const { sendMessage, receiveInput, listMessages } = createChannelTools({
      gatewayBaseUrl: this.gatewayBaseUrl,
      channelId,
      abortSignal: entry.abortController.signal,
      fetch: this.fetchFn,
      onStatusChange: (status) => {
        entry.info.status = status;
        if (status === "processing") {
          entry.info.processingStartedAt = new Date().toISOString();
        }
      },
    });

    const gatewayBaseUrl = this.gatewayBaseUrl;
    const signal = entry.abortController.signal;

    const sessionConfig = {
      onPermissionRequest: approveAll,
      tools: [sendMessage, receiveInput, listMessages],
      hooks: {
        onPostToolUse: async () => {
          try {
            if (signal.aborted) return;
            const fetchOpts: RequestInit = { signal };
            const res = await this.fetchFn(`${gatewayBaseUrl}/api/channels/${channelId}/messages/pending/peek`, fetchOpts);
            if (res.status === 200) {
              return {
                additionalContext: `[NOTIFICATION] New user message is available on the channel. Call copilotclaw_receive_input immediately to read it.`,
              };
            }
          } catch {
            // Ignore errors (e.g. aborted)
          }
          return;
        },
      },
      // Debug mock copilot unsafe tools mode: restrict to safe built-in tools + copilotclaw_* + debug debug mock copilot unsafe tools
      ...(this.debugMockCopilotUnsafeTools ? {
        availableTools: [
          "copilotclaw_send_message",
          "copilotclaw_receive_input",
          "copilotclaw_list_messages",
          "copilotclaw_debug_mock_read_file",
          "copilotclaw_debug_mock_write_file",
          "copilotclaw_debug_mock_shell_exec",
          "WebFetch",
          "WebSearch",
        ],
      } : {}),
    };

    // Resolve model dynamically from SDK model list
    const resolvedModel = await this.resolveModel(entry.client);

    // Resume existing SDK session or create new one
    const baseConfig = {
      model: resolvedModel,
      ...(this.workingDirectory !== undefined ? { workingDirectory: this.workingDirectory } : {}),
      ...sessionConfig,
    };
    const session = entry.copilotSessionId !== undefined
      ? await entry.client.resumeSession(entry.copilotSessionId, baseConfig)
      : await entry.client.createSession(baseConfig);

    entry.copilotSessionId = session.sessionId;
    entry.copilotSession = session;
    entry.info.status = "waiting";

    // Track physical session state
    entry.info.physicalSession = {
      sessionId: session.sessionId,
      model: resolvedModel,
      startedAt: new Date().toISOString(),
      currentState: "idle",
    };
    entry.info.subagentSessions = [];

    // Subscribe to SDK events for state tracking
    session.on("tool.execution_start", (event) => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.currentState = `tool:${event.data.toolName}`;
      }
    });
    session.on("tool.execution_complete", () => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.currentState = "idle";
      }
    });
    session.on("session.idle", () => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.currentState = "idle";
      }
    });
    session.on("subagent.started", (event) => {
      const subs = entry.info.subagentSessions;
      if (subs !== undefined) {
        subs.push({
          toolCallId: event.data.toolCallId,
          agentName: event.data.agentName,
          agentDisplayName: event.data.agentDisplayName,
          status: "running",
          startedAt: event.timestamp,
        });
        // Keep only the last 50 entries to prevent unbounded growth
        if (subs.length > 50) {
          subs.splice(0, subs.length - 50);
        }
      }
    });
    session.on("subagent.completed", (event) => {
      const sub = entry.info.subagentSessions?.find((s) => s.toolCallId === event.data.toolCallId);
      if (sub !== undefined) sub.status = "completed";
    });
    session.on("subagent.failed", (event) => {
      const sub = entry.info.subagentSessions?.find((s) => s.toolCallId === event.data.toolCallId);
      if (sub !== undefined) sub.status = "failed";
    });
    session.on("session.model_change", (event) => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.model = event.data.newModel;
      }
    });

    const logPrefix = channelId.slice(0, 8);
    await runSessionLoop({
      session: adaptCopilotSession(session),
      initialPrompt:
        "You are a copilotclaw agent bound to a channel. " +
        "Call copilotclaw_receive_input now to receive the first user message. " +
        "After processing input, use copilotclaw_send_message to send your response, then call copilotclaw_receive_input again to wait for the next input. " +
        "You may receive notifications about new user message via additionalContext in tool responses — when notified, call copilotclaw_receive_input immediately. " +
        "Never stop without calling copilotclaw_receive_input.",
      onMessage: (content) => { console.log(`[ch:${logPrefix}] ${content}`); },
      log: (message) => { console.error(`[agent:${logPrefix}] ${message}`); },
      shouldStop: () => entry.abortController.signal.aborted,
    });
  }

  /** Resolve which model to use for session creation.
   * Queries available models via SDK and selects based on config:
   * - zeroPremium: picks cheapest non-premium model (billing.multiplier === 0)
   * - model unset: picks model with lowest billing.multiplier
   * - model set: uses that model (zeroPremium may override if it's premium) */
  private async resolveModel(client: CopilotClient): Promise<string> {
    try {
      const { models } = await client.rpc.models.list();
      if (models.length === 0) {
        console.error("[agent] no models available from SDK, falling back to gpt-4.1");
        return this.model ?? "gpt-4.1";
      }

      // Sort by billing multiplier (ascending — cheapest first)
      const sorted = [...models].sort((a, b) =>
        (a.billing?.multiplier ?? Infinity) - (b.billing?.multiplier ?? Infinity),
      );
      const nonPremium = sorted.filter((m) => m.billing?.multiplier === 0);

      if (this.zeroPremium) {
        if (nonPremium.length === 0) {
          console.error("[agent] zeroPremium: no non-premium models available");
          throw new Error("zeroPremium is enabled but no non-premium models are available");
        }
        if (this.model !== undefined) {
          const modelInfo = models.find((m) => m.id === this.model);
          if (modelInfo !== undefined && modelInfo.billing?.multiplier !== 0) {
            console.error(`[agent] zeroPremium: overriding premium model ${this.model} → ${nonPremium[0]!.id}`);
            return nonPremium[0]!.id;
          }
          return this.model;
        }
        return nonPremium[0]!.id;
      }

      if (this.model !== undefined) return this.model;

      // No model specified: pick the one with lowest premium cost
      return sorted[0]!.id;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("zeroPremium")) throw err;
      console.error("[agent] failed to list models from SDK, falling back to gpt-4.1:", err);
      return this.model ?? "gpt-4.1";
    }
  }

  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.abortController.abort();
  }

  stopSessionForChannel(channelId: string): void {
    const sessionId = this.channelBindings.get(channelId);
    if (sessionId !== undefined) {
      this.stopSession(sessionId);
    }
  }

  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, entry] of this.sessions) {
      entry.abortController.abort();
      promises.push(entry.sessionPromise);
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => { timeoutHandle = setTimeout(r, 5000); });
    await Promise.race([
      Promise.allSettled(promises).finally(() => { clearTimeout(timeoutHandle); }),
      timeout,
    ]);
  }

  async checkStaleAndHandle(sessionId: string, oldestInputId: string | undefined): Promise<"ok" | "flushed"> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return "ok";
    if (entry.info.status !== "processing") return "ok";

    const processingStartedAt = entry.info.processingStartedAt;
    if (processingStartedAt === undefined) return "ok";

    const elapsed = Date.now() - new Date(processingStartedAt).getTime();
    if (elapsed < this.staleTimeoutMs) return "ok";

    // Don't act if there are no pending inputs (agent may be legitimately finishing)
    if (oldestInputId === undefined) return "ok";

    const boundChannelId = entry.info.boundChannelId;
    const countKey = boundChannelId ?? sessionId;

    // Stale session — save state for deferred resume, stop, notify, flush stale inputs
    console.error(`[agent] session ${sessionId.slice(0, 8)} stale processing (${Math.round(elapsed / 1000)}s), saving state and stopping (deferred resume)`);

    // Save copilotSessionId for deferred resume on next genuinely new pending message
    if (entry.copilotSessionId !== undefined && boundChannelId !== undefined) {
      this.savedCopilotSessionIds.set(boundChannelId, entry.copilotSessionId);
    }

    this.notifyChannelSessionTimedOut(boundChannelId);
    this.stopSession(sessionId);
    this.restartCounts.delete(countKey);
    // Return "flushed" so the caller flushes stale inputs; the deferred resume will only
    // fire when a genuinely new user message arrives after the flush.
    return "flushed";
  }

  private notifyChannelSessionStopped(channelId: string | undefined): void {
    if (channelId === undefined) return;
    const message = "[SYSTEM] Agent session stopped unexpectedly. A new session will start when you send a message.";
    this.postChannelMessage(channelId, message);
  }

  private notifyChannelSessionTimedOut(channelId: string | undefined): void {
    if (channelId === undefined) return;
    const message = "[SYSTEM] Agent session timed out (stuck processing). A new session will start when you send a message.";
    this.postChannelMessage(channelId, message);
  }

  private postChannelMessage(channelId: string, message: string): void {
    this.fetchFn(`${this.gatewayBaseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "agent", message }),
    }).catch((err: unknown) => {
      console.error(`[agent] failed to notify channel ${channelId}:`, err);
    });
  }

  /** Check if session has exceeded max age. If so, save state and stop (deferred resume).
   * The session will be resumed when the next pending message arrives for the channel.
   * Only applies to sessions in "waiting" state with a bound channel. */
  checkSessionMaxAge(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return false;
    if (entry.info.status !== "waiting") return false;
    if (entry.info.boundChannelId === undefined) return false;

    const age = Date.now() - new Date(entry.info.startedAt).getTime();
    if (age < this.maxSessionAgeMs) return false;

    const boundChannelId = entry.info.boundChannelId;

    console.error(`[agent] session ${sessionId.slice(0, 8)} exceeded max age (${Math.round(age / 3600000)}h), saving state and stopping (deferred resume)`);

    // Save copilotSessionId for deferred resume
    if (entry.copilotSessionId !== undefined) {
      this.savedCopilotSessionIds.set(boundChannelId, entry.copilotSessionId);
    }

    // Stop session — no immediate restart (deferred resume on next pending)
    this.stopSession(sessionId);

    return true;
  }

  /** Get the sessionId bound to a channel, if any */
  getSessionIdForChannel(channelId: string): string | undefined {
    return this.channelBindings.get(channelId);
  }

  /** Get the boundChannelId for a session, if any */
  getBoundChannelId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.info.boundChannelId;
  }

  /** Check if a channel has a saved copilotSessionId for deferred resume */
  hasSavedSession(channelId: string): boolean {
    return this.savedCopilotSessionIds.has(channelId);
  }

  /** Consume the saved copilotSessionId for a channel (returns and removes it) */
  consumeSavedSession(channelId: string): string | undefined {
    const id = this.savedCopilotSessionIds.get(channelId);
    if (id !== undefined) {
      this.savedCopilotSessionIds.delete(channelId);
    }
    return id;
  }
}
