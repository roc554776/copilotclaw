/**
 * Pure reducer for the PendingQueue subsystem (gateway side).
 *
 * Contract:
 *   reducePendingQueue(state, event) → { newState, commands }
 *
 * Unifies the two drain paths (copilotclaw_wait tool path and drain_pending IPC path)
 * under a single DrainStarted / DrainCompleted / DrainAcknowledged sequence.
 *
 * See docs/proposals/state-management-architecture.md "Gateway: PendingQueue subsystem".
 */

import type {
  PendingQueueState,
  PendingQueueEvent,
  PendingQueueReducerResult,
} from "./pending-queue-events.js";

/**
 * Pure state transition function for the PendingQueue subsystem.
 */
export function reducePendingQueue(
  state: PendingQueueState,
  event: PendingQueueEvent,
): PendingQueueReducerResult {
  switch (event.type) {
    case "MessageEnqueued": {
      // Avoid duplicate enqueue
      if (state.messages.some((m) => m.id === event.message.id)) {
        return { newState: state, commands: [] };
      }
      const newMessages = [...state.messages, event.message];
      return {
        newState: { ...state, messages: newMessages },
        commands: [{ type: "PersistQueue", channelId: state.channelId, messages: newMessages }],
      };
    }

    case "DrainStarted": {
      // Reject if drain already in progress
      if (state.drainInProgress) {
        return { newState: state, commands: [] };
      }
      if (state.messages.length === 0) {
        return { newState: state, commands: [] };
      }
      return {
        newState: { ...state, drainInProgress: true },
        commands: [
          { type: "DeliverMessages", channelId: state.channelId, messages: state.messages },
        ],
      };
    }

    case "DrainCompleted": {
      if (!state.drainInProgress) {
        return { newState: state, commands: [] };
      }
      const remaining = state.messages.filter((m) => !event.drainedIds.includes(m.id));
      const newState: PendingQueueState = {
        ...state,
        messages: remaining,
        drainInProgress: false,
        lastDrainedAt: Date.now(),
      };
      return {
        newState,
        commands: [
          { type: "PersistQueue", channelId: state.channelId, messages: remaining },
          { type: "SendAck", requestId: event.requestId },
        ],
      };
    }

    case "DrainAcknowledged": {
      // ACK received — no further state change needed (drain already completed)
      return { newState: state, commands: [] };
    }

    case "MessageFlushed": {
      const newMessages = state.messages.filter((m) => m.id !== event.messageId);
      return {
        newState: { ...state, messages: newMessages },
        commands: [{ type: "PersistQueue", channelId: state.channelId, messages: newMessages }],
      };
    }

    case "QueueFlushed": {
      if (state.messages.length === 0) {
        return { newState: state, commands: [] };
      }
      const newState: PendingQueueState = {
        ...state,
        messages: [],
        drainInProgress: false,
      };
      return {
        newState,
        commands: [{ type: "PersistQueue", channelId: state.channelId, messages: [] }],
      };
    }
  }
}
