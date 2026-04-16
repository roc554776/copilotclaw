/**
 * SessionController: centralizes session lifecycle transitions and message delivery.
 *
 * Replaces the scattered status modifications across daemon.ts/server.ts/session-orchestrator.ts
 * with a single owner that enforces valid state transitions.
 *
 * All session status changes MUST go through this controller — direct calls to
 * orchestrator.updateSessionStatus() from outside this class are prohibited.
 *
 * v0.80.0: Key state transitions now route through the AbstractSession reducer
 * (session-reducer.ts) for pure-function state derivation. The effect runtime
 * (effect-runtime.ts) executes the resulting commands. This eliminates direct
 * mutation of orchestrator state from outside the reducer.
 */

import type { AgentManager } from "./agent-manager.js";
import type { SessionOrchestrator, AbstractSessionStatus } from "./session-orchestrator.js";
import type { Store, Message } from "./store.js";
import { selectDerivedChannelStatus } from "./channel-status-selector.js";
import { reduceAbstractSession } from "./session-reducer.js";
import type { AbstractSessionEvent } from "./session-events.js";
import { executeCommands, sessionToWorldState } from "./effect-runtime.js";

export interface SseBroadcastFn {
  (event: { type: string; channelId?: string; data?: unknown }): void;
}

export interface SessionControllerDeps {
  orchestrator: SessionOrchestrator;
  store: Store;
  agentManager: AgentManager;
  sseBroadcast?: SseBroadcastFn;
  resolveModelForChannel: (channelId: string) => Promise<string | undefined>;
}

/** Per-session ephemeral state — lifecycle-managed alongside the session. */
interface SessionContext {
  /** True when drained messages included a user message and no reply has been sent yet. */
  pendingReplyExpected: boolean;
  /** Context usage tracking for periodic system prompt reminder. */
  reminderState: {
    needsReminder: boolean;
    lastReminderPercent: number;
    currentUsagePercent: number;
  };
}

/** Valid state transitions. Any transition not listed here is rejected. */
const VALID_TRANSITIONS: Record<AbstractSessionStatus, AbstractSessionStatus[]> = {
  new: ["starting", "idle", "suspended"],
  starting: ["waiting", "idle", "suspended"],
  waiting: ["notified", "processing", "idle", "suspended"],
  notified: ["processing", "idle", "suspended"],
  processing: ["waiting", "idle", "suspended"],
  idle: ["starting", "suspended"],
  suspended: ["starting"],
};

export type DeliveryResult = "delivered" | "session-started" | "queued";

export class SessionController {
  private readonly orchestrator: SessionOrchestrator;
  private readonly store: Store;
  private readonly agentManager: AgentManager;
  private sseBroadcast: SseBroadcastFn | undefined;
  private readonly resolveModelForChannel: (channelId: string) => Promise<string | undefined>;
  private readonly contexts = new Map<string, SessionContext>();

  constructor(deps: SessionControllerDeps) {
    this.orchestrator = deps.orchestrator;
    this.store = deps.store;
    this.agentManager = deps.agentManager;
    this.sseBroadcast = deps.sseBroadcast;
    this.resolveModelForChannel = deps.resolveModelForChannel;
  }

  setSseBroadcast(fn: SseBroadcastFn): void {
    this.sseBroadcast = fn;
  }

  // --- Reducer dispatch (v0.80.0) ---

  /**
   * Dispatch an AbstractSessionEvent through the pure reducer and execute the
   * resulting commands via the effect runtime. This is the canonical path for
   * all state mutations that the reducer covers.
   *
   * Falls back gracefully if the session is not found in the orchestrator.
   */
  dispatchEvent(sessionId: string, event: AbstractSessionEvent): void {
    const session = this.orchestrator.getSession(sessionId);
    if (session === undefined) return;

    const state = sessionToWorldState(session);
    const { newState, commands } = reduceAbstractSession(state, event);

    // Apply new state (if different) via orchestrator
    if (newState !== state) {
      this.orchestrator.applyWorldState(newState);
    }

    // Execute commands via effect runtime
    executeCommands(commands, {
      orchestrator: this.orchestrator,
      agentManager: this.agentManager,
      store: this.store,
      ...(this.sseBroadcast !== undefined ? { sseBroadcast: this.sseBroadcast } : {}),
      resolveModelForChannel: this.resolveModelForChannel,
    });
  }

  // --- State transition methods ---

