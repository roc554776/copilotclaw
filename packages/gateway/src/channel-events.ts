/**
 * Event and command type definitions for the Channel subsystem (gateway side).
 *
 * These types define the finite set of inputs (events) and outputs (commands)
 * for the Channel reducer. All state transitions go through the reducer;
 * side effects go through the effect runtime.
 *
 * See docs/proposals/state-management-architecture.md "Gateway: Channel subsystem" for design.
 */

// ── World State ──────────────────────────────────────────────────────────────

export interface BackoffState {
  failureCount: number;
  nextRetryAt: number;
  lastFailureReason: string;
}

/**
 * JSON-serializable world state for a Channel.
 * No live process handles here.
 */
export interface ChannelWorldState {
  channelId: string;
  archivedAt: number | undefined;
  model: string | undefined;
  draft: string | undefined;
  backoff: BackoffState | undefined;
}

// ── Events ────────────────────────────────────────────────────────────────────

export type ChannelEvent =
  | { type: "MessagePosted"; sender: "user" | "agent" | "cron" | "system"; content: string }
  | { type: "Archived" }
  | { type: "Unarchived" }
  | { type: "DefaultModelSet"; model: string | undefined }
  | { type: "DraftUpdated"; draft: string | undefined }
  | { type: "SessionStartFailed"; reason: string; backoffDurationMs: number }
  | { type: "BackoffReset" };

// ── Commands ──────────────────────────────────────────────────────────────────

export type ChannelCommand =
  | { type: "PersistBackoff"; channelId: string; backoff: BackoffState }
  | { type: "ClearBackoff"; channelId: string }
  | { type: "PersistDraft"; channelId: string; draft: string | undefined };

// ── Reducer output ────────────────────────────────────────────────────────────

export interface ChannelReducerResult {
  newState: ChannelWorldState;
  commands: ChannelCommand[];
}
