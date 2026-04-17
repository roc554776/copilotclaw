/**
 * Unit tests for the ConfigPush reducer (pure function).
 *
 * Covers config-before-connect, connect-before-config, reconnect, and disconnect paths.
 */

import { describe, expect, it } from "vitest";
import { reduceConfigPush } from "../../src/config-push-reducer.js";
import type { ConfigPushWorldState } from "../../src/config-push-events.js";

function makeState(overrides: Partial<ConfigPushWorldState> = {}): ConfigPushWorldState {
  return {
    config: null,
    connected: false,
    ...overrides,
  };
}

const sampleConfig = { model: "gpt-4.1", zeroPremium: false };

// ── ConfigSet ─────────────────────────────────────────────────────────────────

describe("reduceConfigPush — ConfigSet", () => {
  it("stores config and emits SendConfig when stream is already connected", () => {
    const state = makeState({ connected: true });
    const { newState, commands } = reduceConfigPush(state, { type: "ConfigSet", config: sampleConfig });

    expect(newState.config).toEqual(sampleConfig);
    expect(newState.connected).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "SendConfig", config: sampleConfig });
  });

  it("stores config without emitting SendConfig when stream is not connected", () => {
    const state = makeState({ connected: false });
    const { newState, commands } = reduceConfigPush(state, { type: "ConfigSet", config: sampleConfig });

    expect(newState.config).toEqual(sampleConfig);
    expect(newState.connected).toBe(false);
    expect(commands).toHaveLength(0);
  });

  it("overwrites existing config and emits SendConfig when connected", () => {
    const oldConfig = { model: "old-model" };
    const newConfig = { model: "gpt-4.1", zeroPremium: true };
    const state = makeState({ config: oldConfig, connected: true });

    const { newState, commands } = reduceConfigPush(state, { type: "ConfigSet", config: newConfig });

    expect(newState.config).toEqual(newConfig);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "SendConfig", config: newConfig });
  });

  it("overwrites existing config without emitting SendConfig when disconnected", () => {
    const oldConfig = { model: "old-model" };
    const newConfig = { model: "gpt-4.1" };
    const state = makeState({ config: oldConfig, connected: false });

    const { newState, commands } = reduceConfigPush(state, { type: "ConfigSet", config: newConfig });

    expect(newState.config).toEqual(newConfig);
    expect(commands).toHaveLength(0);
  });
});

// ── StreamConnected ───────────────────────────────────────────────────────────

describe("reduceConfigPush — StreamConnected", () => {
  it("marks stream connected and emits SendConfig when config is already set", () => {
    const state = makeState({ config: sampleConfig, connected: false });
    const { newState, commands } = reduceConfigPush(state, { type: "StreamConnected" });

    expect(newState.connected).toBe(true);
    expect(newState.config).toEqual(sampleConfig);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "SendConfig", config: sampleConfig });
  });

  it("marks stream connected with no commands when config is not yet set", () => {
    const state = makeState({ config: null, connected: false });
    const { newState, commands } = reduceConfigPush(state, { type: "StreamConnected" });

    expect(newState.connected).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("is idempotent when stream was already marked connected", () => {
    const state = makeState({ config: sampleConfig, connected: true });
    const { newState, commands } = reduceConfigPush(state, { type: "StreamConnected" });

    // Still emits SendConfig because config is set (re-push on reconnect)
    expect(newState.connected).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("SendConfig");
  });
});

// ── StreamDisconnected ────────────────────────────────────────────────────────

describe("reduceConfigPush — StreamDisconnected", () => {
  it("marks stream disconnected and emits no commands", () => {
    const state = makeState({ config: sampleConfig, connected: true });
    const { newState, commands } = reduceConfigPush(state, { type: "StreamDisconnected" });

    expect(newState.connected).toBe(false);
    expect(newState.config).toEqual(sampleConfig);
    expect(commands).toHaveLength(0);
  });

  it("preserves config across disconnect so it is pushed on next StreamConnected", () => {
    const state = makeState({ config: sampleConfig, connected: true });

    const disconnected = reduceConfigPush(state, { type: "StreamDisconnected" });
    expect(disconnected.newState.config).toEqual(sampleConfig);
    expect(disconnected.commands).toHaveLength(0);

    const reconnected = reduceConfigPush(disconnected.newState, { type: "StreamConnected" });
    expect(reconnected.newState.connected).toBe(true);
    expect(reconnected.commands).toHaveLength(1);
    expect(reconnected.commands[0]).toEqual({ type: "SendConfig", config: sampleConfig });
  });

  it("is idempotent when stream was already disconnected", () => {
    const state = makeState({ connected: false });
    const { newState, commands } = reduceConfigPush(state, { type: "StreamDisconnected" });

    expect(newState.connected).toBe(false);
    expect(commands).toHaveLength(0);
  });
});

// ── Full lifecycle sequences ──────────────────────────────────────────────────

describe("reduceConfigPush — lifecycle sequences", () => {
  it("config-before-connect: ConfigSet then StreamConnected pushes once", () => {
    let state = makeState();

    // Config arrives before stream is connected
    const afterConfigSet = reduceConfigPush(state, { type: "ConfigSet", config: sampleConfig });
    expect(afterConfigSet.commands).toHaveLength(0); // Not yet connected
    state = afterConfigSet.newState;

    // Stream connects — should push the buffered config
    const afterConnect = reduceConfigPush(state, { type: "StreamConnected" });
    expect(afterConnect.commands).toHaveLength(1);
    expect(afterConnect.commands[0]).toEqual({ type: "SendConfig", config: sampleConfig });
  });

  it("connect-before-config: StreamConnected then ConfigSet pushes once", () => {
    let state = makeState();

    // Stream connects before config is set
    const afterConnect = reduceConfigPush(state, { type: "StreamConnected" });
    expect(afterConnect.commands).toHaveLength(0); // No config yet
    state = afterConnect.newState;

    // Config arrives while connected — should push immediately
    const afterConfigSet = reduceConfigPush(state, { type: "ConfigSet", config: sampleConfig });
    expect(afterConfigSet.commands).toHaveLength(1);
    expect(afterConfigSet.commands[0]).toEqual({ type: "SendConfig", config: sampleConfig });
  });

  it("reconnect sequence: disconnect then reconnect pushes config again", () => {
    let state = makeState({ config: sampleConfig, connected: true });

    const afterDisconnect = reduceConfigPush(state, { type: "StreamDisconnected" });
    expect(afterDisconnect.commands).toHaveLength(0);
    state = afterDisconnect.newState;

    const afterReconnect = reduceConfigPush(state, { type: "StreamConnected" });
    expect(afterReconnect.commands).toHaveLength(1);
    expect(afterReconnect.commands[0]).toEqual({ type: "SendConfig", config: sampleConfig });
  });

  it("config update while connected pushes the new config", () => {
    const initialConfig = { model: "gpt-4o" };
    const updatedConfig = { model: "gpt-4.1", zeroPremium: true };
    let state = makeState({ config: initialConfig, connected: true });

    const afterUpdate = reduceConfigPush(state, { type: "ConfigSet", config: updatedConfig });
    expect(afterUpdate.commands).toHaveLength(1);
    expect(afterUpdate.commands[0]).toEqual({ type: "SendConfig", config: updatedConfig });
    state = afterUpdate.newState;

    expect(state.config).toEqual(updatedConfig);
  });
});
