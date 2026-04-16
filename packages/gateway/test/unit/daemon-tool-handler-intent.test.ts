/**
 * Tests for the daemon's copilotclaw_intent tool call handler.
 *
 * Tests import handleIntentToolCall directly from daemon.ts to ensure
 * no divergence between the test and the actual production handler.
 *
 * v0.79.0: IntentsStore is now SQLite-backed via Store. Tests use in-memory Store.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { handleIntentToolCall } from "../../src/daemon.js";
import { IntentsStore } from "../../src/intents-store.js";
import { Store } from "../../src/store.js";

function makeIntentsStore(): IntentsStore {
  const store = new Store(); // in-memory SQLite
  const intentsStore = new IntentsStore();
  intentsStore.init(store);
  return intentsStore;
}

describe("daemon onToolCall — copilotclaw_intent", () => {
  let store: IntentsStore;

  beforeEach(() => {
    store = makeIntentsStore();
  });

  it("returns { acknowledged: true } for a valid intent", () => {
    const result = handleIntentToolCall({
      sessionId: "session-1",
      channelId: "ch-1",
      agentId: "agent-op",
      args: { intent: "about to read a file" },
    }, store);
    expect(result).toEqual({ acknowledged: true });
  });

  it("records the intent in the store via listIntents", () => {
    handleIntentToolCall({
      sessionId: "session-1",
      channelId: "ch-1",
      agentId: "agent-op",
      args: { intent: "about to read a file" },
    }, store);
    const entries = store.listIntents("ch-1", "agent-op");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.intent).toBe("about to read a file");
    expect(entries[0]!.sessionId).toBe("session-1");
    expect(entries[0]!.timestamp).toBeTruthy();
  });

  it("does not record when intent is empty string", () => {
    handleIntentToolCall({
      sessionId: "session-1",
      channelId: "ch-1",
      agentId: "agent-op",
      args: { intent: "" },
    }, store);
    expect(store.listIntents("ch-1", "agent-op")).toHaveLength(0);
  });

  it("does not record when intent is missing from args", () => {
    handleIntentToolCall({
      sessionId: "session-1",
      channelId: "ch-1",
      agentId: "agent-op",
      args: {},
    }, store);
    expect(store.listIntents("ch-1", "agent-op")).toHaveLength(0);
  });

  it("does not record when intent is not a string (number)", () => {
    handleIntentToolCall({
      sessionId: "session-1",
      channelId: "ch-1",
      agentId: "agent-op",
      args: { intent: 42 },
    }, store);
    expect(store.listIntents("ch-1", "agent-op")).toHaveLength(0);
  });

  it("still returns { acknowledged: true } even when intent is empty", () => {
    const result = handleIntentToolCall({
      sessionId: "session-1",
      channelId: "ch-1",
      agentId: "agent-op",
      args: { intent: "" },
    }, store);
    expect(result).toEqual({ acknowledged: true });
  });

  it("records multiple intents for the same channel/agent — newest first", () => {
    handleIntentToolCall({ sessionId: "session-1", channelId: "ch-1", agentId: "agent-op", args: { intent: "first" } }, store);
    handleIntentToolCall({ sessionId: "session-1", channelId: "ch-1", agentId: "agent-op", args: { intent: "second" } }, store);
    const entries = store.listIntents("ch-1", "agent-op");
    expect(entries).toHaveLength(2);
    // listIntents returns newest first
    expect(entries[0]!.intent).toBe("second");
    expect(entries[1]!.intent).toBe("first");
  });

  it("records intents for different channels independently", () => {
    handleIntentToolCall({ sessionId: "session-A", channelId: "ch-A", agentId: "agent-op", args: { intent: "intent-A" } }, store);
    handleIntentToolCall({ sessionId: "session-B", channelId: "ch-B", agentId: "agent-op", args: { intent: "intent-B" } }, store);
    expect(store.listIntents("ch-A", "agent-op")).toHaveLength(1);
    expect(store.listIntents("ch-B", "agent-op")).toHaveLength(1);
    expect(store.listIntents("ch-A", "agent-op")[0]!.intent).toBe("intent-A");
    expect(store.listIntents("ch-B", "agent-op")[0]!.intent).toBe("intent-B");
  });
});
