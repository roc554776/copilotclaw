import { describe, expect, it, beforeEach } from "vitest";
import { IntentsStore } from "../../src/intents-store.js";

describe("IntentsStore", () => {
  let store: IntentsStore;

  beforeEach(() => {
    store = new IntentsStore();
  });

  it("records an intent entry", () => {
    store.recordIntent({ sessionId: "s1", intent: "read the file", timestamp: "2026-04-14T00:00:00.000Z" });
    const entries = store.getIntentsBySession("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.intent).toBe("read the file");
    expect(entries[0]!.sessionId).toBe("s1");
    expect(entries[0]!.timestamp).toBe("2026-04-14T00:00:00.000Z");
  });

  it("preserves insertion order for a session", () => {
    store.recordIntent({ sessionId: "s1", intent: "first", timestamp: "2026-04-14T00:00:01.000Z" });
    store.recordIntent({ sessionId: "s1", intent: "second", timestamp: "2026-04-14T00:00:02.000Z" });
    store.recordIntent({ sessionId: "s1", intent: "third", timestamp: "2026-04-14T00:00:03.000Z" });
    const entries = store.getIntentsBySession("s1");
    expect(entries).toHaveLength(3);
    expect(entries[0]!.intent).toBe("first");
    expect(entries[1]!.intent).toBe("second");
    expect(entries[2]!.intent).toBe("third");
  });

  it("keeps multiple sessions independent", () => {
    store.recordIntent({ sessionId: "s1", intent: "session1-intent", timestamp: "2026-04-14T00:00:00.000Z" });
    store.recordIntent({ sessionId: "s2", intent: "session2-intent", timestamp: "2026-04-14T00:00:01.000Z" });
    expect(store.getIntentsBySession("s1")).toHaveLength(1);
    expect(store.getIntentsBySession("s1")[0]!.intent).toBe("session1-intent");
    expect(store.getIntentsBySession("s2")).toHaveLength(1);
    expect(store.getIntentsBySession("s2")[0]!.intent).toBe("session2-intent");
  });

  it("returns empty array for unknown sessionId", () => {
    const entries = store.getIntentsBySession("nonexistent");
    expect(entries).toHaveLength(0);
    expect(Array.isArray(entries)).toBe(true);
  });

  it("clear removes all entries from all sessions", () => {
    store.recordIntent({ sessionId: "s1", intent: "intent1", timestamp: "2026-04-14T00:00:00.000Z" });
    store.recordIntent({ sessionId: "s2", intent: "intent2", timestamp: "2026-04-14T00:00:01.000Z" });
    store.clear();
    expect(store.getIntentsBySession("s1")).toHaveLength(0);
    expect(store.getIntentsBySession("s2")).toHaveLength(0);
  });

  it("records toolCallId when provided", () => {
    store.recordIntent({ sessionId: "s1", intent: "do something", timestamp: "2026-04-14T00:00:00.000Z", toolCallId: "call-123" });
    const entries = store.getIntentsBySession("s1");
    expect(entries[0]!.toolCallId).toBe("call-123");
  });

  it("toolCallId is optional and may be undefined", () => {
    store.recordIntent({ sessionId: "s1", intent: "do something", timestamp: "2026-04-14T00:00:00.000Z" });
    const entries = store.getIntentsBySession("s1");
    expect(entries[0]!.toolCallId).toBeUndefined();
  });

  it("accumulates entries for the same session across multiple calls", () => {
    for (let i = 0; i < 5; i++) {
      store.recordIntent({ sessionId: "s1", intent: `intent-${i}`, timestamp: `2026-04-14T00:00:0${i}.000Z` });
    }
    expect(store.getIntentsBySession("s1")).toHaveLength(5);
  });

  it("clear then record works correctly after clear", () => {
    store.recordIntent({ sessionId: "s1", intent: "before clear", timestamp: "2026-04-14T00:00:00.000Z" });
    store.clear();
    store.recordIntent({ sessionId: "s1", intent: "after clear", timestamp: "2026-04-14T00:00:01.000Z" });
    const entries = store.getIntentsBySession("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.intent).toBe("after clear");
  });
});
