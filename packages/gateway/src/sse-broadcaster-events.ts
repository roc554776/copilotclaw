/**
 * Event and command type definitions for the SSE Broadcaster subsystem (gateway side).
 *
 * See docs/proposals/state-management-architecture.md "Gateway: SSE Broadcaster subsystem".
 */

import type { GlobalSseEvent } from "./sse-broadcaster.js";

// ── Timeline types (Item E, v0.83.0) ─────────────────────────────────────────

/**
 * A single entry in the channel timeline — covers messages and non-message events
 * (subagent lifecycle, turn run start/end, etc.).
 *
 * See docs/proposals/state-management-architecture.md "UI 設計方針 — タイムライン UI".
 */
export type TimelineEntry =
  | { entryType: "subagent-started"; toolCallId: string; agentName: string; agentDisplayName: string; timestamp: string }
  | { entryType: "subagent-lifecycle"; toolCallId: string; agentName: string; status: "completed" | "failed"; error?: string; timestamp: string };

/**
 * WaitToolPayload: discriminated union for the result of copilotclaw_wait.
 *
 * The gateway's copilotclaw_wait handler returns one of these payload types.
 * v0.83.0: extended from single-type { userMessage: string } to discriminated union.
 *
 * Design note: The raw IPC wire format still uses { userMessage: string } for backward
 * compatibility with pre-v0.83.0 agents. This union is used in the gateway-side type system
 * to express the variety of events that can unblock copilotclaw_wait.
 */
export type WaitToolPayload =
  | { type: "message"; userMessage: string }
  | { type: "subagent-completed"; toolCallId: string; agentName: string; userMessage: string }
  | { type: "subagent-failed"; toolCallId: string; agentName: string; error: string; userMessage: string }
  | { type: "keepalive"; userMessage: string };

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
