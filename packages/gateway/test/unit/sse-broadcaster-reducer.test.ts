/**
 * Unit tests for the SSE Broadcaster reducers (pure functions):
 * - reduceChannelSse
 * - reduceGlobalSse
 *
 * Covers replay buffers, buffer size limits, and event routing.
 */

import { describe, expect, it } from "vitest";
import { reduceChannelSse, reduceGlobalSse } from "../../src/sse-broadcaster-reducer.js";
import {
  SSE_REPLAY_BUFFER_SIZE,
  type ChannelScopedSseState,
  type GlobalSseState,
  type ChannelSseEvent,
} from "../../src/sse-broadcaster-events.js";
import type { GlobalSseEvent } from "../../src/sse-broadcaster.js";

function makeChannelState(overrides: Partial<ChannelScopedSseState> = {}): ChannelScopedSseState {
  return {
    channels: {},
    ...overrides,
  };
}

function makeGlobalState(overrides: Partial<GlobalSseState> = {}): GlobalSseState {
  return {
    lastEventId: 0,
    recentEvents: [],
    ...overrides,
  };
}

// ── reduceChannelSse — ChannelEventPublished ──────────────────────────────────

describe("reduceChannelSse — ChannelEventPublished", () => {
  it("appends event to replay buffer and emits BroadcastToChannel", () => {
    const state = makeChannelState();
    const event: ChannelSseEvent = { type: "new_message", channelId: "ch-1" };
    const { newState, commands } = reduceChannelSse(state, {
      type: "ChannelEventPublished",
      channelId: "ch-1",
      event,
    });
    expect(newState.channels["ch-1"]).toBeDefined();
    expect(newState.channels["ch-1"].lastEventId).toBe(1);
    expect(newState.channels["ch-1"].recentEvents).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "BroadcastToChannel", channelId: "ch-1", event });
  });

  it("increments lastEventId monotonically across multiple events", () => {
    let state = makeChannelState();
    for (let i = 0; i < 3; i++) {
      const result = reduceChannelSse(state, {
        type: "ChannelEventPublished",
        channelId: "ch-1",
        event: { type: "new_message", channelId: "ch-1" },
      });
      state = result.newState;
    }
    expect(state.channels["ch-1"].lastEventId).toBe(3);
    expect(state.channels["ch-1"].recentEvents).toHaveLength(3);
  });

  it(`trims buffer to SSE_REPLAY_BUFFER_SIZE (${SSE_REPLAY_BUFFER_SIZE})`, () => {
    let state = makeChannelState();
    for (let i = 0; i < SSE_REPLAY_BUFFER_SIZE + 10; i++) {
      const result = reduceChannelSse(state, {
        type: "ChannelEventPublished",
        channelId: "ch-1",
        event: { type: "new_message", channelId: "ch-1" },
      });
      state = result.newState;
    }
    expect(state.channels["ch-1"].recentEvents).toHaveLength(SSE_REPLAY_BUFFER_SIZE);
  });

  it("maintains separate buffers per channel", () => {
    let state = makeChannelState();
    state = reduceChannelSse(state, {
      type: "ChannelEventPublished",
      channelId: "ch-1",
      event: { type: "new_message", channelId: "ch-1" },
    }).newState;
    state = reduceChannelSse(state, {
      type: "ChannelEventPublished",
      channelId: "ch-2",
      event: { type: "session_status_change", channelId: "ch-2" },
    }).newState;
    expect(state.channels["ch-1"].recentEvents).toHaveLength(1);
    expect(state.channels["ch-2"].recentEvents).toHaveLength(1);
    expect(state.channels["ch-1"].lastEventId).toBe(1);
    expect(state.channels["ch-2"].lastEventId).toBe(1);
  });
});

// ── reduceChannelSse — ClientConnected ────────────────────────────────────────

