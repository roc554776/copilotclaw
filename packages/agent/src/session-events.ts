/**
 * Event and command type definitions for the PhysicalSession subsystem (agent side).
 *
 * These types define the finite set of inputs (events) and outputs (commands)
 * for the PhysicalSession reducer. All state transitions go through the reducer;
 * side effects go through the effect runtime.
 *
 * See docs/proposals/state-management-architecture.md for the full design.
 */

// ── World State ──────────────────────────────────────────────────────────────

/**
 * Physical session status as maintained by the agent.
 * Distinct from the gateway-side AbstractSessionStatus.
 */
export type PhysicalSessionStatus =
  | "starting"
  | "waiting"
  | "waiting_on_wait_tool"
  | "processing"
  | "reinject"
  | "suspended"
  | "stopped";

/**
 * JSON-serializable world state for a PhysicalSession.
 * No live process handles (SDK session refs, AbortControllers, Promises) here.
 */
export interface PhysicalSessionWorldState {
  /** Abstract session ID (opaque token assigned by gateway). */
  sessionId: string;
  /** Physical (Copilot SDK) session ID. Set after createSession/resumeSession. */
  physicalSessionId: string | undefined;
  status: PhysicalSessionStatus;
  startedAt: string | undefined;
  resolvedModel: string | undefined;
  reinjectCount: number;
  /** Name of the currently executing tool (undefined when idle). */
  currentToolName: string | undefined;
}

// ── EndReason ─────────────────────────────────────────────────────────────────

/**
 * Reason a physical session ended.
 * Matches the gateway-side EndReason for IPC compatibility.
 */
export type EndReason = "idle" | "error" | "aborted";

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * Discriminated union of all events that can drive PhysicalSession state transitions.
 *
 * Naming note: StopRequested appears in AbstractSessionEvent, PhysicalSessionEvent, and
 * CopilotClientEvent. TypeScript's type aliases keep them distinct — no renaming needed.
 */
export type PhysicalSessionEvent =
  | { type: "StartRequested"; sessionId: string; model: string; physicalSessionId: string | undefined }
  | { type: "SessionCreated"; physicalSessionId: string }
  | { type: "SessionResumed"; physicalSessionId: string }
  | { type: "WaitToolCalled" }
  | { type: "WaitToolCompleted" }
  | { type: "ToolExecutionStarted"; toolName: string }
  | { type: "ToolExecutionCompleted"; toolName: string }
  | { type: "IdleDetected" }
  | { type: "ReinjectDecided" }
  | { type: "StopRequested" }
  | { type: "DisconnectRequested" }
  | { type: "SessionEnded"; reason: EndReason }
  | { type: "ErrorOccurred"; error: string };

// ── Commands ──────────────────────────────────────────────────────────────────

/**
 * Discriminated union of all commands the PhysicalSession reducer can produce.
 * The effect runtime executes these — the reducer itself is a pure function.
 */
export type PhysicalSessionCommand =
  | { type: "CreateSession"; sessionId: string; model: string }
  | { type: "ResumeSession"; sessionId: string; physicalSessionId: string; model: string }
  | { type: "SetModel"; sessionId: string; model: string }
  | { type: "AbortSession"; sessionId: string }
  | { type: "DisconnectSession"; sessionId: string }
  | { type: "RunSessionLoop"; sessionId: string }
  | { type: "NotifyGatewayStarted"; sessionId: string; physicalSessionId: string; model: string }
  | { type: "NotifyGatewayEnded"; sessionId: string; physicalSessionId: string; reason: EndReason; elapsedMs: number; error?: string }
  | { type: "ReinjectSession"; sessionId: string };

// ── CopilotClient subsystem ───────────────────────────────────────────────────

export type CopilotClientStatus = "uninitialized" | "starting" | "running" | "stopping" | "stopped";

export interface CopilotClientWorldState {
  status: CopilotClientStatus;
}

/**
 * Events that drive CopilotClient singleton state transitions.
 */
export type CopilotClientEvent =
  | { type: "StartRequested" }
  | { type: "StartCompleted" }
  | { type: "StopRequested" }
  | { type: "StopCompleted" }
  | { type: "ErrorOccurred"; error: string };

export type CopilotClientCommand =
  | { type: "StartClient" }
  | { type: "StopClient" };
