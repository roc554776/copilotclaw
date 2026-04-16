/**
 * Unit tests for the EventBus reducer and runtime.
 *
 * Covers: dedup via processedEventIds sliding window, subsystem routing,
 * and idempotent dispatchWithId.
 */

import { describe, expect, it, vi } from "vitest";
import { reduceEventBus, EventBus, createInitialEventBusState } from "../../src/event-bus.js";
import type { EventBusState } from "../../src/event-bus.js";

// ── reduceEventBus ────────────────────────────────────────────────────────────

describe("reduceEventBus — EventArrived (new event)", () => {
  it("adds eventId to processedEventIds and emits DispatchToSubsystem", () => {
    const state = createInitialEventBusState();
    const { newState, commands } = reduceEventBus(state, {
      type: "EventArrived",
      eventId: "ev-1",
      targetSubsystem: "channel",
      payload: { test: true },
    });
    expect(newState.processedEventIds).toContain("ev-1");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      type: "DispatchToSubsystem",
      eventId: "ev-1",
      targetSubsystem: "channel",
      payload: { test: true },
    });
  });
});

describe("reduceEventBus — EventArrived (duplicate)", () => {
  it("emits RecordDuplicateEvent and does not re-dispatch", () => {
    const state: EventBusState = { processedEventIds: ["ev-1"] };
    const { newState, commands } = reduceEventBus(state, {
      type: "EventArrived",
      eventId: "ev-1",
      targetSubsystem: "channel",
      payload: {},
    });
    expect(newState).toEqual(state); // no change
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("RecordDuplicateEvent");
  });
});

describe("reduceEventBus — processedEventIds window trimming", () => {
  it("trims window to 1000 entries", () => {
    let state = createInitialEventBusState();
    for (let i = 0; i < 1005; i++) {
      const result = reduceEventBus(state, {
        type: "EventArrived",
        eventId: `ev-${i}`,
        targetSubsystem: "sub",
        payload: {},
      });
      state = result.newState;
    }
    expect(state.processedEventIds).toHaveLength(1000);
    // Oldest entries should be evicted
    expect(state.processedEventIds).not.toContain("ev-0");
    expect(state.processedEventIds).not.toContain("ev-4");
    expect(state.processedEventIds).toContain("ev-1004");
  });
});

// ── EventBus runtime ──────────────────────────────────────────────────────────

describe("EventBus.dispatch", () => {
  it("routes payload to registered handler", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.register("my-subsystem", handler);
    bus.dispatch("my-subsystem", { value: 42 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it("silently ignores dispatch to unregistered subsystem", () => {
    const bus = new EventBus();
    expect(() => bus.dispatch("unknown", {})).not.toThrow();
  });

  it("assigns unique UUIDs for each dispatch (no dedup on distinct events)", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.register("sub", (p) => received.push(p));
    bus.dispatch("sub", { n: 1 });
    bus.dispatch("sub", { n: 2 });
    expect(received).toHaveLength(2);
  });
});

describe("EventBus.dispatchWithId", () => {
  it("deduplicates events with the same ID", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.register("sub", handler);
    bus.dispatchWithId("fixed-id", "sub", { n: 1 });
    bus.dispatchWithId("fixed-id", "sub", { n: 2 }); // duplicate
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ n: 1 });
  });

  it("dispatches distinct IDs independently", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.register("sub", (p) => received.push(p));
    bus.dispatchWithId("id-a", "sub", { n: 1 });
    bus.dispatchWithId("id-b", "sub", { n: 2 });
    expect(received).toHaveLength(2);
  });
});

describe("EventBus.getState", () => {
  it("reflects accumulated processedEventIds", () => {
    const bus = new EventBus();
    bus.dispatchWithId("ev-x", "sub", {});
    const state = bus.getState();
    expect(state.processedEventIds).toContain("ev-x");
  });
});
