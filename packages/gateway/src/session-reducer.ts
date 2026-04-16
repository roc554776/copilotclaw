/**
 * Pure reducer for the AbstractSession subsystem.
 *
 * Contract:
 *   reduceAbstractSession(state, event) → { newState, commands }
 *
 * This function has NO side effects. It never calls external I/O, timers, or Promises.
 * All side effects are expressed as AbstractSessionCommand values returned in `commands`.
 * The effect runtime (effect-runtime.ts) is responsible for executing them.
 *
 * See docs/proposals/state-management-architecture.md for the full design intent.
 */

import type {
  AbstractSessionWorldState,
  AbstractSessionEvent,
  AbstractSessionCommand,
  AbstractSessionStatus,
} from "./session-events.js";
import type { PhysicalSessionSummary } from "./ipc-client.js";

// ── Valid transitions table ───────────────────────────────────────────────────

/**
 * Valid state transitions for AbstractSession.
 * The reducer enforces this table — any transition not listed here is a no-op.
 */
const VALID_TRANSITIONS: Record<AbstractSessionStatus, AbstractSessionStatus[]> = {
  new: ["starting", "idle", "suspended"],
  starting: ["waiting", "idle", "suspended"],
  waiting: ["notified", "processing", "idle", "suspended"],
  notified: ["processing", "idle", "suspended"],
  processing: ["waiting", "idle", "suspended"],
  idle: ["starting", "suspended"],
  suspended: ["starting"],
};

