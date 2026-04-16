/**
 * Pure reducers for the IPC subsystems (agent side):
 * - reduceSendQueue: manages the outbound message queue
 * - reduceRpc: manages pending RPC requests
 * - reduceConfigPush: manages config push from gateway
 *
 * See docs/proposals/state-management-architecture.md for design intent.
 */

import type {
  SendQueueState,
  SendQueueEvent,
  SendQueueReducerResult,
  RpcState,
  RpcEvent,
  RpcReducerResult,
  ConfigPushState,
  ConfigPushEvent,
  ConfigPushReducerResult,
} from "./ipc-events.js";

// ── SendQueue reducer ─────────────────────────────────────────────────────────

/**
 * Pure state transition function for the SendQueue subsystem.
 */
export function reduceSendQueue(
  state: SendQueueState,
  event: SendQueueEvent,
): SendQueueReducerResult {
  switch (event.type) {
    case "MessageEnqueued": {
      const newMessages = [...state.messages, event.message];
      return {
        newState: { ...state, messages: newMessages },
        commands: [{ type: "PersistQueue", messages: newMessages }],
      };
    }

    case "FlushStarted": {
      if (state.flushInProgress) {
        return { newState: state, commands: [] };
      }
      const toFlush = state.messages.filter((m) =>
        typeof m["_queueId"] === "string" && event.batchIds.includes(m["_queueId"] as string),
      );
      if (toFlush.length === 0) {
        return { newState: state, commands: [] };
      }
      const newPendingAckIds = [
        ...state.pendingAckIds,
        ...event.batchIds.filter((id) => !state.pendingAckIds.includes(id)),
      ];
      return {
        newState: {
          ...state,
          messages: state.messages.filter((m) =>
            !event.batchIds.includes(m["_queueId"] as string),
          ),
          flushInProgress: true,
          pendingAckIds: newPendingAckIds,
        },
        commands: [{ type: "FlushBatch", messages: toFlush }],
      };
    }

    case "MessageAcknowledged": {
      const newPendingAckIds = state.pendingAckIds.filter((id) => id !== event.messageId);
      const newState: SendQueueState = {
        ...state,
        pendingAckIds: newPendingAckIds,
      };
      if (newPendingAckIds.length === 0) {
        return {
          newState,
          commands: [{ type: "ClearDisk" }],
        };
      }
      return { newState, commands: [] };
    }

    case "FlushCompleted": {
      return {
        newState: { ...state, flushInProgress: false },
        commands: [],
      };
    }

    case "ConnectionLost": {
      // Reset flush in progress; keep pendingAckIds for re-delivery on reconnect
      return {
        newState: { ...state, flushInProgress: false },
        commands: [],
      };
    }

    case "ConnectionRestored": {
      const allToFlush = [
        // Re-add pendingAck messages (they need resending since ACKs are lost)
        ...state.messages,
      ];
      if (allToFlush.length === 0 && state.pendingAckIds.length === 0) {
        return { newState: state, commands: [] };
      }
      return {
        newState: state,
        commands: allToFlush.length > 0 ? [{ type: "FlushBatch", messages: allToFlush }] : [],
      };
    }

    case "QueueOverflowed": {
      // Drop the oldest message and append the new one (queue-full eviction policy).
      const trimmed = state.messages.slice(1);
      const newMessages = [...trimmed, event.message];
      return {
        newState: { ...state, messages: newMessages },
        commands: [{ type: "PersistQueue", messages: newMessages }],
      };
    }

    case "LegacyFlushCompleted": {
      // Pre-ACK messages were flushed with no _queueId — clear state and disk immediately.
      return {
        newState: { ...state, messages: [], flushInProgress: false, pendingAckIds: [] },
        commands: [{ type: "ClearDisk" }],
      };
    }
  }
}

// ── RPC reducer ───────────────────────────────────────────────────────────────

/**
 * Pure state transition function for the RPC subsystem.
 */
export function reduceRpc(
  state: RpcState,
  event: RpcEvent,
): RpcReducerResult {
  switch (event.type) {
    case "RequestSent": {
      const newRequest = {
        requestId: event.requestId,
        method: event.method,
        payload: event.payload,
        sentAt: event.sentAt,
        timeoutMs: event.timeoutMs,
      };
      return {
        newState: {
          ...state,
          pendingRequests: [...state.pendingRequests, newRequest],
        },
        commands: [],
      };
    }

    case "ResponseReceived": {
      const exists = state.pendingRequests.some((r) => r.requestId === event.requestId);
      if (!exists) {
        return { newState: state, commands: [] };
      }
      return {
        newState: {
          ...state,
          pendingRequests: state.pendingRequests.filter((r) => r.requestId !== event.requestId),
        },
        commands: [],
      };
    }

    case "RequestTimedOut": {
      const exists = state.pendingRequests.some((r) => r.requestId === event.requestId);
      if (!exists) {
        return { newState: state, commands: [] };
      }
      return {
        newState: {
          ...state,
          pendingRequests: state.pendingRequests.filter((r) => r.requestId !== event.requestId),
        },
        commands: [{ type: "RejectRequest", requestId: event.requestId, error: "IPC stream request timed out" }],
      };
    }

    case "ConnectionLost": {
      const pending = [...state.pendingRequests];
      const rejectCommands = pending.map((r) => ({
        type: "RejectRequest" as const,
        requestId: r.requestId,
        error: "IPC stream disconnected",
      }));
      return {
        newState: {
          ...state,
          pendingRequests: [],
          connectionStatus: "disconnected" as const,
        },
        commands: rejectCommands,
      };
    }

    case "ConnectionRestored": {
      return {
        newState: {
          ...state,
          connectionStatus: "connected" as const,
        },
        commands: state.pendingRequests.length > 0
          ? [{ type: "ReplayPendingRequests", requests: state.pendingRequests }]
          : [],
      };
    }
  }
}

// ── ConfigPush reducer ────────────────────────────────────────────────────────

/**
 * Pure state transition function for the ConfigPush subsystem.
 */
export function reduceConfigPush(
  state: ConfigPushState,
  event: ConfigPushEvent,
): ConfigPushReducerResult {
  switch (event.type) {
    case "ConfigUpdated": {
      const newState: ConfigPushState = { ...state, config: event.config };
      // If agent is connected, push immediately (dynamic update)
      if (state.agentConnected && event.config !== undefined) {
        return {
          newState,
          commands: [{ type: "SendConfigToAgent", config: event.config }],
        };
      }
      return { newState, commands: [] };
    }

    case "AgentConnected": {
      const newState: ConfigPushState = { ...state, agentConnected: true };
      // Push current config to newly connected agent (initial push)
      if (state.config !== undefined) {
        return {
          newState,
          commands: [{ type: "SendConfigToAgent", config: state.config }],
        };
      }
      return { newState, commands: [] };
    }

    case "AgentDisconnected": {
      return {
        newState: { ...state, agentConnected: false },
        commands: [],
      };
    }

    case "PushCompleted": {
      return {
        newState: { ...state, lastPushedAt: event.pushedAt },
        commands: [],
      };
    }
  }
}
