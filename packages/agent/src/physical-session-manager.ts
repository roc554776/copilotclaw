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

export type PhysicalSessionStatus = "starting" | "waiting" | "processing" | "suspended" | "stopped";

export interface PhysicalSessionInfo {
  status: PhysicalSessionStatus;
  startedAt: string;
  processingStartedAt?: string | undefined;
}

interface PhysicalSessionEntry {
  sessionId: string;
  copilotSessionId?: string | undefined; // SDK session ID for resumeSession
  copilotSession?: CopilotSession | undefined; // Live SDK session for getMessages()
  resolvedModel?: string | undefined; // Model resolved by gateway
  info: PhysicalSessionInfo;
  client: CopilotClient;
  abortController: AbortController;
  sessionPromise: Promise<void>;
  generation: number;
  reinjectCount: number;
}

export interface PhysicalSessionManagerOptions {
  workingDirectory?: string;
  /** GitHub token for authentication (from profile auth config). When set, passed to CopilotClient. */
  githubToken?: string;
  /** Log level: "info" (default) or "debug" (enables verbose hook/internal logging). */
  debugLogLevel?: "info" | "debug";
  /** Prompt and session config pushed from gateway. */
  prompts: {
    customAgents?: Array<{ name: string; displayName: string; description: string; prompt: string; infer: boolean }>;
    primaryAgentName?: string;
    systemReminder: string;
    initialPrompt: string;
    staleTimeoutMs: number;
    maxSessionAgeMs: number;
    rapidFailureThresholdMs: number;
    backoffDurationMs: number;
    keepaliveTimeoutMs?: number;
    reminderThresholdPercent?: number;
    knownSections?: string[];
    maxQueueSize?: number;
    clientOptions?: Record<string, unknown>;
    sessionConfigOverrides?: Record<string, unknown>;
    toolDefinitions?: Array<{ name: string; description: string; parameters: Record<string, unknown>; skipPermission?: boolean }>;
  };
  /** Structured log function (info level). Falls back to structured JSON on console.error. */
  log?: (message: string) => void;
  /** Structured log function (error level). Falls back to structured JSON on console.error. */
  logError?: (message: string) => void;
}

export interface StartPhysicalSessionOptions {
  /** Opaque session token assigned by gateway. Agent uses this for all IPC communication.
   *  Agent does not know what this token represents internally (abstract session, channel, etc.). */
  sessionId: string;
  /** SDK session ID to resume instead of creating a new one. Used by deferred resume. */
  copilotSessionId?: string;
  /** Resolved model name from gateway. When set, agent uses this model directly
   *  instead of running its own model selection algorithm. */
  resolvedModel?: string;
}

// Session timing values are owned by gateway (agent-config.ts) and pushed via IPC.