  /** Attempt a status transition. Returns true if the transition was valid and applied. */
  private transition(sessionId: string, to: AbstractSessionStatus): boolean {
    const session = this.orchestrator.getSessionStatuses()[sessionId];
    if (session === undefined) return false;
    const from = session.status;
    if (from === to) return true; // same-state transition is a no-op
    const allowed = VALID_TRANSITIONS[from];
    if (allowed === undefined || !allowed.includes(to)) {
      console.error(`[session-controller] rejected transition ${from} → ${to} for session ${sessionId.slice(0, 8)}`);
      return false;
    }
    this.orchestrator.updateSessionStatus(sessionId, to);
    this.broadcastStatusChange(sessionId, to);
    return true;
  }

  private broadcastStatusChange(sessionId: string, status: AbstractSessionStatus): void {
    if (this.sseBroadcast === undefined) return;
    const session = this.orchestrator.getSessionStatuses()[sessionId];
    if (session === undefined) return;
    const channelId = session.channelId;
    const hasPending = channelId !== undefined ? this.store.hasPending(channelId) : false;
    const derivedStatus = selectDerivedChannelStatus({ session, hasPending });
    const evt: { type: string; channelId?: string; data?: unknown } = {
      type: "session_status_change",
      data: { sessionId, status, derivedStatus },
    };
    if (channelId !== undefined) evt.channelId = channelId;
    this.sseBroadcast(evt);
  }

  // --- Per-session context management ---

  getContext(sessionId: string): SessionContext {
    let ctx = this.contexts.get(sessionId);
    if (ctx === undefined) {
      ctx = {
        pendingReplyExpected: false,
        reminderState: { needsReminder: false, lastReminderPercent: 0, currentUsagePercent: 0 },
      };
      this.contexts.set(sessionId, ctx);
    }
    return ctx;
  }

