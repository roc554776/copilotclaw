/**
 * Pure reducer for the Channel subsystem (gateway side).
 *
 * Contract:
 *   reduceChannel(state, event) → { newState, commands }
 *
 * No side effects. All side effects are expressed as ChannelCommand values.
 *
 * See docs/proposals/state-management-architecture.md "Gateway: Channel subsystem".
 */

import type {
  ChannelWorldState,
  ChannelEvent,
  ChannelReducerResult,
  BackoffState,
} from "./channel-events.js";

// Exponential backoff: each failure doubles the duration (capped at 5 minutes).
function computeNextRetryAt(failureCount: number, baseDurationMs: number): number {
  const capped = Math.min(baseDurationMs * Math.pow(2, failureCount), 5 * 60 * 1000);
  return Date.now() + capped;
}

/**
 * Pure state transition function for the Channel subsystem.
 */
export function reduceChannel(
  state: ChannelWorldState,
  event: ChannelEvent,
): ChannelReducerResult {
  switch (event.type) {
    case "MessagePosted": {
      // Archived channels silently drop messages (no commands)
      if (state.archivedAt !== undefined) {
        return { newState: state, commands: [] };
      }
      // Clear draft on message post (proposal: "MessagePosted 受信後は draft を undefined にリセット")
      if (state.draft !== undefined) {
        const newState: ChannelWorldState = { ...state, draft: undefined };
        return {
          newState,
          commands: [{ type: "PersistDraft", channelId: state.channelId, draft: undefined }],
        };
      }
      return { newState: state, commands: [] };
    }

    case "Archived": {
      if (state.archivedAt !== undefined) {
        return { newState: state, commands: [] };
      }
      return {
        newState: { ...state, archivedAt: Date.now() },
        commands: [],
      };
    }

    case "Unarchived": {
      if (state.archivedAt === undefined) {
        return { newState: state, commands: [] };
      }
      return {
        newState: { ...state, archivedAt: undefined },
        commands: [],
      };
    }

    case "DefaultModelSet": {
      return {
        newState: { ...state, model: event.model },
        commands: [],
      };
    }

    case "DraftUpdated": {
      const newState: ChannelWorldState = { ...state, draft: event.draft };
      return {
        newState,
        commands: [{ type: "PersistDraft", channelId: state.channelId, draft: event.draft }],
      };
    }

    case "SessionStartFailed": {
      const failureCount = (state.backoff?.failureCount ?? 0) + 1;
      const newBackoff: BackoffState = {
        failureCount,
        nextRetryAt: computeNextRetryAt(failureCount - 1, event.backoffDurationMs),
        lastFailureReason: event.reason,
      };
      const newState: ChannelWorldState = { ...state, backoff: newBackoff };
      return {
        newState,
        commands: [{ type: "PersistBackoff", channelId: state.channelId, backoff: newBackoff }],
      };
    }

    case "BackoffReset": {
      if (state.backoff === undefined) {
        return { newState: state, commands: [] };
      }
      const newState: ChannelWorldState = { ...state, backoff: undefined };
      return {
        newState,
        commands: [{ type: "ClearBackoff", channelId: state.channelId }],
      };
    }
  }
}
