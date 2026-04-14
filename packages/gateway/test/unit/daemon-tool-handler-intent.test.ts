/**
 * Tests for the daemon's onToolCall handler logic for copilotclaw_intent.
 *
 * The handler lives inline in daemon.ts main(), so these tests replicate
 * its behavior using IntentsStore directly to verify:
 *  - copilotclaw_intent records the intent and returns { acknowledged: true }
 *  - empty intent string is not recorded
 *  - non-string intent is treated as empty and not recorded
 */
import { describe, expect, it, beforeEach } from "vitest";
import { IntentsStore } from "../../src/intents-store.js";

/** Replicates the daemon's onToolCall handler logic for copilotclaw_intent. */
function handleCopilotclawIntent(
  store: IntentsStore,
  sessionId: string,
  args: Record<string, unknown>,
): { acknowledged: boolean } | { error: string } {
  const intent = typeof args["intent"] === "string" ? args["intent"] : "";
  if (intent.length > 0) {
    store.recordIntent({
      sessionId,
      intent,
      timestamp: new Date().toISOString(),
    });
  }
  return { acknowledged: true };
}

describe("daemon onToolCall — copilotclaw_intent", () => {
  let store: IntentsStore;

  beforeEach(() => {
    store = new IntentsStore();
  });

  it("returns { acknowledged: true } for a valid intent", () => {
    const result = handleCopilotclawIntent(store, "session-1", { intent: "about to read a file" });
    expect(result).toEqual({ acknowledged: true });
  });

  it("records the intent in the store", () => {
    handleCopilotclawIntent(store, "session-1", { intent: "about to read a file" });
    const entries = store.getIntentsBySession("session-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.intent).toBe("about to read a file");
    expect(entries[0]!.sessionId).toBe("session-1");
    expect(entries[0]!.timestamp).toBeTruthy();
  });

  it("does not record when intent is empty string", () => {
    handleCopilotclawIntent(store, "session-1", { intent: "" });
    expect(store.getIntentsBySession("session-1")).toHaveLength(0);
  });

  it("does not record when intent is missing from args", () => {
    handleCopilotclawIntent(store, "session-1", {});
    expect(store.getIntentsBySession("session-1")).toHaveLength(0);
  });

  it("does not record when intent is not a string (number)", () => {
    handleCopilotclawIntent(store, "session-1", { intent: 42 });
    expect(store.getIntentsBySession("session-1")).toHaveLength(0);
  });

  it("still returns { acknowledged: true } even when intent is empty", () => {
    const result = handleCopilotclawIntent(store, "session-1", { intent: "" });
    expect(result).toEqual({ acknowledged: true });
  });

  it("records multiple intents for the same session in order", () => {
    handleCopilotclawIntent(store, "session-1", { intent: "first" });
    handleCopilotclawIntent(store, "session-1", { intent: "second" });
    const entries = store.getIntentsBySession("session-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.intent).toBe("first");
    expect(entries[1]!.intent).toBe("second");
  });

  it("records intents for different sessions independently", () => {
    handleCopilotclawIntent(store, "session-A", { intent: "intent-A" });
    handleCopilotclawIntent(store, "session-B", { intent: "intent-B" });
    expect(store.getIntentsBySession("session-A")).toHaveLength(1);
    expect(store.getIntentsBySession("session-B")).toHaveLength(1);
    expect(store.getIntentsBySession("session-A")[0]!.intent).toBe("intent-A");
    expect(store.getIntentsBySession("session-B")[0]!.intent).toBe("intent-B");
  });
});
