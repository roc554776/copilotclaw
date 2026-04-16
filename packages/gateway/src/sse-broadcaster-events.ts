/**
 * Event and command type definitions for the SSE Broadcaster subsystem (gateway side).
 *
 * See docs/proposals/state-management-architecture.md "Gateway: SSE Broadcaster subsystem".
 */

import type { GlobalSseEvent } from "./sse-broadcaster.js";

// ── Re-export types used in world state ──────────────────────────────────────

/** Channel-scoped SSE events (subset of full SSE event types). */
export type ChannelSseEvent =
  | { type: "new_message"; channelId: string; data?: unknown }
  | { type: "session_status_change"; channelId: string; data?: unknown }
  | { type: "channel_status_change"; channelId: string; data?: unknown }
  | { type: "channel_timeline_event"; channelId: string; data?: unknown };

// ── World State ──────────────────────────────────────────────────────────────

/** Per-channel replay buffer state. */
export interface ChannelScopedSseStatePerChannel {
  lastEventId: number;
  recentEvents: ChannelSseEvent[];
}

/** All channels' SSE state. */
export interface ChannelScopedSseState {
  channels: Record<string, ChannelScopedSseStatePerChannel>;
}

/** Global SSE replay buffer state. */
export interface GlobalSseState {
  lastEventId: number;
  recentEvents: GlobalSseEvent[];
}

/** Maximum events kept in replay buffer per channel or global. */
export const SSE_REPLAY_BUFFER_SIZE = 100;

// ── Events ────────────────────────────────────────────────────────────────────

export type SseBroadcasterEvent =
  | { type: "ClientConnected"; clientId: string; scope: "channel" | "global"; channelId?: string; lastEventId: number | undefined }
  | { type: "ClientDisconnected"; clientId: string }
  | { type: "ChannelEventPublished"; channelId: string; event: ChannelSseEvent }
  | { type: "GlobalEventPublished"; event: GlobalSseEvent };

// ── Commands ──────────────────────────────────────────────────────────────────

export type SseBroadcasterCommand =
  | { type: "SendReplayEvents"; clientId: string; channelEvents: ChannelSseEvent[]; globalEvents: GlobalSseEvent[] }
  | { type: "BroadcastToChannel"; channelId: string; event: ChannelSseEvent }
  | { type: "BroadcastGlobal"; event: GlobalSseEvent };

// ── Reducer output ────────────────────────────────────────────────────────────

export interface SseBroadcasterChannelReducerResult {
  newState: ChannelScopedSseState;
  commands: SseBroadcasterCommand[];
}

export interface SseBroadcasterGlobalReducerResult {
  newState: GlobalSseState;
  commands: SseBroadcasterCommand[];
}