  clearContext(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  // --- Message delivery (single entry point) ---

  /**
   * The ONE entry point for all incoming messages.
   * Adds message to store, ensures a session is active, and notifies the agent.
   */
  async deliverMessage(channelId: string, sender: "user" | "agent" | "cron" | "system", message: string): Promise<{ msg: Message | undefined; delivery: DeliveryResult }> {
    const msg = this.store.addMessage(channelId, sender, message);
    if (msg === undefined) return { msg: undefined, delivery: "queued" };

    // Only user/cron/system messages trigger session lifecycle (agent messages don't)
    if (sender === "agent") return { msg, delivery: "delivered" };

    // Try to notify existing active session
    const sessionId = this.orchestrator.getSessionIdForChannel(channelId);
    if (sessionId !== undefined) {
      const session = this.orchestrator.getSessionStatuses()[sessionId];
      if (session !== undefined && this.isActive(session.status)) {
        this.agentManager.notifyAgent(sessionId);
        if (session.status === "waiting") {
          this.transition(sessionId, "notified");
        }
        return { msg, delivery: "delivered" };
      }
    }

    // No active session — start one
    await this.ensureSessionForChannel(channelId);
    return { msg, delivery: "session-started" };
  }

  private isActive(status: AbstractSessionStatus): boolean {
    return status !== "suspended" && status !== "idle" && status !== "new";
  }

  // --- Session lifecycle ---

  /** Ensure a session exists and is starting for a channel. */
  async ensureSessionForChannel(channelId: string): Promise<void> {
    if (this.orchestrator.isChannelInBackoff(channelId)) return;
    if (this.orchestrator.hasActiveSessionForChannel(channelId)) return;

    const sessionId = this.orchestrator.startSession(channelId);
    const session = this.orchestrator.getSessionStatuses()[sessionId];

    // Ensure we're in "starting" state (orchestrator.startSession sets "starting" for revived
    // sessions but "new" for brand-new ones)
    if (session?.status === "new") {
      this.transition(sessionId, "starting");
    }

    let resolvedModel: string | undefined;
    try {
      resolvedModel = await this.resolveModelForChannel(channelId);
    } catch { /* agent fallback */ }

    console.error(`[session-controller] starting physical session for channel ${channelId.slice(0, 8)}, session=${sessionId.slice(0, 8)}, model=${resolvedModel ?? "(agent-fallback)"}`);
    this.agentManager.startPhysicalSession(sessionId, session?.physicalSessionId, resolvedModel);
  }

  /** Called when agent reports physical session started. */
  onPhysicalSessionStarted(sessionId: string, physicalSessionId: string, model: string): void {
    console.error(`[session-controller] physical session started: session=${sessionId.slice(0, 8)}, physicalSession=${physicalSessionId.slice(0, 12)}, model=${model}`);
    // Route through reducer: PhysicalSessionStarted event handles the full transition
    // (updates physicalSession, hasHadPhysicalSession, transitions to waiting, persists, broadcasts)
    this.dispatchEvent(sessionId, { type: "PhysicalSessionStarted", physicalSessionId, model });
  }

  /** Called when agent reports physical session ended. */
  onPhysicalSessionEnded(sessionId: string, reason: string, elapsedMs: number, error?: string): void {
    console.error(`[session-controller] physical session ended: session=${sessionId.slice(0, 8)}, reason=${reason}, elapsed=${Math.round(elapsedMs / 1000)}s`);

    this.clearContext(sessionId);

    const endReason: import("./session-events.js").EndReason =
      reason === "idle" ? "idle" : reason === "aborted" ? "aborted" : "error";

    const session = this.orchestrator.getSession(sessionId);

    // Route through reducer: PhysicalSessionEnded event handles the full transition
    // (backoff, accumulate tokens, archive physical session, transition to idle/suspended,
    //  add system message, flush pending messages, persist, broadcast)
    this.dispatchEvent(sessionId, {
      type: "PhysicalSessionEnded",
      physicalSessionId: session?.physicalSessionId ?? "",
      reason: endReason,
      elapsedMs,
      ...(error !== undefined ? { error } : {}),
    });
  }

  /**
   * Called when agent drains messages (via copilotclaw_wait tool or drain_pending RPC).
   * Unified entry point for swallowed-message tracking.
   */
  onAgentDrainedMessages(sessionId: string, messages: Message[]): void {
    if (messages.length === 0) return;
    const ctx = this.getContext(sessionId);
    // Only expect reply when user messages were included
    const hasUserMessage = messages.some((m) => m.sender === "user");
    if (hasUserMessage) {
      ctx.pendingReplyExpected = true;
    }
  }

  /** Called when agent sends a reply via copilotclaw_send_message. */
  onAgentReplied(sessionId: string): void {
    const ctx = this.getContext(sessionId);
    ctx.pendingReplyExpected = false;
  }

  /** Check if swallowed-message guard should fire. Clears the flag. */
  checkSwallowedMessage(sessionId: string): boolean {
    const ctx = this.getContext(sessionId);
    if (ctx.pendingReplyExpected) {
      ctx.pendingReplyExpected = false;
      console.error(`[session-controller] swallowed message detected for session ${sessionId.slice(0, 8)}`);
      return true;
    }
    return false;
  }

  // --- Tool execution status tracking ---

  /** Called from onSessionEvent when a tool starts executing. */
  onToolExecutionStart(sessionId: string, toolName: string): void {
    // Route through reducer: ToolExecutionStarted event handles currentState update,
    // waitingOnWaitTool flag, and status transition (waiting → processing or → waiting for copilotclaw_wait)
    this.dispatchEvent(sessionId, { type: "ToolExecutionStarted", toolName });
  }

  /** Called from onSessionEvent when a tool finishes executing. */
  onToolExecutionComplete(sessionId: string): void {
    // Route through reducer: WaitToolCompleted clears waitingOnWaitTool and updates currentState
    this.dispatchEvent(sessionId, { type: "WaitToolCompleted" });
  }

  /** Called from onSessionEvent on session.idle. */
  onSessionIdle(sessionId: string, hasBackgroundTasks: boolean): void {
    // Route through reducer: IdleDetected event enforces wait/idle race prevention
    // (the reducer rejects the idle signal when waitingOnWaitTool=true or hasBackgroundTasks=true)
    const session = this.orchestrator.getSession(sessionId);
    if (session?.waitingOnWaitTool === true) {
      console.error(`[session-controller] session.idle received while waitingOnWaitTool=true for ${sessionId.slice(0, 8)}, ignoring idle transition`);
    }
    this.dispatchEvent(sessionId, { type: "IdleDetected", hasBackgroundTasks });
  }

  // --- Lifecycle decision ---

  /** Decide what the agent should do when the session goes idle. */
  decideLifecycleAction(_sessionId: string, event: string): { action: "stop" | "reinject" | "wait"; clearCopilotSessionId?: boolean } {
    if (event === "error") {
      return { action: "stop", clearCopilotSessionId: true };
    }

    // Agent-side session loop now handles backgroundTasks idle (v0.65.0):
    // it skips termination when backgroundTasks is present, so the session
    // continues running. If decideLifecycleAction is called, the session loop
    // has truly ended (either true idle or safety-net timeout). Always stop.
    return { action: "stop" };
  }

  // --- Explicit API operations ---

  stopSession(sessionId: string): void {
    this.clearContext(sessionId);
    // Route through reducer: StopRequested event handles stop + suspend + flush pending
    this.dispatchEvent(sessionId, { type: "StopRequested" });
  }

  /** End turn run: disconnect (not stop) the physical session.
   *  The SDK session is disconnected but physicalSessionId is preserved
   *  so that the next message can resumeSession with the same context. */
  idleSession(sessionId: string): void {
    this.clearContext(sessionId);
    // Disconnect physical session (preserve physicalSessionId for resume)
    this.agentManager.disconnectPhysicalSession(sessionId);
    // Directly idle the orchestrator session (end-turn-run API path —
    // we use the legacy idleSession method which handles token accumulation)
    this.orchestrator.idleSession(sessionId);
    this.broadcastStatusChange(sessionId, "idle");
  }

  // --- Reconciliation ---

  onReconcile(runningSessions: Array<{ sessionId: string; status: string }>): void {
    this.orchestrator.reconcileWithAgent(runningSessions);
    // After reconciliation, check for pending messages
    this.checkAllChannelsPending();
  }

  onStreamDisconnected(): void {
    this.orchestrator.idleAllActive();
  }

  /** Safety net: check all channels for pending messages and start sessions. */
  checkAllChannelsPending(): void {
    const channels = this.store.listChannels();
    for (const channel of channels) {
      if (this.orchestrator.hasActiveSessionForChannel(channel.id)) continue;
      if (this.orchestrator.isChannelInBackoff(channel.id)) continue;
      const oldest = this.store.peekOldestPending(channel.id);
      if (oldest !== undefined) {
        console.error(`[session-controller] pending message found for channel ${channel.id.slice(0, 8)}, starting session`);
        this.ensureSessionForChannel(channel.id).catch((err: unknown) => {
          console.error(`[session-controller] failed to start session for channel ${channel.id.slice(0, 8)}:`, err);
        });
      }
    }
  }

  /** Check session max age and stop if exceeded. */
  checkSessionMaxAge(maxAgeMs: number): void {
    const sessions = this.orchestrator.getSessionStatuses();
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session.status === "suspended") continue;
      if (this.orchestrator.checkSessionMaxAge(sessionId, maxAgeMs)) {
        console.error(`[session-controller] session ${sessionId.slice(0, 8)} exceeded max age, stopping`);
        this.clearContext(sessionId);
        // Route through reducer: MaxAgeExceeded event handles stop + suspend
        this.dispatchEvent(sessionId, { type: "MaxAgeExceeded" });
      }
    }
  }

  // --- Observability delegation methods ---
  // These route through the reducer so all state mutation goes through a single path.

  /** Delegate: update physical session token usage from session.usage_info events. */
  onUsageInfo(sessionId: string, currentTokens: number, tokenLimit: number): void {
    this.dispatchEvent(sessionId, { type: "TokensAccumulated", currentTokens, tokenLimit });
  }

  /** Delegate: accumulate assistant.usage tokens on the physical session. */
  onAssistantUsage(sessionId: string, inputTokens: number, outputTokens: number, quotaSnapshots?: Record<string, unknown>): void {
    this.dispatchEvent(sessionId, {
      type: "UsageUpdated",
      inputTokens,
      outputTokens,
      ...(quotaSnapshots !== undefined ? { quotaSnapshots } : {}),
    });
  }

  /** Delegate: update model on physical session from model_change events. */
  onModelChange(sessionId: string, newModel: string): void {
    this.dispatchEvent(sessionId, { type: "ModelResolved", model: newModel });
  }

  /** Delegate: track a subagent session start. */
  onSubagentStarted(sessionId: string, info: import("./ipc-client.js").SubagentInfo): void {
    this.dispatchEvent(sessionId, { type: "SubagentStarted", info });
  }

  /** Delegate: update a subagent session status. */
  onSubagentStatusChanged(sessionId: string, toolCallId: string, status: "completed" | "failed"): void {
    this.dispatchEvent(sessionId, { type: "SubagentStatusChanged", toolCallId, status });
  }

  // --- Accessors for daemon.ts wiring ---

  getOrchestrator(): SessionOrchestrator {
    return this.orchestrator;
  }
}
