/**
 * Effect runtime for the AbstractSession subsystem.
 *
 * Executes AbstractSessionCommand values produced by the reducer.
 * This is the ONLY place that performs side effects for AbstractSession state changes.
 *
 * Design principle: the reducer is pure; the effect runtime is impure. The runtime
 * maps each command type to a concrete side-effecting action on the external system.
 *
 * See docs/proposals/state-management-architecture.md for the full design intent.
 */

import type { AbstractSessionCommand, AbstractSessionWorldState } from "./session-events.js";
import type { SessionOrchestrator, AbstractSession } from "./session-orchestrator.js";
import type { AgentManager } from "./agent-manager.js";
import type { Store } from "./store.js";
import { selectDerivedChannelStatus } from "./channel-status-selector.js";

export interface EffectRuntimeDeps {
  orchestrator: SessionOrchestrator;
  agentManager: AgentManager;
  store: Store;
  sseBroadcast?: (event: { type: string; channelId?: string; data?: unknown }) => void;
  resolveModelForChannel?: (channelId: string) => Promise<string | undefined>;
}

/**
 * Execute a list of commands produced by the AbstractSession reducer.
 * Commands that require async operations are fire-and-forgotten where necessary
 * to maintain the synchronous nature of the reducer/runtime boundary.
 */
export function executeCommands(
  commands: AbstractSessionCommand[],
  deps: EffectRuntimeDeps,
): void {
  for (const cmd of commands) {
    executeCommand(cmd, deps);
  }
}

function executeCommand(
  cmd: AbstractSessionCommand,
  deps: EffectRuntimeDeps,
): void {
  switch (cmd.type) {
    case "PersistSession": {
      deps.orchestrator.applyWorldState(cmd.state);
      break;
    }

    case "BroadcastStatusChange": {
      if (deps.sseBroadcast === undefined) break;
      const session = deps.orchestrator.getSession(cmd.sessionId);
      if (session === undefined) break;
      const channelId = session.channelId;
      const hasPending = channelId !== undefined ? deps.store.hasPending(channelId) : false;
      const derivedStatus = selectDerivedChannelStatus({ session, hasPending });
      const evt: { type: string; channelId?: string; data?: unknown } = {
        type: "session_status_change",
        data: { sessionId: cmd.sessionId, status: cmd.status, derivedStatus },
      };
      if (channelId !== undefined) evt.channelId = channelId;
      deps.sseBroadcast(evt);
      break;
    }

    case "StartPhysicalSession": {
      // Resolve model asynchronously if needed
      if (deps.resolveModelForChannel !== undefined) {
        const session = deps.orchestrator.getSession(cmd.sessionId);
        const channelId = session?.channelId;
        if (channelId !== undefined) {
          deps.resolveModelForChannel(channelId)
            .then((model) => {
              deps.agentManager.startPhysicalSession(cmd.sessionId, cmd.physicalSessionId, model ?? cmd.model);
            })
            .catch(() => {
              deps.agentManager.startPhysicalSession(cmd.sessionId, cmd.physicalSessionId, cmd.model);
            });
        } else {
          deps.agentManager.startPhysicalSession(cmd.sessionId, cmd.physicalSessionId, cmd.model);
        }
      } else {
        deps.agentManager.startPhysicalSession(cmd.sessionId, cmd.physicalSessionId, cmd.model);
      }
      break;
    }

    case "StopPhysicalSession": {
      deps.agentManager.stopPhysicalSession(cmd.sessionId);
      break;
    }

    case "DisconnectPhysicalSession": {
      deps.agentManager.disconnectPhysicalSession(cmd.sessionId);
      break;
    }

    case "NotifyAgent": {
      deps.agentManager.notifyAgent(cmd.sessionId);
      break;
    }

    case "DrainPendingMessages": {
      // Drain is performed by the caller (copilotclaw_wait handler) — this command
      // is informational for the effect runtime layer.
      break;
    }

    case "FlushPendingMessages": {
      const flushed = deps.store.flushPending(cmd.channelId);
      if (flushed > 0) {
        console.error(`[effect-runtime] flushed ${flushed} pending message(s) for channel ${cmd.channelId.slice(0, 8)}`);
      }
      break;
    }

    case "AddSystemMessage": {
      deps.store.addMessage(cmd.channelId, "system", cmd.message);
      break;
    }

    case "RecordBackoff": {
      deps.orchestrator.recordBackoff(cmd.channelId, cmd.durationMs);
      console.error(`[effect-runtime] channel ${cmd.channelId.slice(0, 8)} entering ${cmd.durationMs / 1000}s backoff`);
      break;
    }
  }
}

/**
 * Convert an AbstractSessionWorldState to the legacy AbstractSession shape
 * expected by existing code. This bridge allows the new world state type to
 * coexist with the legacy orchestrator API during the transition period.
 */
export function worldStateToSession(state: AbstractSessionWorldState): AbstractSession {
  return {
    sessionId: state.sessionId,
    status: state.status,
    channelId: state.channelId,
    startedAt: state.startedAt,
    physicalSessionId: state.physicalSessionId,
    cumulativeInputTokens: state.cumulativeInputTokens,
    cumulativeOutputTokens: state.cumulativeOutputTokens,
    physicalSession: state.physicalSession,
    physicalSessionHistory: state.physicalSessionHistory,
    subagentSessions: state.subagentSessions,
    processingStartedAt: state.processingStartedAt,
    waitingOnWaitTool: state.waitingOnWaitTool,
    hasHadPhysicalSession: state.hasHadPhysicalSession,
  };
}

/**
 * Convert an AbstractSession (legacy shape) to AbstractSessionWorldState.
 * Used when reading from the orchestrator's in-memory map.
 */
export function sessionToWorldState(session: AbstractSession): AbstractSessionWorldState {
  return {
    sessionId: session.sessionId,
    channelId: session.channelId,
    status: session.status,
    waitingOnWaitTool: session.waitingOnWaitTool,
    hasHadPhysicalSession: session.hasHadPhysicalSession,
    physicalSessionId: session.physicalSessionId,
    physicalSession: session.physicalSession,
    physicalSessionHistory: session.physicalSessionHistory,
    cumulativeInputTokens: session.cumulativeInputTokens,
    cumulativeOutputTokens: session.cumulativeOutputTokens,
    subagentSessions: session.subagentSessions,
    processingStartedAt: session.processingStartedAt,
    startedAt: session.startedAt,
  };
}
