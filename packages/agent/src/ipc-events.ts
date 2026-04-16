/**
 * Event and command type definitions for the IPC subsystems (agent side):
 * - SendQueue subsystem
 * - RPC subsystem
 *
 * See docs/proposals/state-management-architecture.md for design.
 */

// ── SendQueue subsystem ───────────────────────────────────────────────────────

export interface QueuedMessage {
  _queueId: string;
  [key: string]: unknown;
}

export interface SendQueueState {
  messages: QueuedMessage[];
  flushInProgress: boolean;
  /** IDs of flushed messages awaiting ACK. Array (not Set) for JSON serializability. */
  pendingAckIds: string[];
}

export type SendQueueEvent =
  | { type: "MessageEnqueued"; message: QueuedMessage }
  | { type: "FlushStarted"; batchIds: string[] }
  | { type: "MessageAcknowledged"; messageId: string }
  | { type: "FlushCompleted" }
  | { type: "ConnectionLost" }
  | { type: "ConnectionRestored" }
  /** Evict the oldest message and enqueue a new one atomically (queue-full policy). */
  | { type: "QueueOverflowed"; message: QueuedMessage }
  /** Flush of legacy (pre-ACK) messages completed — clear state immediately (no ACKs expected). */
  | { type: "LegacyFlushCompleted" }
  /** Startup restoration from persisted disk state — loads messages and resets pendingAckIds. */
  | { type: "Initialized"; messages: QueuedMessage[] };

export type SendQueueCommand =
  | { type: "FlushBatch"; messages: QueuedMessage[] }
  | { type: "PersistQueue"; messages: QueuedMessage[] }
  | { type: "ClearDisk" };

export interface SendQueueReducerResult {
  newState: SendQueueState;
  commands: SendQueueCommand[];
}

// ── RPC subsystem ─────────────────────────────────────────────────────────────

export interface PendingRequestMetadata {
  requestId: string;
  method: string;
  payload: unknown;
  sentAt: string;
  timeoutMs: number;
}

export interface RpcState {
  pendingRequests: PendingRequestMetadata[];
  connectionStatus: "connected" | "disconnected" | "reconnecting";
}

export type RpcEvent =
  | { type: "RequestSent"; requestId: string; method: string; payload: unknown; sentAt: string; timeoutMs: number }
  | { type: "ResponseReceived"; requestId: string; data: unknown }
  | { type: "RequestTimedOut"; requestId: string }
  | { type: "ConnectionLost" }
  | { type: "ConnectionRestored" };

export type RpcCommand =
  | { type: "SendRequest"; requestId: string; method: string; payload: unknown }
  | { type: "RejectRequest"; requestId: string; error: string }
  | { type: "ReplayPendingRequests"; requests: PendingRequestMetadata[] };

export interface RpcReducerResult {
  newState: RpcState;
  commands: RpcCommand[];
}

