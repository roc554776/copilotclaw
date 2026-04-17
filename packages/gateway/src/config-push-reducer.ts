/**
 * Pure reducer for the ConfigPush subsystem (gateway side).
 *
 * Contract:
 *   reduceConfigPush(state, event) → { newState, commands }
 *
 * Manages two push paths:
 *   - ConfigSet while stream already connected → emit SendConfig immediately
 *   - StreamConnected while config is already set → emit SendConfig on connect
 *
 * No side effects. All side effects are expressed as ConfigPushCommand values.
 *
 * See docs/proposals/state-management-architecture.md "ConfigPush subsystem".
 */

import type {
  ConfigPushWorldState,
  ConfigPushEvent,
  ConfigPushReducerResult,
} from "./config-push-events.js";

/**
 * Pure state transition function for the ConfigPush subsystem.
 */
export function reduceConfigPush(
  state: ConfigPushWorldState,
  event: ConfigPushEvent,
): ConfigPushReducerResult {
  switch (event.type) {
    case "ConfigSet": {
      const newState: ConfigPushWorldState = { ...state, config: event.config };
      // If already connected, push immediately
      if (state.connected) {
        return {
          newState,
          commands: [{ type: "SendConfig", config: event.config }],
        };
      }
      // Not connected yet — store config; it will be pushed on StreamConnected
      return { newState, commands: [] };
    }

    case "StreamConnected": {
      const newState: ConfigPushWorldState = { ...state, connected: true };
      // Push pending config immediately on connect
      if (state.config !== null) {
        return {
          newState,
          commands: [{ type: "SendConfig", config: state.config }],
        };
      }
      return { newState, commands: [] };
    }

    case "StreamDisconnected": {
      return {
        newState: { ...state, connected: false },
        commands: [],
      };
    }
  }
}
