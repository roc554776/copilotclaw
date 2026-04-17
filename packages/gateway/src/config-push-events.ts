/**
 * Event and command type definitions for the ConfigPush subsystem (gateway side).
 *
 * ConfigPush manages the lifecycle of sending the gateway config to the agent
 * over the IPC stream. The reducer tracks whether the stream is connected and
 * what config (if any) is pending, and emits SendConfig commands when appropriate.
 *
 * See docs/proposals/state-management-architecture.md "ConfigPush subsystem".
 */

// ── World State ──────────────────────────────────────────────────────────────

/**
 * JSON-serializable world state for the ConfigPush subsystem.
 * Tracks the last config to send and whether the stream is currently connected.
 */
export interface ConfigPushWorldState {
  /** The config to push to the agent. null if not yet set. */
  config: Record<string, unknown> | null;
  /** Whether the IPC stream to the agent is currently connected. */
  connected: boolean;
}

// ── Events ────────────────────────────────────────────────────────────────────

export type ConfigPushEvent =
  /** A new config was provided by the gateway (via setConfigToSend). */
  | { type: "ConfigSet"; config: Record<string, unknown> }
  /** The IPC stream to the agent became connected. */
  | { type: "StreamConnected" }
  /** The IPC stream to the agent became disconnected. */
  | { type: "StreamDisconnected" };

// ── Commands ──────────────────────────────────────────────────────────────────

export type ConfigPushCommand =
  /** Send the config to the agent via IPC stream. */
  { type: "SendConfig"; config: Record<string, unknown> };

// ── Reducer output ────────────────────────────────────────────────────────────

export interface ConfigPushReducerResult {
  newState: ConfigPushWorldState;
  commands: ConfigPushCommand[];
}
