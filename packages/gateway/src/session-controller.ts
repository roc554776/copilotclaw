/**
 * SessionController: centralizes session lifecycle transitions and message delivery.
 *
 * Replaces the scattered status modifications across daemon.ts/server.ts/session-orchestrator.ts
 * with a single owner that enforces valid state transitions.
 *
 * All session status changes MUST go through this controller — direct calls to
 * orchestrator.updateSessionStatus() from outside this class are prohibited.
 */

import type { AgentManager } from "./agent-manager.js";
import type { SessionOrchestrator, AbstractSessionStatus } from "./session-orchestrator.js";
import type { Store, Message } from "./store.js";
import { selectDerivedChannelStatus } from "./channel-status-selector.js";

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
  private reconciled = false;

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
    this.agentManager.startPhysicalSession(sessionId, session?.copilotSessionId, resolvedModel);
  }

  /** Called when agent reports physical session started. */
  onPhysicalSessionStarted(sessionId: string, copilotSessionId: string, model: string): void {
    console.error(`[session-controller] physical session started: session=${sessionId.slice(0, 8)}, copilot=${copilotSessionId.slice(0, 12)}, model=${model}`);
    this.transition(sessionId, "waiting");
    this.orchestrator.updatePhysicalSession(sessionId, {
      sessionId: copilotSessionId,
      model,
      startedAt: new Date().toISOString(),
      currentState: "idle",
    });
  }

  /** Called when agent reports physical session ended. */
  onPhysicalSessionEnded(sessionId: string, reason: string, elapsedMs: number, error?: string): void {
    console.error(`[session-controller] physical session ended: session=${sessionId.slice(0, 8)}, reason=${reason}, elapsed=${Math.round(elapsedMs / 1000)}s`);

    this.clearContext(sessionId);

    const session = this.orchestrator.getSessionStatuses()[sessionId];
    const channelId = session?.channelId;

    // Backoff for rapid failure (only on error/abort, not clean idle)
    if (channelId !== undefined && reason !== "idle" && elapsedMs < 30_000) {
      this.orchestrator.recordBackoff(channelId, 60_000);
      console.error(`[session-controller] channel ${channelId.slice(0, 8)} entering 60s backoff after rapid failure (${elapsedMs}ms)`);
    }

    this.orchestrator.updatePhysicalSessionState(sessionId, "stopped");

    // Skip if API already transitioned (end-turn-run → idle, stop → suspended)
    if (session?.status === "idle" || session?.status === "suspended") {
      // no-op — broadcast already happened via the API path
    } else if (reason === "idle") {
      this.orchestrator.idleSession(sessionId);
      this.broadcastStatusChange(sessionId, "idle");
    } else {
      this.orchestrator.suspendSession(sessionId);
      this.broadcastStatusChange(sessionId, "suspended");
      if (channelId !== undefined) {
        const detail = error !== undefined ? `: ${error}` : "";
        this.store.addMessage(channelId, "system", `[SYSTEM] Agent session stopped unexpectedly${detail}. A new session will start when you send a message.`);
      }
    }

    // Flush pending messages (state reset). Safe because deliverMessage will
    // immediately start a new session if a new message arrives.
    if (channelId !== undefined) {
      const flushed = this.store.flushPending(channelId);
      if (flushed > 0) {
        console.error(`[session-controller] flushed ${flushed} pending message(s) for channel ${channelId.slice(0, 8)}`);
      }
    }
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
    this.orchestrator.updatePhysicalSessionState(sessionId, `tool:${toolName}`);
    if (toolName === "copilotclaw_wait") {
      this.transition(sessionId, "waiting");
    } else {
      this.transition(sessionId, "processing");
    }
  }

  /** Called from onSessionEvent when a tool finishes executing. */
  onToolExecutionComplete(sessionId: string): void {
    this.orchestrator.updatePhysicalSessionState(sessionId, "idle");
  }

  /** Called from onSessionEvent on session.idle. */
  onSessionIdle(sessionId: string, hasBackgroundTasks: boolean): void {
    if (!hasBackgroundTasks) {
      // True idle — update physical state. backgroundTasks idle means a subagent
      // stopped but the session is still running, so physical state stays as-is.
      this.orchestrator.updatePhysicalSessionState(sessionId, "idle");
    }
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
    this.agentManager.stopPhysicalSession(sessionId);
    this.transition(sessionId, "suspended");
    this.clearContext(sessionId);
  }

  /** End turn run: disconnect (not stop) the physical session.
   *  The SDK session is disconnected but copilotSessionId is preserved
   *  so that the next message can resumeSession with the same context. */
  idleSession(sessionId: string): void {
    this.agentManager.disconnectPhysicalSession(sessionId);
    this.orchestrator.idleSession(sessionId);
    this.clearContext(sessionId);
    this.broadcastStatusChange(sessionId, "idle");
  }

  // --- Reconciliation ---

  onReconcile(runningSessions: Array<{ sessionId: string; status: string }>): void {
    this.orchestrator.reconcileWithAgent(runningSessions);
    this.reconciled = true;
    // After reconciliation, check for pending messages
    this.checkAllChannelsPending();
  }

  onStreamDisconnected(): void {
    this.orchestrator.idleAllActive();
    this.reconciled = false;
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
        this.stopSession(sessionId);
      }
    }
  }

  // --- Accessors for daemon.ts wiring ---

  getOrchestrator(): SessionOrchestrator {
    return this.orchestrator;
  }

  isReconciled(): boolean {
    return this.reconciled;
  }
}
