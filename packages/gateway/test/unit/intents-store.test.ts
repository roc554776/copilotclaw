import { describe, expect, it, beforeEach } from "vitest";
import { IntentsStore } from "../../src/intents-store.js";
import { Store } from "../../src/store.js";

function makeStoreWithIntents(): { store: Store; intentsStore: IntentsStore } {
  const store = new Store(); // in-memory SQLite
  const intentsStore = new IntentsStore();
  intentsStore.init(store);
  return { store, intentsStore };
}

describe("IntentsStore (SQLite-backed)", () => {
  let store: IntentsStore;

  beforeEach(() => {
    const { intentsStore } = makeStoreWithIntents();
    store = intentsStore;
  });

  it("recordIntent does not throw when store is initialized", () => {
    expect(() => store.recordIntent({
      sessionId: "s1",
      channelId: "ch-1",
      agentId: "agent-1",
      intent: "read the file",
      timestamp: "2026-04-14T00:00:00.000Z",
    })).not.toThrow();
  });

  it("listIntents returns entries for a channel/agent pair", () => {
    store.recordIntent({
      sessionId: "s1",
      channelId: "ch-1",
      agentId: "agent-1",
      intent: "read the file",
      timestamp: "2026-04-14T00:00:00.000Z",
    });
    const entries = store.listIntents("ch-1", "agent-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.intent).toBe("read the file");
    expect(entries[0]!.sessionId).toBe("s1");
    expect(entries[0]!.timestamp).toBe("2026-04-14T00:00:00.000Z");
  });

  it("listIntents returns newest first", () => {
    store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: "first", timestamp: "2026-04-14T00:00:01.000Z" });
    store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: "second", timestamp: "2026-04-14T00:00:02.000Z" });
    store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: "third", timestamp: "2026-04-14T00:00:03.000Z" });
    const entries = store.listIntents("ch-1", "agent-1");
    expect(entries).toHaveLength(3);
    // Newest first (ORDER BY id DESC)
    expect(entries[0]!.intent).toBe("third");
    expect(entries[1]!.intent).toBe("second");
    expect(entries[2]!.intent).toBe("first");
  });

  it("keeps different channelId/agentId pairs independent", () => {
    store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: "intent-A", timestamp: "2026-04-14T00:00:00.000Z" });
    store.recordIntent({ sessionId: "s2", channelId: "ch-2", agentId: "agent-2", intent: "intent-B", timestamp: "2026-04-14T00:00:01.000Z" });
    expect(store.listIntents("ch-1", "agent-1")).toHaveLength(1);
    expect(store.listIntents("ch-1", "agent-1")[0]!.intent).toBe("intent-A");
    expect(store.listIntents("ch-2", "agent-2")).toHaveLength(1);
    expect(store.listIntents("ch-2", "agent-2")[0]!.intent).toBe("intent-B");
    // Cross query returns nothing
    expect(store.listIntents("ch-1", "agent-2")).toHaveLength(0);
  });

  it("returns empty array for unknown channelId/agentId", () => {
    const entries = store.listIntents("nonexistent-ch", "nonexistent-agent");
    expect(entries).toHaveLength(0);
    expect(Array.isArray(entries)).toBe(true);
  });

  it("records toolCallId when provided", () => {
    store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: "do something", timestamp: "2026-04-14T00:00:00.000Z", toolCallId: "call-123" });
    const entries = store.listIntents("ch-1", "agent-1");
    expect(entries[0]!.toolCallId).toBe("call-123");
  });

  it("toolCallId is optional and may be undefined", () => {
    store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: "do something", timestamp: "2026-04-14T00:00:00.000Z" });
    const entries = store.listIntents("ch-1", "agent-1");
    expect(entries[0]!.toolCallId).toBeUndefined();
  });

  it("accumulates entries across multiple calls", () => {
    for (let i = 0; i < 5; i++) {
      store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: `intent-${i}`, timestamp: `2026-04-14T00:00:0${i}.000Z` });
    }
    expect(store.listIntents("ch-1", "agent-1")).toHaveLength(5);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: `intent-${i}`, timestamp: `2026-04-14T00:00:0${i}.000Z` });
    }
    const entries = store.listIntents("ch-1", "agent-1", 3);
    expect(entries).toHaveLength(3);
  });

  it("getIntentsBySession returns empty array (legacy compat method)", () => {
    store.recordIntent({ sessionId: "s1", channelId: "ch-1", agentId: "agent-1", intent: "legacy", timestamp: "2026-04-14T00:00:00.000Z" });
    // Legacy method always returns empty — use listIntents instead
    expect(store.getIntentsBySession("s1")).toHaveLength(0);
  });
});
