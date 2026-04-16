/**
 * Event and command type definitions for the PendingQueue subsystem (gateway side).
 *
 * See docs/proposals/state-management-architecture.md "Gateway: PendingQueue subsystem".
 */

import type { Message } from "./store.js";

// ── World State ──────────────────────────────────────────────────────────────

export type FlushReason = "session-ended" | "force-flush" | "channel-archived";

export interface PendingQueueState {
  channelId: string;
  messages: Message[];
  drainInProgress: boolean;
  lastDrainedAt: number | undefined;
}

// ── Events ────────────────────────────────────────────────────────────────────

export type PendingQueueEvent =
  | { type: "MessageEnqueued"; message: Message }
  | { type: "DrainStarted"; requestId: string }
  | { type: "DrainCompleted"; requestId: string; drainedIds: string[] }
  | { type: "DrainAcknowledged"; requestId: string }
  | { type: "MessageFlushed"; messageId: string; reason: FlushReason }
  | { type: "QueueFlushed"; reason: FlushReason };

// ── Commands ──────────────────────────────────────────────────────────────────

export type PendingQueueCommand =
  | { type: "DeliverMessages"; channelId: string; messages: Message[] }
  | { type: "PersistQueue"; channelId: string; messages: Message[] }
  | { type: "SendAck"; requestId: string };

// ── Reducer output ────────────────────────────────────────────────────────────

export interface PendingQueueReducerResult {
  newState: PendingQueueState;
  commands: PendingQueueCommand[];
}
