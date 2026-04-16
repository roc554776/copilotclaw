/**
 * Pure reducer for the PhysicalSession subsystem (agent side).
 *
 * Contract:
 *   reducePhysicalSession(state, event) → { newState, commands }
 *
 * This function has NO side effects. It never calls external I/O, timers, or Promises.
 * All side effects are expressed as PhysicalSessionCommand values returned in `commands`.
 * The effect runtime is responsible for executing them.
 *
 * See docs/proposals/state-management-architecture.md for the full design intent.
 */

import type {
  PhysicalSessionWorldState,
  PhysicalSessionEvent,
  PhysicalSessionCommand,
  PhysicalSessionStatus,
  CopilotClientWorldState,
  CopilotClientEvent,
  CopilotClientCommand,
} from "./session-events.js";

// ── Reducer output types ───────────────────────────────────────────────────────

export interface PhysicalSessionReducerResult {
  newState: PhysicalSessionWorldState;
  commands: PhysicalSessionCommand[];
}

export interface CopilotClientReducerResult {
  newState: CopilotClientWorldState;
  commands: CopilotClientCommand[];
}

// ── Valid transitions ─────────────────────────────────────────────────────────

const VALID_PHYSICAL_TRANSITIONS: Record<PhysicalSessionStatus, PhysicalSessionStatus[]> = {
  starting: ["waiting", "suspended", "stopped"],
  waiting: ["processing", "waiting_on_wait_tool", "reinject", "suspended", "stopped"],
  waiting_on_wait_tool: ["waiting", "reinject", "suspended", "stopped"],
  processing: ["waiting", "reinject", "suspended", "stopped"],
  reinject: ["waiting", "suspended", "stopped"],
  suspended: ["stopped"],
  stopped: [],
};