export class PhysicalSessionManager {
  private readonly sessions = new Map<string, PhysicalSessionEntry>();
  private readonly workingDirectory: string | undefined;
  private readonly githubToken: string | undefined;
  private readonly customAgents: Array<{ name: string; displayName: string; description: string; prompt: string; infer: boolean }>;
  private readonly primaryAgentName: string;
  private readonly systemReminder: string;
  private readonly initialPrompt: string;
  private readonly keepaliveTimeoutMs: number;
  private readonly reminderThresholdPercent: number;
  private readonly knownSections: string[];
  private readonly clientOptions: Record<string, unknown>;
  private readonly sessionConfigOverrides: Record<string, unknown>;
  private readonly toolDefinitions: Array<{ name: string; description: string; parameters: Record<string, unknown>; skipPermission?: boolean }>;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string) => void;
  private generationCounter = 0;

  constructor(options: PhysicalSessionManagerOptions) {
    this.workingDirectory = options.workingDirectory;
    this.githubToken = options.githubToken;
    const defaultLog = (message: string) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "info", component: "agent", msg: message }));
    };
    const defaultLogError = (message: string) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", component: "agent", msg: message }));
    };
    // Dynamic custom agents list from gateway (passthrough to SDK).
    // customAgents is optional on the agent-side type for backward compat with old gateways
    // that do not send the field. The gateway (agent-config.ts) always sends it as a required
    // field. The empty-array fallback is a type-safety guard — if it fires, the SDK call will
    // have customAgents:[] with agent:"channel-operator", which is a degraded/broken state.
    this.customAgents = options.prompts.customAgents ?? [];
    this.primaryAgentName = options.prompts.primaryAgentName ?? this.customAgents.find((a) => !a.infer)?.name ?? "channel-operator";
    this.systemReminder = options.prompts.systemReminder;
    this.initialPrompt = options.prompts.initialPrompt;
    this.keepaliveTimeoutMs = options.prompts.keepaliveTimeoutMs ?? 25 * 60 * 1000;
    this.reminderThresholdPercent = options.prompts.reminderThresholdPercent ?? 0.10;
    this.knownSections = options.prompts.knownSections ?? [
      "identity", "tone", "tool_efficiency", "environment_context",
      "code_change_rules", "guidelines", "safety", "tool_instructions",
      "custom_instructions", "last_instructions",
    ];
    this.clientOptions = options.prompts.clientOptions ?? {};
    this.sessionConfigOverrides = options.prompts.sessionConfigOverrides ?? {};
    this.toolDefinitions = options.prompts.toolDefinitions ?? [];
    this.log = options.log ?? defaultLog;
    this.logError = options.logError ?? defaultLogError;
  }

  /** Create a CopilotClient with gateway-provided options (passthrough). */
  private createClient(): CopilotClient {
    const opts: Record<string, unknown> = { ...this.clientOptions };
    if (this.githubToken !== undefined) {
      opts["githubToken"] = this.githubToken;
    }
    return new CopilotClient(opts as ConstructorParameters<typeof CopilotClient>[0]);
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
      await client.start();
      return await client.rpc.account.getQuota() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      this.logError(`getQuota error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getModels(): Promise<Record<string, unknown> | null> {
    try {
      const client = this.getAnyClient();
      await client.start();
      return await client.rpc.models.list() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      this.logError(`getModels error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Get session messages (conversation history) from the SDK for a given copilot session ID. */
  async getPhysicalSessionMessages(copilotSessionId: string): Promise<unknown[] | null> {
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

  getPhysicalSessionStatuses(): Record<string, PhysicalSessionInfo> {
    const result: Record<string, PhysicalSessionInfo> = {};
    for (const [sessionId, entry] of this.sessions) {
      result[sessionId] = { ...entry.info };
    }
    return result;
  }

  /** Return a list of currently running (non-suspended) sessions for stream reconciliation.
   *  Used when gateway reconnects to discover which physical sessions are still alive. */
  getRunningPhysicalSessionsSummary(): Array<{ sessionId: string; status: string }> {
    const result: Array<{ sessionId: string; status: string }> = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.info.status !== "suspended") {
        result.push({ sessionId, status: entry.info.status });
      }
    }
    return result;
  }

  getPhysicalSessionStatus(sessionId: string): PhysicalSessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return undefined;
    return { ...entry.info };
  }

  startPhysicalSession(options: StartPhysicalSessionOptions): string {
    const { sessionId, copilotSessionId, resolvedModel } = options;

    const abortController = new AbortController();
    const client = this.createClient();
    const generation = ++this.generationCounter;
    const entry: PhysicalSessionEntry = {
      sessionId,
      info: {
        status: "starting",
        startedAt: new Date().toISOString(),
      },
      client,
      abortController,
      sessionPromise: Promise.resolve(),
      generation,
      reinjectCount: 0,
    };

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

  private async runSession(entry: PhysicalSessionEntry): Promise<void> {
    const { tools: channelTools } = createChannelTools({
      sessionId: entry.sessionId,
      keepaliveTimeoutMs: this.keepaliveTimeoutMs,
      abortSignal: entry.abortController.signal,
      onStatusChange: (status) => {
        entry.info.status = status;
        if (status === "processing") {
          entry.info.processingStartedAt = new Date().toISOString();
        }
      },
      logError: this.logError,
      toolDefinitions: this.toolDefinitions,
    });

    const signal = entry.abortController.signal;

    // State for periodic system prompt reinforcement via onPostToolUse additionalContext.
    // Tracks context usage percentage to avoid reminding on every tool call.
    const reminderState = {
      needsReminder: false,
      lastReminderPercent: 0,
      currentUsagePercent: 0,
    };

    // Generic hook dispatcher: all SDK hooks are forwarded to gateway via RPC.
    // Gateway decides what to return. If gateway is unreachable, agent uses fallback.
    // This ensures new hook types added by SDK are automatically gateway-controllable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeHookHandler = (hookName: string): ((...args: any[]) => Promise<any>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return async (input: any, invocation?: { sessionId?: string }) => {
        if (signal.aborted) return;

        // For onPostToolUse, consume reminderState synchronously before any await
        // to prevent concurrent hook calls from duplicating reminder injection (TOCTOU).
        let shouldRemind = false;
        if (hookName === "onPostToolUse") {
          shouldRemind = reminderState.needsReminder;
          if (shouldRemind) {
            reminderState.needsReminder = false;
            reminderState.lastReminderPercent = reminderState.currentUsagePercent;
          }
        }

        let gatewayResult: unknown = undefined;
        let gatewayReachable = false;
        try {
          gatewayResult = await requestFromGateway({
            type: "hook",
            hookName,
            sessionId: entry.sessionId,
            copilotSessionId: invocation?.sessionId,
            input: input as Record<string, unknown>,
          });
          gatewayReachable = true;
        } catch {
          // Gateway unreachable — use fallback behavior below
        }

        if (gatewayReachable) {
          // Gateway online: use its result, but always inject agent-side reminder for onPostToolUse.
          if (hookName === "onPostToolUse" && shouldRemind) {
            const existingContext = (gatewayResult !== null && gatewayResult !== undefined && typeof gatewayResult === "object")
              ? (gatewayResult as Record<string, unknown>)["additionalContext"] as string | undefined
              : undefined;
            const parts: string[] = [];
            if (existingContext !== undefined && existingContext !== "") parts.push(existingContext);
            parts.push(this.systemReminder);
            return { additionalContext: parts.join("\n\n") };
          }
          if (gatewayResult !== null && gatewayResult !== undefined && typeof gatewayResult === "object") {
            return gatewayResult;
          }
          return;
        }

        // Fallback: agent-autonomous behavior when gateway is offline.
        // Only onPostToolUse has meaningful fallback (keepalive reminder).
        if (hookName === "onPostToolUse") {
          return this.postToolUseFallback(entry.sessionId, shouldRemind);
        }
        return;
      };
    };

    const sessionConfig = {
      onPermissionRequest: approveAll,
      tools: channelTools,
      hooks: {
        onPreToolUse: makeHookHandler("onPreToolUse"),
        onPostToolUse: makeHookHandler("onPostToolUse"),
        onUserPromptSubmitted: makeHookHandler("onUserPromptSubmitted"),
        onSessionStart: makeHookHandler("onSessionStart"),
        onSessionEnd: makeHookHandler("onSessionEnd"),
        onErrorOccurred: makeHookHandler("onErrorOccurred"),
      },
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
    // Use gateway-provided section list (no hardcoded list in agent)
    const sections: Record<string, { action: (content: string) => Promise<string> }> = {};
    for (const id of this.knownSections) {
      sections[id] = { action: makeSectionCapture(id) };
    }

    // Build session config with gateway-provided overrides (passthrough)
    const baseConfig = {
      model: resolvedModel,
      ...(this.workingDirectory !== undefined ? { workingDirectory: this.workingDirectory } : {}),
      ...sessionConfig,
      systemMessage: {
        mode: "customize" as const,
        sections,
      },
      // Dynamic custom agents list from gateway (passthrough to SDK)
      customAgents: this.customAgents.map((a) => ({ ...a, tools: null })),
      agent: this.primaryAgentName,
      // Gateway-provided session config overrides (passthrough to SDK).
      // Intentionally last — this can overwrite any field above (model, agent,
      // customAgents, systemMessage, onPermissionRequest, tools, hooks, etc.).
      // Gateway is the trusted authority; unexpected overwrites are an ops concern.
      ...this.sessionConfigOverrides,
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

    // Forward ALL SDK events to gateway unconditionally.
    // Using session.on(handler) catch-all instead of a hardcoded event list,
    // so new SDK event types are automatically forwarded without agent update.
    // This is fire-and-forget — gateway停止時も物理セッションに影響しない。
    session.on((event: { type: string; timestamp?: string; data?: unknown }) => {
      this.postToGateway({
        type: "session_event",
        sessionId: entry.sessionId,
        copilotSessionId: session.sessionId,
        eventType: event.type,
        timestamp: event.timestamp ?? new Date().toISOString(),
        data: (typeof event.data === "object" && event.data !== null) ? event.data : {},
      });
    });

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
        this.postMessage(entry.sessionId, content);
      }
    });

    const logPrefix = entry.sessionId.slice(0, 8);
    await runSessionLoop({
      session: adaptCopilotSession(session),
      // System prompt is in the channel-operator custom agent's prompt field.
      // initialPrompt is the first user-turn message that kicks off the session.
      initialPrompt: this.initialPrompt,
      onMessage: (content) => { console.log(`[sess:${logPrefix}] ${content}`); },
      log: (message) => { this.log(`[${logPrefix}] ${message}`); },
      shouldStop: () => entry.abortController.signal.aborted,
    });
  }

  /** Resolve which model to use for session creation (fallback only).
   * Gateway normally sends resolvedModel; this runs only when gateway didn't provide one.
   * Queries available models via SDK and picks the cheapest. */
  private async resolveModel(client: CopilotClient): Promise<string> {
    try {
      // Ensure the CLI process is started before accessing client.rpc.
      // createSession calls start() automatically via autoStart, but
      // resolveModel runs before createSession to determine the model.
      await client.start();
      const { models } = await client.rpc.models.list();
      if (models.length === 0) {
        this.logError("no models available from SDK, falling back to gpt-4.1");
        return "gpt-4.1";
      }

      // Sort by billing multiplier (ascending — cheapest first)
      const sorted = [...models].sort((a, b) =>
        (a.billing?.multiplier ?? Infinity) - (b.billing?.multiplier ?? Infinity),
      );

      return sorted[0]!.id;
    } catch (err: unknown) {
      this.logError(`failed to list models from SDK, falling back to gpt-4.1: ${err instanceof Error ? err.message : String(err)}`);
      return "gpt-4.1";
    }
  }

  /** Fallback onPostToolUse behavior when gateway is unreachable.
   *  Maintains keepalive by checking pending messages and injecting reminders.
   *  This ensures physical sessions survive gateway downtime.
   *  @param shouldRemind - pre-consumed reminder flag (consumed synchronously before the RPC call). */
  private async postToolUseFallback(
    sessionId: string,
    shouldRemind: boolean,
  ): Promise<{ additionalContext: string } | void> {
    const parts: string[] = [];

    // Check for pending user messages via IPC (will fail if gateway is down — that's OK)
    try {
      const peekResult = await requestFromGateway({ type: "peek_pending", sessionId });
      if (peekResult !== null && peekResult !== undefined) {
        parts.push(`[NOTIFICATION] New user message is available on the channel. Call copilotclaw_wait immediately to read it.`);
      }
    } catch {
      // IPC error — skip notification (non-fatal)
    }

    if (shouldRemind) {
      parts.push(this.systemReminder);
    }

    if (parts.length > 0) {
      return { additionalContext: parts.join("\n\n") };
    }
    return;
  }

  /** Transition a session to suspended state.
   *  Token accumulation and physical session history are managed by gateway's
   *  SessionOrchestrator (via physical_session_ended message). Agent only clears
   *  its local references. */
  suspendPhysicalSessionState(entry: PhysicalSessionEntry): void {
    entry.info.status = "suspended";
    entry.copilotSession = undefined;
    // copilotSessionId is preserved for resumeSession on revival
  }

  private suspendPhysicalSession(entry: PhysicalSessionEntry): void {
    this.suspendPhysicalSessionState(entry);
  }

  /** Explicitly stop a session — fully removes the abstract session. */
  stopPhysicalSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.abortController.abort();
    this.sessions.delete(sessionId);
  }

  async stopAllPhysicalSessions(): Promise<void> {
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

  /** Ask gateway what to do when a session goes idle or errors.
   *  Returns { action: "stop"|"reinject"|"wait", clearCopilotSessionId?: boolean }.
   *  If gateway is unreachable, defaults to "wait" (keep session alive). */
  private async queryLifecycleAction(
    entry: PhysicalSessionEntry,
    event: "idle" | "error",
    elapsedMs: number,
    error?: string,
  ): Promise<{ action: "stop" | "reinject" | "wait"; clearCopilotSessionId?: boolean }> {
    try {
      const result = await requestFromGateway({
        type: "lifecycle",
        event,
        sessionId: entry.sessionId,
        elapsedMs,
        ...(error !== undefined ? { error } : {}),
      });
      if (result !== null && result !== undefined && typeof result === "object") {
        const action = (result as Record<string, unknown>)["action"];
        if (action === "stop" || action === "reinject" || action === "wait") {
          return {
            action,
            clearCopilotSessionId: (result as Record<string, unknown>)["clearCopilotSessionId"] === true,
          };
        }
      }
    } catch {
      // Gateway unreachable — default to keeping the session alive
    }
    return { action: "wait" };
  }

  /** Attach lifecycle handlers to a session's runSession promise.
   *  On idle/error, asks gateway what to do (stop/reinject/wait).
   *  Default (gateway offline): keep session alive (don't destroy). */
  private attachSessionLifecycle(entry: PhysicalSessionEntry, clientToStop: CopilotClient): Promise<void> {
    const startTime = Date.now();
    const sessionId = entry.sessionId;

    const MAX_REINJECT = 10;

    const handleLifecycleEvent = async (event: "idle" | "error", error?: string) => {
      if (entry.abortController.signal.aborted) return;
      const elapsed = Date.now() - startTime;

      if (event === "idle") {
        this.log(`session ${sessionId.slice(0, 8)} idle exit after ${Math.round(elapsed / 1000)}s`);
      } else {
        this.logError(`session ${sessionId.slice(0, 8)} error: ${error ?? "unknown"}`);
      }

      const decision = await this.queryLifecycleAction(entry, event, elapsed, error);

      // Re-check abort after async RPC — stopAll may have set the signal while we
      // were awaiting the gateway response and already captured the old sessionPromise.
      if (entry.abortController.signal.aborted) return;

      this.log(`session ${sessionId.slice(0, 8)} lifecycle decision: ${decision.action}`);

      if (decision.clearCopilotSessionId && entry.copilotSessionId !== undefined) {
        this.log(`clearing copilotSessionId ${entry.copilotSessionId.slice(0, 12)}`);
        entry.copilotSessionId = undefined;
      }

      // Cap reinject depth to prevent unbounded recursion when gateway persistently
      // returns "reinject" (e.g. due to a bug). Treat excess as "wait".
      const effectiveAction =
        decision.action === "reinject" && entry.reinjectCount >= MAX_REINJECT
          ? "wait"
          : decision.action;
      if (effectiveAction !== decision.action) {
        this.logError(`session ${sessionId.slice(0, 8)} reinject cap reached (${entry.reinjectCount}), treating as "wait"`);
      }

      switch (effectiveAction) {
        case "stop":
          this.sendPhysicalSessionEnded(entry, event, elapsed, error);
          this.suspendPhysicalSession(entry);
          clientToStop.stop().catch(() => {});
          break;
        case "reinject":
          // Re-enter the session loop with a new send() call.
          // This keeps the physical session alive by sending a new prompt.
          entry.reinjectCount += 1;
          this.log(`session ${sessionId.slice(0, 8)} reinjecting (count: ${entry.reinjectCount})`);
          entry.sessionPromise = this.attachSessionLifecycle(entry, clientToStop);
          break;
        case "wait":
          // Keep session alive — don't stop the client.
          // The session is idle but not destroyed. Gateway will send
          // start_physical_session or stop_physical_session when ready.
          this.log(`session ${sessionId.slice(0, 8)} waiting (session maintained)`);
          break;
      }
    };

    return this.runSession(entry)
      .then(() => handleLifecycleEvent("idle"))
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        return handleLifecycleEvent("error", reason);
      });
  }

  /** Send physical_session_ended notification to gateway. */
  sendPhysicalSessionEnded(
    entry: PhysicalSessionEntry,
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

  private postMessage(sessionId: string, message: string): void {
    sendToGateway({ type: "channel_message", sessionId, sender: "agent", message });
  }

}
