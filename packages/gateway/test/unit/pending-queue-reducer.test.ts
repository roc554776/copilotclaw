/**
 * Unit tests for the PendingQueue reducer (pure function).
 *
 * Covers drain sequencing, duplicate prevention, and flush paths.
 */

import { describe, expect, it } from "vitest";
import { reducePendingQueue } from "../../src/pending-queue-reducer.js";
import type { PendingQueueState } from "../../src/pending-queue-events.js";
import type { Message } from "../../src/store.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    channelId: "ch-1",
    sender: "user",
    message: "hello",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(overrides: Partial<PendingQueueState> = {}): PendingQueueState {
  return {
    channelId: "ch-1",
    messages: [],
    drainInProgress: false,
    lastDrainedAt: undefined,
    ...overrides,
  };
}

// ── MessageEnqueued ───────────────────────────────────────────────────────────

describe("reducePendingQueue — MessageEnqueued", () => {
  it("appends message and emits PersistQueue", () => {
    const state = makeState();
    const msg = makeMessage({ id: "m1" });
    const { newState, commands } = reducePendingQueue(state, { type: "MessageEnqueued", message: msg });
    expect(newState.messages).toHaveLength(1);
    expect(newState.messages[0].id).toBe("m1");
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("PersistQueue");
  });

  it("prevents duplicate enqueue by message id", () => {
    const msg = makeMessage({ id: "dup" });
    const state = makeState({ messages: [msg] });
    const { newState, commands } = reducePendingQueue(state, { type: "MessageEnqueued", message: msg });
    expect(newState.messages).toHaveLength(1);
    expect(commands).toHaveLength(0);
  });
});

// ── DrainStarted ──────────────────────────────────────────────────────────────

describe("reducePendingQueue — DrainStarted", () => {
  it("begins drain and emits DeliverMessages", () => {
    const msg = makeMessage({ id: "m1" });
    const state = makeState({ messages: [msg] });
    const { newState, commands } = reducePendingQueue(state, { type: "DrainStarted", requestId: "req-1" });
    expect(newState.drainInProgress).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("DeliverMessages");
  });

  it("rejects second drain when drain is already in progress", () => {
    const msg = makeMessage({ id: "m1" });
    const state = makeState({ messages: [msg], drainInProgress: true });
    const { newState, commands } = reducePendingQueue(state, { type: "DrainStarted", requestId: "req-2" });
    expect(newState.drainInProgress).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("no-op when queue is empty", () => {
    const state = makeState();
    const { newState, commands } = reducePendingQueue(state, { type: "DrainStarted", requestId: "req-1" });
    expect(newState.drainInProgress).toBe(false);
    expect(commands).toHaveLength(0);
  });
});

// ── DrainCompleted ────────────────────────────────────────────────────────────

describe("reducePendingQueue — DrainCompleted", () => {
  it("removes drained messages and emits PersistQueue + SendAck", () => {
    const m1 = makeMessage({ id: "m1" });
    const m2 = makeMessage({ id: "m2" });
    const state = makeState({ messages: [m1, m2], drainInProgress: true });
    const { newState, commands } = reducePendingQueue(state, {
      type: "DrainCompleted",
      requestId: "req-1",
      drainedIds: ["m1"],
    });
    expect(newState.messages).toHaveLength(1);
    expect(newState.messages[0].id).toBe("m2");
    expect(newState.drainInProgress).toBe(false);
    expect(newState.lastDrainedAt).toBeDefined();
    const types = commands.map((c) => c.type);
    expect(types).toContain("PersistQueue");
    expect(types).toContain("SendAck");
  });

  it("no-op when drain is not in progress", () => {
    const state = makeState();
    const { newState, commands } = reducePendingQueue(state, {
      type: "DrainCompleted",
      requestId: "req-1",
      drainedIds: [],
    });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});

// ── DrainAcknowledged ─────────────────────────────────────────────────────────

describe("reducePendingQueue — DrainAcknowledged", () => {
  it("no state change (ACK is informational after drain completion)", () => {
    const state = makeState();
    const { newState, commands } = reducePendingQueue(state, {
      type: "DrainAcknowledged",
      requestId: "req-1",
    });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});

// ── MessageFlushed ────────────────────────────────────────────────────────────

describe("reducePendingQueue — MessageFlushed", () => {
  it("removes specific message and emits PersistQueue", () => {
    const m1 = makeMessage({ id: "m1" });
    const m2 = makeMessage({ id: "m2" });
    const state = makeState({ messages: [m1, m2] });
    const { newState, commands } = reducePendingQueue(state, {
      type: "MessageFlushed",
      messageId: "m1",
      reason: "session-ended",
    });
    expect(newState.messages).toHaveLength(1);
    expect(newState.messages[0].id).toBe("m2");
    expect(commands[0].type).toBe("PersistQueue");
  });
});

// ── QueueFlushed ──────────────────────────────────────────────────────────────

describe("reducePendingQueue — QueueFlushed", () => {
  it("clears all messages and emits PersistQueue with empty array", () => {
    const state = makeState({ messages: [makeMessage(), makeMessage()], drainInProgress: true });
    const { newState, commands } = reducePendingQueue(state, { type: "QueueFlushed", reason: "channel-archived" });
    expect(newState.messages).toHaveLength(0);
    expect(newState.drainInProgress).toBe(false);
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("PersistQueue");
  });

  it("no-op when queue is already empty", () => {
    const state = makeState();
    const { newState, commands } = reducePendingQueue(state, { type: "QueueFlushed", reason: "force-flush" });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});
