import { CopilotClient, type CopilotSession, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { requestFromGateway, sendToGateway } from "./ipc-server.js";
import { createChannelTools } from "./tools/channel.js";
import { reducePhysicalSession, reduceCopilotClient } from "./session-reducer.js";
import type { PhysicalSessionWorldState, PhysicalSessionEvent, CopilotClientWorldState } from "./session-events.js";

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

/**
 * Derive the public PhysicalSessionStatus from the internal PhysicalSessionWorldState status.
 * waiting_on_wait_tool and reinject are internal states not exposed externally.
 */
function derivePublicStatus(worldStatus: PhysicalSessionWorldState["status"]): PhysicalSessionStatus {
  switch (worldStatus) {
    case "starting": return "starting";
    case "waiting": return "waiting";
    case "waiting_on_wait_tool": return "waiting";
    case "processing": return "processing";
    case "reinject": return "waiting";
    case "suspended": return "suspended";
    case "stopped": return "stopped";
  }
}

interface PhysicalSessionEntry {
  sessionId: string;
  physicalSessionId?: string | undefined; // Self-generated session ID for SDK createSession/resumeSession
  copilotSession?: CopilotSession | undefined; // Live SDK session for getMessages()
  resolvedModel?: string | undefined; // Model resolved by gateway
  /** Reducer-managed world state — the sole source of truth for session status and reinjectCount. */
  worldState: PhysicalSessionWorldState;
  /** processingStartedAt is tracked here (not in worldState) for the public PhysicalSessionInfo shape. */
  processingStartedAt: string | undefined;
  abortController: AbortController;
  sessionPromise: Promise<void>;
}

export interface PhysicalSessionManagerOptions {
  workingDirectory?: string;
  /** GitHub token for authentication (from profile auth config). When set, passed to CopilotClient. */
  githubToken?: string;
  /** Log level: "info" (default) or "debug" (enables verbose hook/internal logging). */
  debugLogLevel?: "info" | "debug";
  /** Prompt and session config pushed from gateway. */
  prompts: {
    customAgents?: Array<{ name: string; displayName: string; description: string; prompt: string; infer: boolean; copilotclawTools?: string[] }>;
    primaryAgentName?: string;
    systemReminder: string;
    initialPrompt: string;
    staleTimeoutMs: number;
    maxSessionAgeMs: number;
    rapidFailureThresholdMs: number;
    backoffDurationMs: number;
    keepaliveTimeoutMs?: number;
    reminderThresholdPercent?: number;
    maxReinject?: number;
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
   *  Agent does not interpret this token — gateway owns its meaning. */
  sessionId: string;
  /** Physical session ID to resume instead of creating a new one. */
  physicalSessionId?: string;
  /** Resolved model name from gateway. When set, agent uses this model directly
   *  instead of running its own model selection algorithm. */
  resolvedModel?: string;
}

// Session timing values are owned by gateway (agent-config.ts) and pushed via IPC.

export class PhysicalSessionManager {
  private readonly sessions = new Map<string, PhysicalSessionEntry>();
  private readonly workingDirectory: string | undefined;
  private readonly githubToken: string | undefined;
  private readonly customAgents: Array<{ name: string; displayName: string; description: string; prompt: string; infer: boolean; copilotclawTools: string[] }>;
  private readonly primaryAgentName: string;
  private readonly initialPrompt: string;
  private readonly keepaliveTimeoutMs: number;
  private readonly maxReinject: number;
  private readonly knownSections: string[];
  private readonly clientOptions: Record<string, unknown>;
  private readonly sessionConfigOverrides: Record<string, unknown>;
  private readonly toolDefinitions: Array<{ name: string; description: string; parameters: Record<string, unknown>; skipPermission?: boolean }>;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string) => void;

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
    this.customAgents = (options.prompts.customAgents ?? []).map((a) => ({
      ...a,
      copilotclawTools: a.copilotclawTools ?? [],
    }));
    this.primaryAgentName = options.prompts.primaryAgentName ?? this.customAgents.find((a) => !a.infer)?.name ?? "channel-operator";
    this.initialPrompt = options.prompts.initialPrompt;
    this.keepaliveTimeoutMs = options.prompts.keepaliveTimeoutMs ?? 25 * 60 * 1000;
    this.maxReinject = options.prompts.maxReinject ?? 10;
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

  // ── CopilotClient singleton — reducer-managed ─────────────────────────────
  // World state is managed through reduceCopilotClient (pure function).
  // Process state (client handle + start promise) is separate per design.
  private copilotClientWorldState: CopilotClientWorldState = { status: "uninitialized" };
  /** Process state: the live CopilotClient instance. */
  private client: CopilotClient | undefined;
  /** Process state: the in-flight start promise (prevents double-start). */
  private clientStartPromise: Promise<void> | undefined;

  /** Dispatch a CopilotClient event through the reducer. */
  private dispatchClientEvent(event: import("./session-events.js").CopilotClientEvent): void {
    const { newState } = reduceCopilotClient(this.copilotClientWorldState, event);
    this.copilotClientWorldState = newState;
  }

  /** Get or create the singleton CopilotClient (process state only). */
  private getClient(): CopilotClient {
    if (this.client === undefined) {
      const opts: Record<string, unknown> = { ...this.clientOptions };
      if (this.githubToken !== undefined) {
        opts["githubToken"] = this.githubToken;
      }
      this.client = new CopilotClient(opts as ConstructorParameters<typeof CopilotClient>[0]);
    }
    return this.client;
  }

  /** Ensure the singleton client is started.
   *  Routes through the CopilotClient reducer for double-start prevention.
   *  Returns the existing promise if already starting/running. */
  private ensureClientStarted(): Promise<void> {
    // Only start from "uninitialized" state (reducer enforces this)
    if (this.copilotClientWorldState.status === "uninitialized") {
      this.dispatchClientEvent({ type: "StartRequested" });
      const client = this.getClient();
      this.clientStartPromise = client.start().then(() => {
        this.dispatchClientEvent({ type: "StartCompleted" });
      }).catch((err: unknown) => {
        this.dispatchClientEvent({ type: "ErrorOccurred", error: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }
    // If starting or running, return the existing promise (or a resolved one)
    return this.clientStartPromise ?? Promise.resolve();
  }

  async getQuota(): Promise<Record<string, unknown> | null> {
    try {
      const client = this.getClient();
      await this.ensureClientStarted();
      return await client.rpc.account.getQuota() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      this.logError(`getQuota error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getModels(): Promise<Record<string, unknown> | null> {
    try {
      const client = this.getClient();
      await this.ensureClientStarted();
      return await client.rpc.models.list() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      this.logError(`getModels error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Get session messages (conversation history) from the SDK for a given copilot session ID. */
  async getPhysicalSessionMessages(physicalSessionId: string): Promise<unknown[] | null> {
    for (const [, entry] of this.sessions) {
      if (entry.physicalSessionId === physicalSessionId && entry.copilotSession !== undefined) {
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
      result[sessionId] = this.deriveInfo(entry);
    }
    return result;
  }

  /** Return a list of currently running (non-suspended) sessions for stream reconciliation.
   *  Used when gateway reconnects to discover which physical sessions are still alive. */
  getRunningPhysicalSessionsSummary(): Array<{ sessionId: string; status: string }> {
    const result: Array<{ sessionId: string; status: string }> = [];
    for (const [sessionId, entry] of this.sessions) {
      const publicStatus = derivePublicStatus(entry.worldState.status);
      if (publicStatus !== "suspended") {
        result.push({ sessionId, status: publicStatus });
      }
    }
    return result;
  }

  getPhysicalSessionStatus(sessionId: string): PhysicalSessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return undefined;
    return this.deriveInfo(entry);
  }

  /** Derive the public PhysicalSessionInfo from an entry's world state. */
  private deriveInfo(entry: PhysicalSessionEntry): PhysicalSessionInfo {
    return {
      status: derivePublicStatus(entry.worldState.status),
      startedAt: entry.worldState.startedAt ?? new Date().toISOString(),
      processingStartedAt: entry.processingStartedAt,
    };
  }

  /** Apply a new world state to an entry. The sole write path for session status. */
  private applyWorldState(entry: PhysicalSessionEntry, newState: PhysicalSessionWorldState): void {
    const prevStatus = entry.worldState.status;
    entry.worldState = newState;
    // Track processingStartedAt as a derived side-effect of status transition
    if (newState.status === "processing" && prevStatus !== "processing") {
      entry.processingStartedAt = new Date().toISOString();
    } else if (newState.status !== "processing") {
      entry.processingStartedAt = undefined;
    }
    // Sync physicalSessionId so existing imperative code reading entry.physicalSessionId stays correct
    entry.physicalSessionId = newState.physicalSessionId;
  }

  /** Dispatch a PhysicalSessionEvent through the reducer and apply the resulting world state. */
  private dispatchPhysicalEvent(entry: PhysicalSessionEntry, event: PhysicalSessionEvent): void {
    const { newState } = reducePhysicalSession(entry.worldState, event);
    this.applyWorldState(entry, newState);
    // Commands are intentionally ignored here — side effects (AbortSession, NotifyGateway, etc.)
    // are executed by the existing imperative code in attachSessionLifecycle/runSession.
    // The reducer is used solely as the state-transition source of truth.
  }

  startPhysicalSession(options: StartPhysicalSessionOptions): string {
    const { sessionId, physicalSessionId, resolvedModel } = options;

    const abortController = new AbortController();
    const entry: PhysicalSessionEntry = {
      sessionId,
      worldState: {
        sessionId,
        physicalSessionId,
        status: "starting",
        startedAt: new Date().toISOString(),
        resolvedModel,
        reinjectCount: 0,
        currentToolName: undefined,
      },
      processingStartedAt: undefined,
      abortController,
      sessionPromise: Promise.resolve(),
    };

    // Propagate physical session ID for resume before runSession reads it
    if (physicalSessionId !== undefined) {
      entry.physicalSessionId = physicalSessionId;
    }

    // Store resolved model from gateway for use in runSession
    if (resolvedModel !== undefined) {
      entry.resolvedModel = resolvedModel;
    }

    entry.sessionPromise = this.attachSessionLifecycle(entry);
    this.sessions.set(sessionId, entry);
    return sessionId;
  }

  private async runSession(entry: PhysicalSessionEntry): Promise<void> {
    const { tools: channelTools } = createChannelTools({
      sessionId: entry.sessionId,
      keepaliveTimeoutMs: this.keepaliveTimeoutMs,
      abortSignal: entry.abortController.signal,
      onStatusChange: (status) => {
        if (status === "waiting") {
          // copilotclaw_wait tool entered. If currently processing (agent finished handling
          // a message and called wait again), complete the prior tool execution first.
          const current = entry.worldState.status;
          if (current === "processing") {
            this.dispatchPhysicalEvent(entry, { type: "ToolExecutionCompleted", toolName: entry.worldState.currentToolName ?? "copilotclaw_wait" });
          }
          this.dispatchPhysicalEvent(entry, { type: "WaitToolCalled" });
        } else if (status === "processing") {
          // A real user message arrived while waiting — transition to processing.
          this.dispatchPhysicalEvent(entry, { type: "WaitToolCompleted" });
          this.dispatchPhysicalEvent(entry, { type: "ToolExecutionStarted", toolName: "copilotclaw_wait" });
        }
      },
      logError: this.logError,
      toolDefinitions: this.toolDefinitions,
    });

    const signal = entry.abortController.signal;

    // Generic hook dispatcher: all SDK hooks are forwarded to gateway via RPC.
    // Gateway decides what to return (including reminder injection).
    // If gateway is unreachable, agent uses fallback.
    // This ensures new hook types added by SDK are automatically gateway-controllable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeHookHandler = (hookName: string): ((...args: any[]) => Promise<any>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return async (input: any, invocation?: { sessionId?: string }) => {
        if (signal.aborted) return;

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
          if (gatewayResult !== null && gatewayResult !== undefined && typeof gatewayResult === "object") {
            return gatewayResult;
          }
          return;
        }

        // Fallback: agent-autonomous behavior when gateway is offline.
        // Only onPostToolUse has meaningful fallback (pending message notification).
        if (hookName === "onPostToolUse") {
          return this.postToolUseFallback(entry.sessionId);
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
    const resolvedModel = entry.resolvedModel ?? await this.resolveModel(this.getClient());

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

    // Fetch builtin tool names from SDK. Called every session creation (not cached)
    // so that tool availability is always current.
    await this.ensureClientStarted();
    const toolsListResult = await this.getClient().rpc.tools.list({});
    const builtinToolNames: string[] = toolsListResult.tools.map((t: { name: string }) => t.name);

    // Build session config with gateway-provided overrides (passthrough)
    const baseConfig = {
      model: resolvedModel,
      ...(this.workingDirectory !== undefined ? { workingDirectory: this.workingDirectory } : {}),
      ...sessionConfig,
      systemMessage: {
        mode: "customize" as const,
        sections,
      },
      // Dynamic custom agents list from gateway (passthrough to SDK).
      // Each agent's tools = builtin tools + copilotclaw tools for that agent.
      customAgents: this.customAgents.map((a) => ({
        name: a.name,
        displayName: a.displayName,
        description: a.description,
        prompt: a.prompt,
        infer: a.infer,
        tools: [...builtinToolNames, ...a.copilotclawTools],
      })),
      agent: this.primaryAgentName,
      // Gateway-provided session config overrides (passthrough to SDK).
      // Intentionally last — this can overwrite any field above (model, agent,
      // customAgents, systemMessage, onPermissionRequest, tools, hooks, etc.).
      // Gateway is the trusted authority; unexpected overwrites are an ops concern.
      ...this.sessionConfigOverrides,
    };
    let session: CopilotSession;
    if (entry.physicalSessionId !== undefined) {
      try {
        session = await this.getClient().resumeSession(entry.physicalSessionId, baseConfig);
      } catch (resumeErr: unknown) {
        this.log(`resumeSession failed for ${entry.physicalSessionId.slice(0, 12)}, creating new session: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`);
        entry.physicalSessionId = undefined;
        entry.worldState = { ...entry.worldState, physicalSessionId: undefined };
        session = await this.getClient().createSession(baseConfig);
      }
    } else {
      session = await this.getClient().createSession(baseConfig);
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

    entry.copilotSession = session;
    // Transition to waiting via reducer — also records the SDK session ID in worldState.
    // Use SessionCreated for both new and resumed sessions: the distinction (resume vs create)
    // only matters for the StartRequested → command dispatch, which this module handles imperatively.
    this.dispatchPhysicalEvent(entry, { type: "SessionCreated", physicalSessionId: session.sessionId });

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
    // Reminder state (context usage tracking, compaction) is also handled by gateway
    // via session_event messages — agent does not track these locally.

    // assistant.message events are reflected to the channel timeline by the gateway's
    // onSessionEvent handler (via the catch-all session_event forwarding above).
    // No agent-side channel_message sending needed.

    // Set model before session.send — ensures the correct model is used for this turn run.
    // For resumed sessions, this applies the latest model setting from gateway.
    await session.setModel(resolvedModel);

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
      // Ensure the singleton client is started before accessing client.rpc.
      await this.ensureClientStarted();
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
   *  Checks for pending messages to maintain keepalive.
   *  This ensures physical sessions survive gateway downtime. */
  private async postToolUseFallback(
    sessionId: string,
  ): Promise<{ additionalContext: string } | void> {
    // Check for pending user messages via IPC (will fail if gateway is down — that's OK)
    try {
      const peekResult = await requestFromGateway({ type: "peek_pending", sessionId });
      if (peekResult !== null && peekResult !== undefined) {
        return { additionalContext: `[NOTIFICATION] New user message is available on the channel. Call copilotclaw_wait immediately to read it.` };
      }
    } catch {
      // IPC error — skip notification (non-fatal)
    }
    return;
  }

  /** Transition a session to suspended state via reducer.
   *  Token accumulation and physical session history are managed by gateway's
   *  SessionOrchestrator (via physical_session_ended message). Agent only clears
   *  its local references. */
  private suspendPhysicalSession(entry: PhysicalSessionEntry): void {
    this.dispatchPhysicalEvent(entry, { type: "StopRequested" });
    entry.copilotSession = undefined;
    // physicalSessionId is preserved in worldState for resumeSession on revival
  }

  /** Disconnect a session without stopping the CLI process.
   *  Used by end-turn-run: the session loop is aborted and session.disconnect() is called,
   *  but physicalSessionId is preserved so that
   *  the next message can resumeSession with the same context. */
  disconnectPhysicalSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.abortController.abort();
    // Disconnect the SDK session (NOT client.stop — CLI process stays alive for resume)
    if (entry.copilotSession !== undefined) {
      entry.copilotSession.disconnect().catch(() => {});
    }
    // Keep the entry with physicalSessionId for resume, but clear live session ref
    this.suspendPhysicalSession(entry);
  }

  /** Archive a session — disconnect and fully remove (physical session id discarded, context lost). */
  stopPhysicalSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.abortController.abort();
    if (entry.copilotSession !== undefined) {
      entry.copilotSession.disconnect().catch(() => {});
    }
    this.sessions.delete(sessionId);
  }

  async stopAllPhysicalSessions(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [sessionId, entry] of this.sessions) {
      entry.abortController.abort();
      promises.push(entry.sessionPromise);
      this.sessions.delete(sessionId);
    }
    // Wait for session promises to settle (5s timeout)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => { timeoutHandle = setTimeout(r, 5000); });
    await Promise.race([
      Promise.allSettled(promises).finally(() => { clearTimeout(timeoutHandle); }),
      timeout,
    ]);
    // Stop the singleton CopilotClient CLI process via reducer.
    if (this.client !== undefined) {
      this.dispatchClientEvent({ type: "StopRequested" });
      await this.client.stop().catch(() => this.client!.forceStop()).catch(() => {});
      this.dispatchClientEvent({ type: "StopCompleted" });
    }
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
  private attachSessionLifecycle(entry: PhysicalSessionEntry): Promise<void> {
    const startTime = Date.now();
    const sessionId = entry.sessionId;

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

      if (decision.clearCopilotSessionId && entry.worldState.physicalSessionId !== undefined) {
        this.log(`clearing physicalSessionId ${entry.worldState.physicalSessionId.slice(0, 12)}`);
        // Clear physicalSessionId in worldState (the sole source of truth) and sync entry
        entry.worldState = { ...entry.worldState, physicalSessionId: undefined };
        entry.physicalSessionId = undefined;
      }

      // Cap reinject depth to prevent unbounded recursion when gateway persistently
      // returns "reinject" (e.g. due to a bug). Treat excess as "wait".
      const effectiveAction =
        decision.action === "reinject" && entry.worldState.reinjectCount >= this.maxReinject
          ? "wait"
          : decision.action;
      if (effectiveAction !== decision.action) {
        this.logError(`session ${sessionId.slice(0, 8)} reinject cap reached (${entry.worldState.reinjectCount}), treating as "wait"`);
      }

      switch (effectiveAction) {
        case "stop":
          this.sendPhysicalSessionEnded(entry, event, elapsed, error);
          this.suspendPhysicalSession(entry);
          break;
        case "reinject":
          // Re-enter the session loop with a new send() call.
          // Dispatch ReinjectDecided to increment reinjectCount in worldState.
          this.dispatchPhysicalEvent(entry, { type: "ReinjectDecided" });
          this.log(`session ${sessionId.slice(0, 8)} reinjecting (count: ${entry.worldState.reinjectCount})`);
          entry.sessionPromise = this.attachSessionLifecycle(entry);
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
      copilotSessionId: entry.physicalSessionId ?? "",
      elapsedMs,
    };
    if (error !== undefined) msg["error"] = error;
    this.postToGateway(msg);
  }

  /** Fire-and-forget send to gateway via IPC stream. */
  private postToGateway(msg: Record<string, unknown>): void {
    sendToGateway(msg);
  }

}
