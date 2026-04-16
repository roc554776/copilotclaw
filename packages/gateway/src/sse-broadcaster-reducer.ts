/**
 * Pure reducers for the SSE Broadcaster subsystem (gateway side).
 *
 * Two reducers:
 * - reduceChannelSse: manages per-channel replay buffers
 * - reduceGlobalSse: manages global replay buffer
 *
 * See docs/proposals/state-management-architecture.md "Gateway: SSE Broadcaster subsystem".
 */

import type {
  ChannelScopedSseState,
  ChannelScopedSseStatePerChannel,
  GlobalSseState,
  SseBroadcasterEvent,
  SseBroadcasterChannelReducerResult,
  SseBroadcasterGlobalReducerResult,
} from "./sse-broadcaster-events.js";
import { SSE_REPLAY_BUFFER_SIZE } from "./sse-broadcaster-events.js";

function appendToBuffer<T>(buffer: T[], item: T, maxSize: number): T[] {
  const next = [...buffer, item];
  if (next.length > maxSize) {
    return next.slice(next.length - maxSize);
  }
  return next;
}

/**
 * Reducer for channel-scoped SSE state (replay buffers per channel).
 */
export function reduceChannelSse(
  state: ChannelScopedSseState,
  event: SseBroadcasterEvent,
): SseBroadcasterChannelReducerResult {
  switch (event.type) {
    case "ClientConnected": {
      if (event.scope !== "channel" || event.channelId === undefined) {
        return { newState: state, commands: [] };
      }
      const channelState = state.channels[event.channelId];
      if (channelState === undefined || event.lastEventId === undefined) {
        return { newState: state, commands: [] };
      }
      // Replay events with eventId > lastEventId (simple sequential index-based)
      const replayEvents = channelState.recentEvents.slice(
        typeof event.lastEventId === "number" ? event.lastEventId : 0,
      );
      if (replayEvents.length === 0) {
        return { newState: state, commands: [] };
      }
      return {
        newState: state,
        commands: [{
          type: "SendReplayEvents",
          clientId: event.clientId,
          channelEvents: replayEvents,
          globalEvents: [],
        }],
      };
    }

    case "ClientDisconnected": {
      // No channel state change needed
      return { newState: state, commands: [] };
    }

    case "ChannelEventPublished": {
      const existing: ChannelScopedSseStatePerChannel = state.channels[event.channelId] ?? {
        lastEventId: 0,
        recentEvents: [],
      };
      const newLastEventId = existing.lastEventId + 1;
      const newEvents = appendToBuffer(existing.recentEvents, event.event, SSE_REPLAY_BUFFER_SIZE);
      const newState: ChannelScopedSseState = {
        channels: {
          ...state.channels,
          [event.channelId]: { lastEventId: newLastEventId, recentEvents: newEvents },
        },
      };
      return {
        newState,
        commands: [{ type: "BroadcastToChannel", channelId: event.channelId, event: event.event }],
      };
    }

    case "GlobalEventPublished": {
      // Not handled by channel reducer
      return { newState: state, commands: [] };
    }
  }
}

/**
 * Reducer for global SSE state (global replay buffer).
 */
export function reduceGlobalSse(
  state: GlobalSseState,
  event: SseBroadcasterEvent,
): SseBroadcasterGlobalReducerResult {
  switch (event.type) {
    case "ClientConnected": {
      if (event.scope !== "global") {
        return { newState: state, commands: [] };
      }
      if (event.lastEventId === undefined) {
        return { newState: state, commands: [] };
      }
      const replayEvents = state.recentEvents.slice(
        typeof event.lastEventId === "number" ? event.lastEventId : 0,
      );
      if (replayEvents.length === 0) {
        return { newState: state, commands: [] };
      }
      return {
        newState: state,
        commands: [{
          type: "SendReplayEvents",
          clientId: event.clientId,
          channelEvents: [],
          globalEvents: replayEvents,
        }],
      };
    }

    case "ClientDisconnected": {
      return { newState: state, commands: [] };
    }

    case "ChannelEventPublished": {
      // Not handled by global reducer
      return { newState: state, commands: [] };
    }

    case "GlobalEventPublished": {
      const newLastEventId = state.lastEventId + 1;
      const newEvents = appendToBuffer(state.recentEvents, event.event, SSE_REPLAY_BUFFER_SIZE);
      return {
        newState: { lastEventId: newLastEventId, recentEvents: newEvents },
        commands: [{ type: "BroadcastGlobal", event: event.event }],
      };
    }
  }
}
