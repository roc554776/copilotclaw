/**
 * Event and command type definitions for the AbstractSession subsystem.
 *
 * These types define the finite set of inputs (events) and outputs (commands)
 * for the AbstractSession reducer. All state transitions go through the reducer;
 * side effects go through the effect runtime.
 *
 * See docs/proposals/state-management-architecture.md for the full design.
 */

import type { PhysicalSessionSummary, SubagentInfo } from "./ipc-client.js";

// ── World State ──────────────────────────────────────────────────────────────

export type AbstractSessionStatus =
  | "new"
  | "starting"
  | "waiting"
  | "notified"
  | "processing"
  | "idle"
  | "suspended";

/**
 * JSON-serializable world state for an AbstractSession.
 * This is the only part that should be persisted to SQLite.
 * Live process handles (SDK refs, AbortControllers, Promises) are NOT included here.
 */
export interface AbstractSessionWorldState {
  sessionId: string;
  channelId: string | undefined;
  status: AbstractSessionStatus;
  /** True when copilotclaw_wait is currently executing (drain not yet complete). */
  waitingOnWaitTool: boolean;
  /** True once at least one physical session has started on this abstract session. */
  hasHadPhysicalSession: boolean;
  /** Physical session ID used for resumeSession. Preserved across idle/suspend. */
  physicalSessionId: string | undefined;
  /** Current active physical session snapshot (display data). */
  physicalSession: PhysicalSessionSummary | undefined;
  /** Historical physical session snapshots (for dashboard display after stop). */
  physicalSessionHistory: PhysicalSessionSummary[];
  /** Cumulative input tokens across all physical sessions. */
  cumulativeInputTokens: number;
  /** Cumulative output tokens across all physical sessions. */
  cumulativeOutputTokens: number;
  /** Subagent tracking (resets on suspend). */
  subagentSessions: SubagentInfo[] | undefined;
  /** ISO timestamp of when session entered "processing" status. */
  processingStartedAt: string | undefined;
  /** ISO timestamp of when the abstract session was created. */
  startedAt: string;
}

// ── EndReason ─────────────────────────────────────────────────────────────────

/**
 * Reason a physical session ended.
 * - "idle": session loop completed normally (runSession resolved).
 * - "error": session loop threw an exception (runSession rejected).
 * - "aborted": explicit abort via AbortController (stopPhysicalSession / disconnectPhysicalSession).
 */
export type EndReason = "idle" | "error" | "aborted";

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * Discriminated union of all events that can drive AbstractSession state transitions.
 *
 * Design note: ToolExecutionCompleted is intentionally absent — the abstract session
 * does not need to track tool completion; it relies on IdleDetected or the next
 * ToolExecutionStarted event to implicitly close the previous tool execution.
 */
export type AbstractSessionEvent =
  // Lifecycle
  | { type: "PhysicalSessionStarted"; physicalSessionId: string; model: string }
  | { type: "PhysicalSessionEnded"; physicalSessionId: string; reason: EndReason; elapsedMs: number; error?: string }
  | { type: "ToolExecutionStarted"; toolName: string }
  | { type: "IdleDetected"; hasBackgroundTasks: boolean }
  | { type: "WaitToolCalled" }
  | { type: "WaitToolCompleted" }
  | { type: "MessageDelivered"; channelId: string; messageId: string }
  | { type: "ReviveRequested" }
  | { type: "StopRequested" }
  | { type: "MaxAgeExceeded" }
  | { type: "KeepaliveTimedOut" }
  | { type: "MessagesDrained"; messageIds: string[] }
  | { type: "PhysicalSessionAliveConfirmed" }
  | { type: "PhysicalSessionAliveRefuted" }
  | { type: "Reconcile"; targetStatus: AbstractSessionStatus }
  /** Fired when the ACK for startPhysicalSession does not arrive within the timeout.
   * Transitions the session from "starting" to "suspended" to prevent permanent stuck state.
   * See docs/proposals/state-management-architecture.md "startPhysicalSession ACK プロトコル". */
  | { type: "StartTimeout" }
  // Observability (no status transition, only field updates)
  | { type: "UsageUpdated"; inputTokens: number; outputTokens: number; quotaSnapshots?: Record<string, unknown> }
  | { type: "TokensAccumulated"; currentTokens: number; tokenLimit: number }
  | { type: "ModelResolved"; model: string }
  | { type: "PhysicalSessionStateUpdated"; currentState: string }
  | { type: "SubagentStarted"; info: SubagentInfo }
  | { type: "SubagentStatusChanged"; toolCallId: string; status: "completed" | "failed" };

// ── Commands ──────────────────────────────────────────────────────────────────

/**
 * Discriminated union of all commands the AbstractSession reducer can produce.
 * Commands represent intended side effects — the effect runtime executes them.
 * The reducer itself is a pure function and never executes side effects directly.
 */
export type AbstractSessionCommand =
  | { type: "StartPhysicalSession"; sessionId: string; physicalSessionId: string | undefined; model?: string }
  | { type: "StopPhysicalSession"; sessionId: string }
  | { type: "DisconnectPhysicalSession"; sessionId: string }
  | { type: "NotifyAgent"; sessionId: string }
  | { type: "PersistSession"; state: AbstractSessionWorldState }
  | { type: "BroadcastStatusChange"; sessionId: string; status: AbstractSessionStatus }
  | { type: "DrainPendingMessages"; sessionId: string; channelId: string }
  | { type: "FlushPendingMessages"; channelId: string }
  | { type: "AddSystemMessage"; channelId: string; message: string }
  | { type: "RecordBackoff"; channelId: string; durationMs: number };