describe("reduceChannelSse — ClientConnected", () => {
  it("replays missed events when client reconnects with older lastEventId", () => {
    let state = makeChannelState();
    for (let i = 0; i < 3; i++) {
      state = reduceChannelSse(state, {
        type: "ChannelEventPublished",
        channelId: "ch-1",
        event: { type: "new_message", channelId: "ch-1" },
      }).newState;
    }
    const { newState, commands } = reduceChannelSse(state, {
      type: "ClientConnected",
      clientId: "client-x",
      scope: "channel",
      channelId: "ch-1",
      lastEventId: 1, // client has event 0 (index-based), needs events from index 1
    });
    expect(newState).toEqual(state); // no state change
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("SendReplayEvents");
    if (commands[0].type === "SendReplayEvents") {
      expect(commands[0].clientId).toBe("client-x");
      expect(commands[0].channelEvents).toHaveLength(2); // events at indices 1 and 2
    }
  });

  it("no replay when client is up-to-date (no missed events)", () => {
    let state = makeChannelState();
    state = reduceChannelSse(state, {
      type: "ChannelEventPublished",
      channelId: "ch-1",
      event: { type: "new_message", channelId: "ch-1" },
    }).newState;
    const { commands } = reduceChannelSse(state, {
      type: "ClientConnected",
      clientId: "client-x",
      scope: "channel",
      channelId: "ch-1",
      lastEventId: 1, // up to date
    });
    expect(commands).toHaveLength(0);
  });

  it("no-op for global-scope ClientConnected", () => {
    const state = makeChannelState();
    const { newState, commands } = reduceChannelSse(state, {
      type: "ClientConnected",
      clientId: "client-x",
      scope: "global",
      lastEventId: 0,
    });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });

  it("no replay for unknown channel", () => {
    const state = makeChannelState();
    const { commands } = reduceChannelSse(state, {
      type: "ClientConnected",
      clientId: "client-x",
      scope: "channel",
      channelId: "unknown-ch",
      lastEventId: 0,
    });
    expect(commands).toHaveLength(0);
  });
});

// ── reduceChannelSse — GlobalEventPublished ───────────────────────────────────

describe("reduceChannelSse — GlobalEventPublished", () => {
  it("no-op (global events not handled by channel reducer)", () => {
    const state = makeChannelState();
    const { newState, commands } = reduceChannelSse(state, {
      type: "GlobalEventPublished",
      event: { type: "channel_archived", data: {} } as GlobalSseEvent,
    });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});

// ── reduceGlobalSse — GlobalEventPublished ────────────────────────────────────

describe("reduceGlobalSse — GlobalEventPublished", () => {
  it("appends event to global buffer and emits BroadcastGlobal", () => {
    const state = makeGlobalState();
    const event = { type: "channel_archived", data: {} } as GlobalSseEvent;
    const { newState, commands } = reduceGlobalSse(state, { type: "GlobalEventPublished", event });
    expect(newState.lastEventId).toBe(1);
    expect(newState.recentEvents).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "BroadcastGlobal", event });
  });

  it(`trims global buffer to SSE_REPLAY_BUFFER_SIZE (${SSE_REPLAY_BUFFER_SIZE})`, () => {
    let state = makeGlobalState();
    for (let i = 0; i < SSE_REPLAY_BUFFER_SIZE + 5; i++) {
      state = reduceGlobalSse(state, {
        type: "GlobalEventPublished",
        event: { type: "channel_archived", data: {} } as GlobalSseEvent,
      }).newState;
    }
    expect(state.recentEvents).toHaveLength(SSE_REPLAY_BUFFER_SIZE);
  });
});

// ── reduceGlobalSse — ClientConnected ─────────────────────────────────────────

describe("reduceGlobalSse — ClientConnected", () => {
  it("replays missed global events", () => {
    let state = makeGlobalState();
    for (let i = 0; i < 3; i++) {
      state = reduceGlobalSse(state, {
        type: "GlobalEventPublished",
        event: { type: "channel_archived", data: {} } as GlobalSseEvent,
      }).newState;
    }
    const { commands } = reduceGlobalSse(state, {
      type: "ClientConnected",
      clientId: "client-g",
      scope: "global",
      lastEventId: 1,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("SendReplayEvents");
    if (commands[0].type === "SendReplayEvents") {
      expect(commands[0].globalEvents).toHaveLength(2);
    }
  });

  it("no-op for channel-scope ClientConnected", () => {
    const state = makeGlobalState();
    const { commands } = reduceGlobalSse(state, {
      type: "ClientConnected",
      clientId: "client-x",
      scope: "channel",
      channelId: "ch-1",
      lastEventId: 0,
    });
    expect(commands).toHaveLength(0);
  });

  it("no replay when up-to-date", () => {
    let state = makeGlobalState();
    state = reduceGlobalSse(state, {
      type: "GlobalEventPublished",
      event: { type: "channel_archived", data: {} } as GlobalSseEvent,
    }).newState;
    const { commands } = reduceGlobalSse(state, {
      type: "ClientConnected",
      clientId: "client-g",
      scope: "global",
      lastEventId: 1,
    });
    expect(commands).toHaveLength(0);
  });
});