function canTransition(from: PhysicalSessionStatus, to: PhysicalSessionStatus): boolean {
  if (from === to) return false;
  return VALID_PHYSICAL_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Main reducer ──────────────────────────────────────────────────────────────

/**
 * Pure state transition function for the PhysicalSession subsystem.
 * No side effects — returns newState and commands to execute.
 */
export function reducePhysicalSession(
  state: PhysicalSessionWorldState,
  event: PhysicalSessionEvent,
): PhysicalSessionReducerResult {
  switch (event.type) {
    case "StartRequested": {
      // Only start from a clean slate (no active session in this slot)
      if (state.status !== "starting" && state.status !== "stopped" && state.status !== "suspended") {
        return { newState: state, commands: [] };
      }
      const newState: PhysicalSessionWorldState = {
        ...state,
        sessionId: event.sessionId,
        status: "starting",
        startedAt: new Date().toISOString(),
        resolvedModel: event.model,
        reinjectCount: 0,
        currentToolName: undefined,
        physicalSessionId: event.physicalSessionId,
      };

      const command: PhysicalSessionCommand = event.physicalSessionId !== undefined
        ? { type: "ResumeSession", sessionId: event.sessionId, physicalSessionId: event.physicalSessionId, model: event.model }
        : { type: "CreateSession", sessionId: event.sessionId, model: event.model };

      return { newState, commands: [command] };
    }

    case "SessionIdCleared": {
      return {
        newState: { ...state, physicalSessionId: undefined },
        commands: [],
      };
    }

    case "SessionCreated":
    case "SessionResumed": {
      const newState: PhysicalSessionWorldState = {
        ...state,
        physicalSessionId: event.physicalSessionId,
        status: "waiting",
      };
      return {
        newState,
        commands: [
          { type: "SetModel", sessionId: state.sessionId, model: state.resolvedModel ?? "gpt-4.1" },
          {
            type: "NotifyGatewayStarted",
            sessionId: state.sessionId,
            physicalSessionId: event.physicalSessionId,
            model: state.resolvedModel ?? "gpt-4.1",
          },
          { type: "RunSessionLoop", sessionId: state.sessionId },
        ],
      };
    }

    case "WaitToolCalled": {
      if (!canTransition(state.status, "waiting_on_wait_tool")) {
        return { newState: state, commands: [] };
      }
      return {
        newState: { ...state, status: "waiting_on_wait_tool", currentToolName: "copilotclaw_wait" },
        commands: [],
      };
    }

    case "WaitToolCompleted": {
      if (state.status !== "waiting_on_wait_tool") {
        return { newState: state, commands: [] };
      }
      return {
        newState: { ...state, status: "waiting", currentToolName: undefined },
        commands: [],
      };
    }

    case "ToolExecutionStarted": {
      if (!canTransition(state.status, "processing")) {
        return { newState: state, commands: [] };
      }
      return {
        newState: { ...state, status: "processing", currentToolName: event.toolName },
        commands: [],
      };
    }

    case "ToolExecutionCompleted": {
      if (state.status !== "processing") {
        return { newState: state, commands: [] };
      }
      return {
        newState: { ...state, status: "waiting", currentToolName: undefined },
        commands: [],
      };
    }

    case "IdleDetected": {
      // If waiting on wait tool, reject idle transition (wait/idle race prevention)
      if (state.status === "waiting_on_wait_tool") {
        return { newState: state, commands: [] };
      }
      // idle is handled via SessionEnded(reason="idle") in the lifecycle
      return { newState: state, commands: [] };
    }

    case "ReinjectDecided": {
      const newReinjectCount = state.reinjectCount + 1;
      const newState: PhysicalSessionWorldState = {
        ...state,
        status: "reinject",
        reinjectCount: newReinjectCount,
        currentToolName: undefined,
      };
      return {
        newState,
        commands: [{ type: "ReinjectSession", sessionId: state.sessionId }],
      };
    }

    case "StopRequested": {
      const newState: PhysicalSessionWorldState = {
        ...state,
        status: "suspended",
        currentToolName: undefined,
      };
      return {
        newState,
        commands: [
          { type: "AbortSession", sessionId: state.sessionId },
        ],
      };
    }

    case "DisconnectRequested": {
      const newState: PhysicalSessionWorldState = {
        ...state,
        status: "suspended",
        currentToolName: undefined,
      };
      return {
        newState,
        commands: [
          { type: "AbortSession", sessionId: state.sessionId },
          ...(state.physicalSessionId !== undefined
            ? [{ type: "DisconnectSession" as const, sessionId: state.sessionId }]
            : []),
        ],
      };
    }

    case "SessionEnded": {
      const newState: PhysicalSessionWorldState = {
        ...state,
        status: event.reason === "idle" ? "stopped" : "suspended",
        currentToolName: undefined,
      };
      return {
        newState,
        commands: [
          {
            type: "NotifyGatewayEnded",
            sessionId: state.sessionId,
            physicalSessionId: state.physicalSessionId ?? "",
            reason: event.reason,
            elapsedMs: 0, // Caller fills in actual elapsed time
          },
        ],
      };
    }

    case "ErrorOccurred": {
      const newState: PhysicalSessionWorldState = {
        ...state,
        status: "suspended",
        currentToolName: undefined,
      };
      return {
        newState,
        commands: [
          {
            type: "NotifyGatewayEnded",
            sessionId: state.sessionId,
            physicalSessionId: state.physicalSessionId ?? "",
            reason: "error",
            elapsedMs: 0,
            error: event.error,
          },
        ],
      };
    }
  }
}

// ── CopilotClient reducer ────────────────────────────────────────────────────

/**
 * Pure state transition function for the CopilotClient singleton subsystem.
 * Prevents double-start by only accepting StartRequested in "uninitialized" state.
 */
export function reduceCopilotClient(
  state: CopilotClientWorldState,
  event: CopilotClientEvent,
): CopilotClientReducerResult {
  switch (event.type) {
    case "StartRequested": {
      if (state.status !== "uninitialized") {
        // Already started or starting — no-op (double-start prevention)
        return { newState: state, commands: [] };
      }
      return {
        newState: { status: "starting" },
        commands: [{ type: "StartClient" }],
      };
    }

    case "StartCompleted": {
      if (state.status !== "starting") {
        return { newState: state, commands: [] };
      }
      return { newState: { status: "running" }, commands: [] };
    }

    case "StopRequested": {
      if (state.status !== "running") {
        return { newState: state, commands: [] };
      }
      return {
        newState: { status: "stopping" },
        commands: [{ type: "StopClient" }],
      };
    }

    case "StopCompleted": {
      return { newState: { status: "stopped" }, commands: [] };
    }

    case "ErrorOccurred": {
      return { newState: { status: "stopped" }, commands: [] };
    }
  }
}
