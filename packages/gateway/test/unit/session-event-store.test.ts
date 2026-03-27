import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionEventStore } from "../../src/session-event-store.js";

describe("SessionEventStore", () => {
  let tmpDir: string;
  let store: SessionEventStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-event-store-test-"));
    store = new SessionEventStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("event storage", () => {
    it("appends and retrieves events for a session", () => {
      store.appendEvent("sess-1", { type: "tool.execution_start", timestamp: "2026-03-27T00:00:00Z", data: { toolName: "bash" } });
      store.appendEvent("sess-1", { type: "tool.execution_complete", timestamp: "2026-03-27T00:00:01Z", data: {} });

      const events = store.getEvents("sess-1");
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("tool.execution_start");
      expect(events[1]!.type).toBe("tool.execution_complete");
    });

    it("returns empty array for nonexistent session", () => {
      expect(store.getEvents("nonexistent")).toHaveLength(0);
    });

    it("stores events with parentId", () => {
      store.appendEvent("sess-2", { type: "subagent.started", timestamp: "2026-03-27T00:00:00Z", data: {}, parentId: "tool-123" });
      const events = store.getEvents("sess-2");
      expect(events[0]!.parentId).toBe("tool-123");
    });

    it("lists sessions with events", () => {
      store.appendEvent("sess-a", { type: "session.idle", timestamp: "2026-03-27T00:00:00Z", data: {} });
      store.appendEvent("sess-b", { type: "session.idle", timestamp: "2026-03-27T00:00:00Z", data: {} });

      const sessions = store.listSessions();
      expect(sessions).toContain("sess-a");
      expect(sessions).toContain("sess-b");
    });
  });

  describe("storage cap", () => {
    it("enforces storage cap by deleting oldest files", () => {
      const smallStore = new SessionEventStore(tmpDir, 100); // 100 bytes cap
      // Write enough data to exceed cap
      for (let i = 0; i < 10; i++) {
        smallStore.appendEvent(`sess-cap-${i}`, { type: "test", timestamp: "2026-03-27T00:00:00Z", data: { payload: "x".repeat(50) } });
      }
      smallStore.enforceStorageCap();

      const remaining = smallStore.listSessions();
      expect(remaining.length).toBeLessThan(10);
    });
  });

  describe("original system prompt", () => {
    it("saves and retrieves original prompt by model", () => {
      store.saveOriginalPrompt({ model: "gpt-4.1", prompt: "You are a helpful assistant.", capturedAt: "2026-03-27T00:00:00Z" });

      const snap = store.getOriginalPrompt("gpt-4.1");
      expect(snap).toBeDefined();
      expect(snap!.model).toBe("gpt-4.1");
      expect(snap!.prompt).toBe("You are a helpful assistant.");
      expect(snap!.capturedAt).toBe("2026-03-27T00:00:00Z");
    });

    it("overwrites on subsequent save for same model", () => {
      store.saveOriginalPrompt({ model: "gpt-4.1", prompt: "old", capturedAt: "2026-03-27T00:00:00Z" });
      store.saveOriginalPrompt({ model: "gpt-4.1", prompt: "new", capturedAt: "2026-03-27T01:00:00Z" });

      const snap = store.getOriginalPrompt("gpt-4.1");
      expect(snap!.prompt).toBe("new");
    });

    it("returns undefined for unknown model", () => {
      expect(store.getOriginalPrompt("unknown")).toBeUndefined();
    });

    it("lists all original prompts", () => {
      store.saveOriginalPrompt({ model: "gpt-4.1", prompt: "prompt-a", capturedAt: "2026-03-27T00:00:00Z" });
      store.saveOriginalPrompt({ model: "gpt-4.1-mini", prompt: "prompt-b", capturedAt: "2026-03-27T00:00:00Z" });

      const list = store.listOriginalPrompts();
      expect(list).toHaveLength(2);
    });
  });

  describe("session system prompt", () => {
    it("saves and retrieves session prompt", () => {
      store.saveSessionPrompt("sdk-sess-1", "session prompt text", "gpt-4.1");

      const snap = store.getSessionPrompt("sdk-sess-1");
      expect(snap).toBeDefined();
      expect(snap!.sessionId).toBe("sdk-sess-1");
      expect(snap!.prompt).toBe("session prompt text");
      expect(snap!.model).toBe("gpt-4.1");
    });

    it("returns undefined for unknown session", () => {
      expect(store.getSessionPrompt("unknown")).toBeUndefined();
    });
  });
});
