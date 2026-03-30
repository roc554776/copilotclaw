import { CopilotClient, type CopilotSession, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { requestFromGateway, sendToGateway } from "./ipc-server.js";
import { createChannelTools } from "./tools/channel.js";

// onPostToolUse hook fires only for the parent agent (channel-operator) tool calls.
// Subagent tool calls do NOT trigger the hook — confirmed via debug logging (v0.39.0).
// The CLI sends hooks.invoke RPC only for parent agent tools; the SDK itself has no
// parent/subagent distinction (it would handle hooks for either if the CLI sent them).
// Therefore, no toolName gating is needed for subagent exclusion.

// Agent prompt and session config are now owned by gateway (agent-config.ts)
// and pushed via IPC. No fallback defaults here — gateway always sends them.

export type AgentSessionStatus = "starting" | "waiting" | "processing" | "suspended" | "stopped";

export interface AgentSessionInfo {
  status: AgentSessionStatus;
  startedAt: string;
  processingStartedAt?: string | undefined;
  boundChannelId?: string | undefined;
}

interface AgentSessionEntry {
  sessionId: string;
  copilotSessionId?: string | undefined; // SDK session ID for resumeSession
  copilotSession?: CopilotSession | undefined; // Live SDK session for getMessages()
  resolvedModel?: string | undefined; // Model resolved by gateway
  info: AgentSessionInfo;
  client: CopilotClient;
  abortController: AbortController;
  sessionPromise: Promise<void>;
  generation: number;
}

export interface AgentSessionManagerOptions {
  model?: string;
  zeroPremium?: boolean;
  debugMockCopilotUnsafeTools?: boolean;
  workingDirectory?: string;
  /** GitHub token for authentication (from profile auth config). When set, passed to CopilotClient. */
  githubToken?: string;
  /** Log level: "info" (default) or "debug" (enables verbose hook/internal logging). */
  debugLogLevel?: "info" | "debug";
  /** Prompt and session config pushed from gateway. */
  prompts: {
    channelOperator: { name: string; displayName: string; description: string; prompt: string; infer: boolean };
    worker: { name: string; displayName: string; description: string; prompt: string; infer: boolean };
    systemReminder: string;
    initialPrompt: string;
    staleTimeoutMs: number;
    maxSessionAgeMs: number;
    rapidFailureThresholdMs: number;
    backoffDurationMs: number;
    keepaliveTimeoutMs?: number;
    reminderThresholdPercent?: number;
  };
  /** Structured log function (info level). Falls back to structured JSON on console.error. */
  log?: (message: string) => void;
  /** Structured log function (error level). Falls back to structured JSON on console.error. */
  logError?: (message: string) => void;
}

export interface StartSessionOptions {
  /** Session ID assigned by the gateway orchestrator. Agent MUST use this ID (not generate its own)
   *  so that physical_session_started/ended messages reference the correct orchestrator session. */
  sessionId: string;
  boundChannelId?: string;
  /** SDK session ID to resume instead of creating a new one. Used by deferred resume. */
  copilotSessionId?: string;
  /** Resolved model name from gateway. When set, agent uses this model directly
   *  instead of running its own model selection algorithm. */
  resolvedModel?: string;
}

// Session timing values are owned by gateway (agent-config.ts) and pushed via IPC.

export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSessionEntry>();
  private readonly model: string | undefined;
  private readonly zeroPremium: boolean;
  private readonly debugMockCopilotUnsafeTools: boolean;
  private readonly workingDirectory: string | undefined;
  private readonly githubToken: string | undefined;
  private readonly debugLogLevel: "info" | "debug";
  private readonly channelOperatorConfig: { name: string; displayName: string; description: string; prompt: string; infer: boolean };
  private readonly workerConfig: { name: string; displayName: string; description: string; prompt: string; infer: boolean };
  private readonly systemReminder: string;
  private readonly initialPrompt: string;
  private readonly keepaliveTimeoutMs: number;
  private readonly reminderThresholdPercent: number;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string) => void;
  private readonly debug: (message: string) => void;
  private generationCounter = 0;

  constructor(options: AgentSessionManagerOptions) {
    this.model = options.model;
    this.zeroPremium = options.zeroPremium ?? false;
    this.debugMockCopilotUnsafeTools = options.debugMockCopilotUnsafeTools ?? false;
    this.workingDirectory = options.workingDirectory;
    this.githubToken = options.githubToken;
    const defaultLog = (message: string) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "info", component: "agent", msg: message }));
    };
    const defaultLogError = (message: string) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", component: "agent", msg: message }));
    };
    this.debugLogLevel = options.debugLogLevel ?? "info";
    this.channelOperatorConfig = options.prompts.channelOperator;
    this.workerConfig = options.prompts.worker;
    this.systemReminder = options.prompts.systemReminder;
    this.initialPrompt = options.prompts.initialPrompt;
    this.keepaliveTimeoutMs = options.prompts.keepaliveTimeoutMs ?? 25 * 60 * 1000;
    this.reminderThresholdPercent = options.prompts.reminderThresholdPercent ?? 0.10;
    this.log = options.log ?? defaultLog;
    this.logError = options.logError ?? defaultLogError;
    this.debug = this.debugLogLevel === "debug"
      ? (options.log ?? defaultLog)
      : () => {};
  }

  /** Create a CopilotClient with the configured auth token (if any). */
  private createClient(): CopilotClient {
    if (this.githubToken !== undefined) {
      return new CopilotClient({ githubToken: this.githubToken });
    }
    return new CopilotClient();
  }

  private pooledClient: CopilotClient | undefined;

  /** Get any CopilotClient (for server-level RPCs like quota/models).
   *  Prefers active sessions, falls back to suspended, uses pooled client if none exist. */
  private getAnyClient(): CopilotClient {
    for (const [, entry] of this.sessions) {
      if (entry.info.status !== "suspended") return entry.client;
    }
    for (const [, entry] of this.sessions) {
      return entry.client;
    }
    if (this.pooledClient === undefined) {
      this.pooledClient = this.createClient();
    }
    return this.pooledClient;
  }

  async getQuota(): Promise<Record<string, unknown> | null> {
    try {
      const client = this.getAnyClient();
      return await client.rpc.account.getQuota() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      this.logError(`getQuota error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getModels(): Promise<Record<string, unknown> | null> {
    try {
      const client = this.getAnyClient();
      return await client.rpc.models.list() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      this.logError(`getModels error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Get session messages (conversation history) from the SDK for a given copilot session ID. */
  async getSessionMessages(copilotSessionId: string): Promise<unknown[] | null> {
    for (const [, entry] of this.sessions) {
      if (entry.copilotSessionId === copilotSessionId && entry.copilotSession !== undefined) {
        try {
          return await entry.copilotSession.getMessages();
        } catch (err: unknown) {
          this.logError(`getSessionMessages error: ${err instanceof Error ? err.message : String(err)}`);
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

  /** Return a list of currently running (non-suspended) sessions for stream reconciliation.
   *  Used when gateway reconnects to discover which physical sessions are still alive. */
  getRunningSessionsSummary(): Array<{ sessionId: string; channelId: string; status: string }> {
    const result: Array<{ sessionId: string; channelId: string; status: string }> = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.info.status !== "suspended" && entry.info.boundChannelId !== undefined) {
        result.push({ sessionId, channelId: entry.info.boundChannelId, status: entry.info.status });
      }
    }
    return result;
  }

  getSessionStatus(sessionId: string): AgentSessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return undefined;
    return { ...entry.info };
  }

  startSession(options: StartSessionOptions): string {
    const { sessionId, boundChannelId, copilotSessionId, resolvedModel } = options;

    const abortController = new AbortController();
    const client = this.createClient();
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
    }

    // Propagate SDK session ID for resume before runSession reads it
    if (copilotSessionId !== undefined) {
      entry.copilotSessionId = copilotSessionId;
    }

    // Store resolved model from gateway for use in runSession
    if (resolvedModel !== undefined) {
      entry.resolvedModel = resolvedModel;
    }

    entry.sessionPromise = this.attachSessionLifecycle(entry, client);
    this.sessions.set(sessionId, entry);
    return sessionId;
  }

  private async runSession(entry: AgentSessionEntry): Promise<void> {
    const channelId = entry.info.boundChannelId;
    if (channelId === undefined) {
      throw new Error("channel-less sessions not yet supported");
    }

    const { sendMessage, wait, listMessages } = createChannelTools({
      channelId,
      keepaliveTimeoutMs: this.keepaliveTimeoutMs,
      abortSignal: entry.abortController.signal,
      onStatusChange: (status) => {
        entry.info.status = status;
        if (status === "processing") {
          entry.info.processingStartedAt = new Date().toISOString();
        }
      },
      logError: this.logError,
    });

    const signal = entry.abortController.signal;

    // State for periodic system prompt reinforcement via onPostToolUse additionalContext.
    // Tracks context usage percentage to avoid reminding on every tool call.
    const reminderState = {
      needsReminder: false,
      lastReminderPercent: 0,
      currentUsagePercent: 0,
    };

    const sessionConfig = {
      onPermissionRequest: approveAll,
      tools: [sendMessage, wait, listMessages],
      hooks: {
        onPostToolUse: async (input: { toolName: string }) => {
          try {
            if (signal.aborted) return;

            this.debug(`postToolUse: [${entry.sessionId}] tool=${input.toolName}`);

            const parts: string[] = [];

            // Consume needsReminder synchronously before any await to prevent
            // concurrent hook calls from sending duplicate reminders (TOCTOU).
            const shouldRemind = reminderState.needsReminder;
            if (shouldRemind) {
              reminderState.needsReminder = false;
              reminderState.lastReminderPercent = reminderState.currentUsagePercent;
            }

            // Check for pending user messages via IPC
            try {
              const peekResult = await requestFromGateway({ type: "peek_pending", channelId });
              if (peekResult !== null && peekResult !== undefined) {
                parts.push(`[NOTIFICATION] New user message is available on the channel. Call copilotclaw_wait immediately to read it.`);
              }
            } catch {
              // IPC error — skip notification (non-fatal)
            }

            // Subagent completion notifications are now handled by gateway
            // (inserted as system messages into pending queue + agent_notify push)

            if (shouldRemind) {
              parts.push(this.systemReminder);
            }

            if (parts.length > 0) {
              this.debug(`postToolUse: returning additionalContext (${parts.length} parts, remind=${shouldRemind})`);
              return { additionalContext: parts.join("\n\n") };
            }
          } catch (err: unknown) {
            // AbortError is expected when session is stopped — suppress silently.
            // Log other errors so production issues in the hook are visible.
            if (!(err instanceof Error && err.name === "AbortError")) {
              this.logError(`onPostToolUse hook error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return;
        },
      },
      // Debug mock copilot unsafe tools mode: restrict to safe built-in tools + copilotclaw_* + debug mock tools
      ...(this.debugMockCopilotUnsafeTools ? {
        availableTools: [
          "copilotclaw_send_message",
          "copilotclaw_wait",
          "copilotclaw_list_messages",
          "copilotclaw_debug_mock_read_file",
          "copilotclaw_debug_mock_write_file",
          "copilotclaw_debug_mock_shell_exec",
          "WebFetch",
          "WebSearch",
        ],
      } : {}),
    };

    // Use gateway-resolved model if available, otherwise fall back to local resolution
    const resolvedModel = entry.resolvedModel ?? await this.resolveModel(entry.client);

    // Build systemMessage with transform callbacks to capture original system prompt.
    // Each known section gets a pass-through callback that captures the content and
    // forwards it to the gateway. The SDK's extractTransformCallbacks() detects these
    // callbacks and sends action: "transform" in the wire payload, causing the CLI to
    // call back via systemMessage.transform RPC when the system prompt is constructed.
    const capturedSections: Record<string, string> = {};
    const makeSectionCapture = (sectionId: string) => async (content: string) => {
      capturedSections[sectionId] = content;
      return content; // Return unchanged — pass-through
    };
    const KNOWN_SECTIONS = [
      "identity", "tone", "tool_efficiency", "environment_context",
      "code_change_rules", "guidelines", "safety", "tool_instructions",
      "custom_instructions", "last_instructions",
    ];
    const sections: Record<string, { action: (content: string) => Promise<string> }> = {};
    for (const id of KNOWN_SECTIONS) {
      sections[id] = { action: makeSectionCapture(id) };
    }

    // Resume existing SDK session or create new one
    const baseConfig = {
      model: resolvedModel,
      ...(this.workingDirectory !== undefined ? { workingDirectory: this.workingDirectory } : {}),
      ...sessionConfig,
      systemMessage: {
        mode: "customize" as const,
        sections,
      },
      // Custom agents: channel-operator (parent, infer:false) + worker (subagent, infer:true)
      customAgents: [
        { ...this.channelOperatorConfig, tools: null },
        { ...this.workerConfig, tools: null },
      ],
      agent: this.channelOperatorConfig.name,
    };
    let session: CopilotSession;
    if (entry.copilotSessionId !== undefined) {
      try {
        session = await entry.client.resumeSession(entry.copilotSessionId, baseConfig);
      } catch (resumeErr: unknown) {
        this.log(`resumeSession failed for ${entry.copilotSessionId.slice(0, 12)}, creating new session: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`);
        entry.copilotSessionId = undefined;
        session = await entry.client.createSession(baseConfig);
      }
    } else {
      session = await entry.client.createSession(baseConfig);
    }

    // After session creation, the CLI will call systemMessage.transform RPC for each
    // section that has action: "transform". The callbacks above capture each section's
    // content. Post the combined prompt to the gateway for storage and display.
    const postCapturedPrompt = () => {
      // Original system prompt: custom_instructions content is replaced with an
      // empty tag (the CLI injects workspace files like AGENTS.md into this section,
      // which is not part of the SDK default prompt).
      const originalSections = Object.entries(capturedSections)
        .map(([id, content]) => id === "custom_instructions" ? `<${id}>\n</${id}>` : content)
        .filter(Boolean);
      const original = originalSections.join("\n\n");
      // Effective system prompt includes all sections (what the LLM actually receives).
      const effective = Object.values(capturedSections).filter(Boolean).join("\n\n");
      if (original.length > 0) {
        this.postToGateway({
          type: "system_prompt_original",
          model: resolvedModel,
          prompt: original,
          capturedAt: new Date().toISOString(),
        });
      }
      if (effective.length > 0) {
        this.postToGateway({
          type: "system_prompt_session",
          sessionId: session.sessionId,
          model: resolvedModel,
          prompt: effective,
        });
      }
    };
    // The transform callbacks fire during session.send() when the CLI builds the system
    // prompt. Post once after the first assistant.turn_start to know the prompt has been built.
    // For resumed sessions, the CLI may not re-fire transform RPCs; in that case
    // capturedSections stays empty and postCapturedPrompt is a no-op (acceptable).
    let promptPosted = false;
    session.on("assistant.turn_start", () => {
      if (promptPosted) return;
      promptPosted = true;
      postCapturedPrompt();
    });

    entry.copilotSessionId = session.sessionId;
    entry.copilotSession = session;
    entry.info.status = "waiting";

    // Notify gateway that a physical session has started
    this.postToGateway({
      type: "physical_session_started",
      sessionId: entry.sessionId,
      copilotSessionId: session.sessionId,
      model: resolvedModel,
    });

    // Forward all session events to gateway for observability
    const forwardEvent = (eventType: string, event?: { timestamp?: string; data?: unknown }) => {
      this.postToGateway({
        type: "session_event",
        sessionId: session.sessionId,
        channelId,
        eventType,
        timestamp: event?.timestamp ?? new Date().toISOString(),
        data: (typeof event?.data === "object" && event.data !== null) ? event.data : {},
      });
    };

    // Subscribe to key SDK events and forward them
    const forwardedEvents = [
      "session.idle", "session.error", "session.usage_info", "session.model_change",
      "session.compaction_start", "session.compaction_complete", "session.title_changed",
      "tool.execution_start", "tool.execution_complete",
      "subagent.started", "subagent.completed", "subagent.failed",
      "assistant.message", "assistant.usage", "assistant.turn_start", "assistant.turn_end",
    ];
    for (const eventType of forwardedEvents) {
      session.on(eventType as "session.idle", (event?: { timestamp?: string; data?: unknown }) => {
        forwardEvent(eventType, event);
      });
    }

    // Physical session state tracking (currentState, tokens, subagent) is handled by
    // the gateway's SessionOrchestrator via forwarded session_event messages.
    // Agent only subscribes to events needed for its own operation:

    // Track context usage for periodic system prompt reminder (onPostToolUse).
    session.on("session.usage_info", (event) => {
      const limit = event.data.tokenLimit;
      if (limit > 0) {
        reminderState.currentUsagePercent = event.data.currentTokens / limit;
        if (reminderState.currentUsagePercent >= reminderState.lastReminderPercent + this.reminderThresholdPercent) {
          reminderState.needsReminder = true;
        }
      }
    });
    // After compaction, the LLM may lose critical instructions. Flag an immediate reminder.
    session.on("session.compaction_complete", () => {
      reminderState.needsReminder = true;
      reminderState.lastReminderPercent = 0; // Reset — usage drops after compaction
    });
    // Reflect assistant.message events to the channel timeline as agent messages.
    // This serves as a fallback: ideally the agent uses copilotclaw_send_message,
    // but when the LLM responds with text instead of calling a tool, this ensures
    // the response still reaches the user.
    session.on("assistant.message", (event) => {
      const content = event.data.content;
      if (content.length > 0) {
        this.postChannelMessage(channelId, content);
      }
    });

    const logPrefix = channelId.slice(0, 8);
    await runSessionLoop({
      session: adaptCopilotSession(session),
      // System prompt is in the channel-operator custom agent's prompt field.
      // initialPrompt is the first user-turn message that kicks off the session.
      initialPrompt: this.initialPrompt,
      onMessage: (content) => { console.log(`[ch:${logPrefix}] ${content}`); },
      log: (message) => { this.log(`[${logPrefix}] ${message}`); },
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
      // Ensure the CLI process is started before accessing client.rpc.
      // createSession calls start() automatically via autoStart, but
      // resolveModel runs before createSession to determine the model.
      await client.start();
      const { models } = await client.rpc.models.list();
      if (models.length === 0) {
        this.logError("no models available from SDK, falling back to gpt-4.1");
        return this.model ?? "gpt-4.1";
      }

      // Sort by billing multiplier (ascending — cheapest first)
      const sorted = [...models].sort((a, b) =>
        (a.billing?.multiplier ?? Infinity) - (b.billing?.multiplier ?? Infinity),
      );
      const nonPremium = sorted.filter((m) => m.billing?.multiplier === 0);

      if (this.zeroPremium) {
        if (nonPremium.length === 0) {
          this.logError("zeroPremium: no non-premium models available");
          throw new Error("zeroPremium is enabled but no non-premium models are available");
        }
        if (this.model !== undefined) {
          const modelInfo = models.find((m) => m.id === this.model);
          if (modelInfo !== undefined && modelInfo.billing?.multiplier !== 0) {
            this.log(`zeroPremium: overriding premium model ${this.model} → ${nonPremium[0]!.id}`);
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
      this.logError(`failed to list models from SDK, falling back to gpt-4.1: ${err instanceof Error ? err.message : String(err)}`);
      return this.model ?? "gpt-4.1";
    }
  }

  /** Transition a session to suspended state.
   *  Token accumulation and physical session history are managed by gateway's
   *  SessionOrchestrator (via physical_session_ended message). Agent only clears
   *  its local references. */
  suspendSessionState(entry: AgentSessionEntry): void {
    entry.info.status = "suspended";
    entry.copilotSession = undefined;
    // copilotSessionId is preserved for resumeSession on revival
  }

  private suspendSession(entry: AgentSessionEntry): void {
    this.suspendSessionState(entry);
  }

  /** Explicitly stop a session — fully removes the abstract session. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.abortController.abort();
    this.sessions.delete(sessionId);
  }

  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    const entries = [...this.sessions.entries()];
    for (const [sessionId, entry] of entries) {
      entry.abortController.abort();
      promises.push(entry.sessionPromise);
      this.sessions.delete(sessionId);
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => { timeoutHandle = setTimeout(r, 5000); });
    await Promise.race([
      Promise.allSettled(promises).finally(() => { clearTimeout(timeoutHandle); }),
      timeout,
    ]);
  }

  /** Attach lifecycle handlers (suspend on idle/error) to a session's runSession promise.
   *  Used by startSession to handle the .then/.catch/.finally chain. */
  private attachSessionLifecycle(entry: AgentSessionEntry, clientToStop: CopilotClient): Promise<void> {
    const startTime = Date.now();
    const sessionId = entry.sessionId;
    const boundChannelId = entry.info.boundChannelId;

    return this.runSession(entry).then(() => {
      if (!entry.abortController.signal.aborted) {
        const elapsed = Date.now() - startTime;
        this.log(`session ${sessionId.slice(0, 8)} idle exit after ${Math.round(elapsed / 1000)}s (channel ${boundChannelId?.slice(0, 8) ?? "none"})`);
        this.sendPhysicalSessionEnded(entry, "idle", elapsed);
        this.suspendSession(entry);
      }
    }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.logError(`session ${sessionId.slice(0, 8)} error: ${reason}`);
      if (!entry.abortController.signal.aborted) {
        const elapsed = Date.now() - startTime;
        this.sendPhysicalSessionEnded(entry, "error", elapsed, reason);
        // Clear copilotSessionId so the next revival creates a fresh session
        // instead of trying to resume a broken one (e.g. "No tool output found")
        if (entry.copilotSessionId !== undefined) {
          this.log(`clearing copilotSessionId ${entry.copilotSessionId.slice(0, 12)} after error`);
          entry.copilotSessionId = undefined;
        }
        this.suspendSession(entry);
      }
    }).finally(() => {
      clientToStop.stop().catch(() => {});
    });
  }

  /** Send physical_session_ended notification to gateway. */
  sendPhysicalSessionEnded(
    entry: AgentSessionEntry,
    reason: "idle" | "error" | "aborted",
    elapsedMs: number,
    error?: string,
  ): void {
    const msg: Record<string, unknown> = {
      type: "physical_session_ended",
      sessionId: entry.sessionId,
      reason,
      copilotSessionId: entry.copilotSessionId ?? "",
      elapsedMs,
    };
    if (error !== undefined) msg["error"] = error;
    this.postToGateway(msg);
  }

  /** Fire-and-forget send to gateway via IPC stream. */
  private postToGateway(msg: Record<string, unknown>): void {
    sendToGateway(msg);
  }

  private postChannelMessage(channelId: string, message: string): void {
    sendToGateway({ type: "channel_message", channelId, sender: "agent", message });
  }

}
