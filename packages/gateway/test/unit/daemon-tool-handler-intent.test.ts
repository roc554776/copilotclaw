/**
 * Tests for the daemon's copilotclaw_intent tool call handler.
 *
 * Tests import handleIntentToolCall directly from daemon.ts to ensure
 * no divergence between the test and the actual production handler.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { handleIntentToolCall } from "../../src/daemon.js";
import { IntentsStore } from "../../src/intents-store.js";

describe("daemon onToolCall — copilotclaw_intent", () => {
  let store: IntentsStore;

  beforeEach(() => {
    store = new IntentsStore();
  });

  it("returns { acknowledged: true } for a valid intent", () => {
    const result = handleIntentToolCall({ sessionId: "session-1", args: { intent: "about to read a file" } }, store);
    expect(result).toEqual({ acknowledged: true });
  });

  it("records the intent in the store", () => {
    handleIntentToolCall({ sessionId: "session-1", args: { intent: "about to read a file" } }, store);
    const entries = store.getIntentsBySession("session-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.intent).toBe("about to read a file");
    expect(entries[0]!.sessionId).toBe("session-1");
    expect(entries[0]!.timestamp).toBeTruthy();
  });

  it("does not record when intent is empty string", () => {
    handleIntentToolCall({ sessionId: "session-1", args: { intent: "" } }, store);
    expect(store.getIntentsBySession("session-1")).toHaveLength(0);
  });

  it("does not record when intent is missing from args", () => {
    handleIntentToolCall({ sessionId: "session-1", args: {} }, store);
    expect(store.getIntentsBySession("session-1")).toHaveLength(0);
  });

  it("does not record when intent is not a string (number)", () => {
    handleIntentToolCall({ sessionId: "session-1", args: { intent: 42 } }, store);
    expect(store.getIntentsBySession("session-1")).toHaveLength(0);
  });

  it("still returns { acknowledged: true } even when intent is empty", () => {
    const result = handleIntentToolCall({ sessionId: "session-1", args: { intent: "" } }, store);
    expect(result).toEqual({ acknowledged: true });
  });

  it("records multiple intents for the same session in order", () => {
    handleIntentToolCall({ sessionId: "session-1", args: { intent: "first" } }, store);
    handleIntentToolCall({ sessionId: "session-1", args: { intent: "second" } }, store);
    const entries = store.getIntentsBySession("session-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.intent).toBe("first");
    expect(entries[1]!.intent).toBe("second");
  });

  it("records intents for different sessions independently", () => {
    handleIntentToolCall({ sessionId: "session-A", args: { intent: "intent-A" } }, store);
    handleIntentToolCall({ sessionId: "session-B", args: { intent: "intent-B" } }, store);
    expect(store.getIntentsBySession("session-A")).toHaveLength(1);
    expect(store.getIntentsBySession("session-B")).toHaveLength(1);
    expect(store.getIntentsBySession("session-A")[0]!.intent).toBe("intent-A");
    expect(store.getIntentsBySession("session-B")[0]!.intent).toBe("intent-B");
  });
});