function canTransition(from: AbstractSessionStatus, to: AbstractSessionStatus): boolean {
  if (from === to) return false; // same-state is handled as no-op at call sites
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Reducer output type ───────────────────────────────────────────────────────

export interface ReducerResult {
  newState: AbstractSessionWorldState;
  commands: AbstractSessionCommand[];
}

// ── Helper: apply status transition ──────────────────────────────────────────

/**
 * Attempt to transition to `to`. Returns new state with updated status and
 * processingStartedAt if allowed, or original state if the transition is invalid.
 * Also emits PersistSession + BroadcastStatusChange commands when transition succeeds.
 */
function applyTransition(
  state: AbstractSessionWorldState,
  to: AbstractSessionStatus,
  extraCommands: AbstractSessionCommand[] = [],
): ReducerResult {
  if (!canTransition(state.status, to)) {
    return { newState: state, commands: [] };
  }

  const newState: AbstractSessionWorldState = {
    ...state,
    status: to,
    processingStartedAt: to === "processing" ? new Date().toISOString() : undefined,
  };

  const commands: AbstractSessionCommand[] = [
    { type: "PersistSession", state: newState },
    { type: "BroadcastStatusChange", sessionId: state.sessionId, status: to },
    ...extraCommands,
  ];
  return { newState, commands };
}

// ── Helper: accumulate tokens on physical session ─────────────────────────────

function accumulateAndArchivePhysicalSession(
  state: AbstractSessionWorldState,
): AbstractSessionWorldState {
  if (state.physicalSession === undefined) return state;
  return {
    ...state,
    cumulativeInputTokens: state.cumulativeInputTokens + (state.physicalSession.totalInputTokens ?? 0),
    cumulativeOutputTokens: state.cumulativeOutputTokens + (state.physicalSession.totalOutputTokens ?? 0),
    physicalSessionHistory: [...state.physicalSessionHistory, { ...state.physicalSession }],
    physicalSession: undefined,
  };
}

// ── Main reducer ─────────────────────────────────────────────────────────────

/**
 * Pure state transition function for the AbstractSession subsystem.
 * No side effects — returns newState and commands to execute.
 */
export function reduceAbstractSession(
  state: AbstractSessionWorldState,
  event: AbstractSessionEvent,
): ReducerResult {
  switch (event.type) {
    // ── Physical session lifecycle ─────────────────────────────────────────

    case "PhysicalSessionStarted": {
      const physicalSession: PhysicalSessionSummary = {
        sessionId: event.physicalSessionId,
        model: event.model,
        startedAt: new Date().toISOString(),
        currentState: "idle",
      };
      const newState: AbstractSessionWorldState = {
        ...state,
        physicalSessionId: event.physicalSessionId,
        physicalSession,
        hasHadPhysicalSession: true,
      };
      return applyTransition(newState, "waiting");
    }

    case "PhysicalSessionEnded": {
      // Update currentState to "stopped" on the physical session before archiving
      const updatedPhysSession = state.physicalSession !== undefined
        ? { ...state.physicalSession, currentState: "stopped" }
        : undefined;
      const stateWithUpdated: AbstractSessionWorldState = {
        ...state,
        physicalSession: updatedPhysSession,
      };

      if (event.reason === "idle") {
        // Clean idle end — transition to idle
        if (state.status === "idle" || state.status === "suspended") {
          // Already transitioned (e.g., via API end-turn-run) — no-op
          return { newState: state, commands: [] };
        }

        let accumulated = accumulateAndArchivePhysicalSession(stateWithUpdated);
        // Restore a zero-token visible reference for UI display
        if (updatedPhysSession !== undefined) {
          accumulated = {
            ...accumulated,
            physicalSession: { ...updatedPhysSession, totalInputTokens: 0, totalOutputTokens: 0, currentState: "stopped" },
          };
        }
        const withCleanup: AbstractSessionWorldState = {
          ...accumulated,
          subagentSessions: undefined,
          processingStartedAt: undefined,
          waitingOnWaitTool: false,
        };
        return applyTransition(withCleanup, "idle");
      } else {
        // Error or aborted — transition to suspended
        if (state.status === "idle" || state.status === "suspended") {
          return { newState: state, commands: [] };
        }

        let accumulated = accumulateAndArchivePhysicalSession(stateWithUpdated);
        const withCleanup: AbstractSessionWorldState = {
          ...accumulated,
          subagentSessions: undefined,
          processingStartedAt: undefined,
          waitingOnWaitTool: false,
        };

        const extraCommands: AbstractSessionCommand[] = [];

        // Backoff on rapid failure for error (not aborted)
        if (event.reason === "error" && state.channelId !== undefined && event.elapsedMs < 30_000) {
          extraCommands.push({ type: "RecordBackoff", channelId: state.channelId, durationMs: 60_000 });
        }

        // System message for unexpected stops
        if (state.channelId !== undefined && event.reason === "error") {
          const detail = event.error !== undefined ? `: ${event.error}` : "";
          extraCommands.push({
            type: "AddSystemMessage",
            channelId: state.channelId,
            message: `[SYSTEM] Agent session stopped unexpectedly${detail}. A new session will start when you send a message.`,
          });
        }

        // Flush pending messages
        if (state.channelId !== undefined) {
          extraCommands.push({ type: "FlushPendingMessages", channelId: state.channelId });
        }

        return applyTransition(withCleanup, "suspended", extraCommands);
      }
    }

    // ── Tool execution ─────────────────────────────────────────────────────

    case "ToolExecutionStarted": {
      // Update physical session currentState
      const newCurrentState = `tool:${event.toolName}`;
      const updatedPhysSession = state.physicalSession !== undefined
        ? { ...state.physicalSession, currentState: newCurrentState }
        : undefined;
      const updatedState: AbstractSessionWorldState = {
        ...state,
        physicalSession: updatedPhysSession,
      };

      if (event.toolName === "copilotclaw_wait") {
        // copilotclaw_wait: set waitingOnWaitTool flag and transition to waiting
        const flaggedState: AbstractSessionWorldState = {
          ...updatedState,
          waitingOnWaitTool: true,
        };
        return applyTransition(flaggedState, "waiting");
      } else {
        return applyTransition(updatedState, "processing");
      }
    }

    // ── Idle detection ─────────────────────────────────────────────────────

    case "IdleDetected": {
      if (event.hasBackgroundTasks) {
        // Subagent stopped but session is still alive — don't go idle
        return { newState: state, commands: [] };
      }
      if (state.waitingOnWaitTool) {
        // copilotclaw_wait is active — reject idle transition
        return { newState: state, commands: [] };
      }
      // Update physical session currentState to "idle"
      const updatedPhysSession = state.physicalSession !== undefined
        ? { ...state.physicalSession, currentState: "idle" }
        : undefined;
      const updatedState: AbstractSessionWorldState = { ...state, physicalSession: updatedPhysSession };
      // Don't transition status here — idle detection doesn't change abstract status
      // (the abstract session stays in current status; it's the physical session that went idle)
      // The actual abstract idle transition comes from PhysicalSessionEnded(reason="idle")
      return { newState: updatedState, commands: [] };
    }

    // ── Wait tool flag management ──────────────────────────────────────────

    case "WaitToolCalled": {
      // Set waitingOnWaitTool flag (transition is handled by ToolExecutionStarted for copilotclaw_wait)
      const newState: AbstractSessionWorldState = { ...state, waitingOnWaitTool: true };
      return { newState, commands: [] };
    }

    case "WaitToolCompleted": {
      // Clear the flag; update physical session currentState
      const updatedPhysSession = state.physicalSession !== undefined
        ? { ...state.physicalSession, currentState: "idle" }
        : undefined;
      const newState: AbstractSessionWorldState = {
        ...state,
        waitingOnWaitTool: false,
        physicalSession: updatedPhysSession,
      };
      return { newState, commands: [] };
    }

    // ── Message delivery ───────────────────────────────────────────────────

    case "MessageDelivered": {
      // Active session: notify agent (and transition waiting → notified if applicable)
      const isActive = state.status !== "suspended" && state.status !== "idle" && state.status !== "new";
      if (isActive) {
        const commands: AbstractSessionCommand[] = [
          { type: "NotifyAgent", sessionId: state.sessionId },
        ];
        if (state.status === "waiting") {
          // Transition waiting → notified
          const newState: AbstractSessionWorldState = {
            ...state,
            status: "notified",
          };
          return {
            newState,
            commands: [
              { type: "PersistSession", state: newState },
              { type: "BroadcastStatusChange", sessionId: state.sessionId, status: "notified" },
              ...commands,
            ],
          };
        }
        return { newState: state, commands };
      }

      // No active session — this event signals a session should start
      // The caller (effect runtime / SessionController) is responsible for initiating
      return { newState: state, commands: [] };
    }

    // ── Explicit lifecycle controls ────────────────────────────────────────

    case "ReviveRequested": {
      if (state.status !== "suspended" && state.status !== "idle" && state.status !== "new") {
        // Already active — no-op
        return { newState: state, commands: [] };
      }
      return applyTransition(state, "starting");
    }

    case "StopRequested": {
      // new, starting, suspended → noop
      if (state.status === "new" || state.status === "starting" || state.status === "suspended") {
        return { newState: state, commands: [] };
      }

      let accumulated = state;
      if (state.physicalSession !== undefined && state.status !== "idle") {
        accumulated = accumulateAndArchivePhysicalSession(state);
      } else if (state.status === "idle" && state.physicalSession !== undefined) {
        // idle: physicalSession already archived; just clear the reference
        accumulated = { ...state, physicalSession: undefined };
      }

      const withCleanup: AbstractSessionWorldState = {
        ...accumulated,
        subagentSessions: undefined,
        processingStartedAt: undefined,
        waitingOnWaitTool: false,
      };

      const extraCommands: AbstractSessionCommand[] = [
        { type: "StopPhysicalSession", sessionId: state.sessionId },
      ];

      if (state.channelId !== undefined) {
        extraCommands.push({ type: "FlushPendingMessages", channelId: state.channelId });
      }

      return applyTransition(withCleanup, "suspended", extraCommands);
    }

    case "MaxAgeExceeded": {
      const isActive = state.status !== "suspended" && state.status !== "idle" && state.status !== "new";
      if (!isActive) return { newState: state, commands: [] };

      let accumulated = accumulateAndArchivePhysicalSession(state);
      const withCleanup: AbstractSessionWorldState = {
        ...accumulated,
        subagentSessions: undefined,
        processingStartedAt: undefined,
        waitingOnWaitTool: false,
      };

      return applyTransition(withCleanup, "suspended", [
        { type: "StopPhysicalSession", sessionId: state.sessionId },
      ]);
    }

    case "KeepaliveTimedOut": {
      // Only valid in waiting status (intentional constraint — see proposal)
      if (state.status !== "waiting") return { newState: state, commands: [] };

      const withCleanup: AbstractSessionWorldState = {
        ...state,
        waitingOnWaitTool: false,
      };

      return applyTransition(withCleanup, "suspended", [
        { type: "StopPhysicalSession", sessionId: state.sessionId },
      ]);
    }

    case "MessagesDrained": {
      // MessagesDrained is a lifecycle event — no status transition needed for AbstractSession
      // The abstract session's updatedAt would be changed here in a fuller implementation
      return { newState: state, commands: [] };
    }

    // ── Reconciliation ─────────────────────────────────────────────────────

    case "PhysicalSessionAliveConfirmed": {
      // No-op — current status is maintained
      return { newState: state, commands: [] };
    }

    case "PhysicalSessionAliveRefuted": {
      // Physical session is gone — transition to suspended
      if (state.status === "suspended" || state.status === "idle" || state.status === "new") {
        return { newState: state, commands: [] };
      }

      let accumulated = accumulateAndArchivePhysicalSession(state);
      const withCleanup: AbstractSessionWorldState = {
        ...accumulated,
        subagentSessions: undefined,
        processingStartedAt: undefined,
        waitingOnWaitTool: false,
      };

      return applyTransition(withCleanup, "suspended");
    }

    // ── Observability events (no status transition) ────────────────────────

    case "UsageUpdated": {
      if (state.physicalSession === undefined) return { newState: state, commands: [] };
      const ps = state.physicalSession;
      const newPs: PhysicalSessionSummary = {
        ...ps,
        totalInputTokens: (ps.totalInputTokens ?? 0) + event.inputTokens,
        totalOutputTokens: (ps.totalOutputTokens ?? 0) + event.outputTokens,
        ...(event.quotaSnapshots !== undefined ? { latestQuotaSnapshots: event.quotaSnapshots } : {}),
      };
      return { newState: { ...state, physicalSession: newPs }, commands: [] };
    }

    case "TokensAccumulated": {
      if (state.physicalSession === undefined) return { newState: state, commands: [] };
      const newPs: PhysicalSessionSummary = {
        ...state.physicalSession,
        currentTokens: event.currentTokens,
        tokenLimit: event.tokenLimit,
      };
      return { newState: { ...state, physicalSession: newPs }, commands: [] };
    }

    case "ModelResolved": {
      if (state.physicalSession === undefined) return { newState: state, commands: [] };
      const newPs: PhysicalSessionSummary = {
        ...state.physicalSession,
        model: event.model,
      };
      return { newState: { ...state, physicalSession: newPs }, commands: [] };
    }

    case "PhysicalSessionStateUpdated": {
      if (state.physicalSession === undefined) return { newState: state, commands: [] };
      const newPs: PhysicalSessionSummary = {
        ...state.physicalSession,
        currentState: event.currentState,
      };
      return { newState: { ...state, physicalSession: newPs }, commands: [] };
    }

    case "SubagentStarted": {
      const existing = state.subagentSessions ?? [];
      let updated = [...existing, event.info];
      // Cap at 50 entries
      if (updated.length > 50) {
        updated = updated.slice(updated.length - 50);
      }
      return { newState: { ...state, subagentSessions: updated }, commands: [] };
    }

    case "SubagentStatusChanged": {
      if (state.subagentSessions === undefined) return { newState: state, commands: [] };
      const updated = state.subagentSessions.map((s) =>
        s.toolCallId === event.toolCallId ? { ...s, status: event.status } : s,
      );
      return { newState: { ...state, subagentSessions: updated }, commands: [] };
    }
  }
}
