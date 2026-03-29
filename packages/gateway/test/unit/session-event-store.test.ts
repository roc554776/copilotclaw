import { mkdtempSync, rmSync } from "node:fs";
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
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("event storage", () => {
    it("appends and retrieves events for a session", () => {
      store.appendEvent("sess-1", { type: "tool.execution_start", timestamp: "2026-03-27T00:00:00Z", data: { toolName: "bash" } });
      store.appendEvent("sess-1", { type: "tool.execution_complete", timestamp: "2026-03-27T00:00:01Z", data: {} });

      const events = store.getEvents("sess-1");
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("tool.execution_start");
      expect(events[0]!.data).toEqual({ toolName: "bash" });
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

    it("omits parentId when not set", () => {
      store.appendEvent("sess-3", { type: "session.idle", timestamp: "2026-03-27T00:00:00Z", data: {} });
      const events = store.getEvents("sess-3");
      expect(events[0]!.parentId).toBeUndefined();
    });

    it("lists sessions with events", () => {
      store.appendEvent("sess-a", { type: "session.idle", timestamp: "2026-03-27T00:00:00Z", data: {} });
      store.appendEvent("sess-b", { type: "session.idle", timestamp: "2026-03-27T00:00:00Z", data: {} });

      const sessions = store.listSessions();
      expect(sessions).toContain("sess-a");
      expect(sessions).toContain("sess-b");
    });
  });

  describe("paginated event retrieval", () => {
    it("returns latest N events when no cursor", () => {
      for (let i = 0; i < 10; i++) {
        store.appendEvent("sess-pg", { type: `event-${i}`, timestamp: `2026-03-30T00:00:${String(i).padStart(2, "0")}Z`, data: { i } });
      }
      const events = store.getEventsPaginated("sess-pg", 3);
      expect(events).toHaveLength(3);
      // Should be the last 3 events in ascending order
      expect(events[0]!.type).toBe("event-7");
      expect(events[2]!.type).toBe("event-9");
    });

    it("returns events before a cursor", () => {
      for (let i = 0; i < 10; i++) {
        store.appendEvent("sess-pg-before", { type: `event-${i}`, timestamp: `2026-03-30T00:00:${String(i).padStart(2, "0")}Z`, data: { i } });
      }
      const all = store.getEventsPaginated("sess-pg-before", 10);
      const pivotId = all[5]!.id!; // event-5

      const older = store.getEventsPaginated("sess-pg-before", 3, { before: pivotId });
      expect(older).toHaveLength(3);
      // Should be events 2,3,4 in ascending order
      expect(older[0]!.type).toBe("event-2");
      expect(older[2]!.type).toBe("event-4");
    });

    it("returns events after a cursor", () => {
      for (let i = 0; i < 10; i++) {
        store.appendEvent("sess-pg-after", { type: `event-${i}`, timestamp: `2026-03-30T00:00:${String(i).padStart(2, "0")}Z`, data: { i } });
      }
      const all = store.getEventsPaginated("sess-pg-after", 10);
      const pivotId = all[5]!.id!; // event-5

      const newer = store.getEventsPaginated("sess-pg-after", 3, { after: pivotId });
      expect(newer).toHaveLength(3);
      // Should be events 6,7,8 in ascending order
      expect(newer[0]!.type).toBe("event-6");
      expect(newer[2]!.type).toBe("event-8");
    });

    it("returns empty when no events before cursor", () => {
      store.appendEvent("sess-pg-empty", { type: "event-0", timestamp: "2026-03-30T00:00:00Z", data: {} });
      const all = store.getEventsPaginated("sess-pg-empty", 10);
      const firstId = all[0]!.id!;

      const older = store.getEventsPaginated("sess-pg-empty", 10, { before: firstId });
      expect(older).toHaveLength(0);
    });

    it("includes id field in returned events", () => {
      store.appendEvent("sess-pg-id", { type: "test", timestamp: "2026-03-30T00:00:00Z", data: {} });
      const events = store.getEventsPaginated("sess-pg-id", 10);
      expect(events[0]!.id).toBeDefined();
      expect(typeof events[0]!.id).toBe("number");
    });
  });

  describe("event count", () => {
    it("returns count for a session", () => {
      for (let i = 0; i < 5; i++) {
        store.appendEvent("sess-count", { type: "test", timestamp: "2026-03-30T00:00:00Z", data: {} });
      }
      expect(store.getEventCount("sess-count")).toBe(5);
    });

    it("returns 0 for nonexistent session", () => {
      expect(store.getEventCount("nonexistent")).toBe(0);
    });
  });

  describe("storage cap", () => {
    it("enforces storage cap by deleting oldest events", () => {
      const smallStore = new SessionEventStore(tmpDir, 10); // 10 events max
      for (let i = 0; i < 600; i++) {
        smallStore.appendEvent(`sess-cap`, { type: "test", timestamp: new Date(1743033600000 + i * 1000).toISOString(), data: { i } });
      }
      // Enforcement runs at insert 500 (every 500): deletes down to 10, then 100 more inserts → 110
      const events = smallStore.getEvents("sess-cap");
      expect(events.length).toBeLessThanOrEqual(110);
      expect(events.length).toBeGreaterThan(10); // some inserts after last enforcement
      smallStore.close();
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

    it("excludes effective prompts from original prompt listing", () => {
      store.saveOriginalPrompt({ model: "gpt-4.1", prompt: "original", capturedAt: "2026-03-27T00:00:00Z" });
      store.saveEffectivePrompt("sdk-sess-1", "effective prompt", "gpt-4.1");

      const list = store.listOriginalPrompts();
      expect(list).toHaveLength(1);
      expect(list[0]!.prompt).toBe("original");
    });
  });

  describe("effective system prompt", () => {
    it("saves and retrieves effective prompt", () => {
      store.saveEffectivePrompt("sdk-sess-1", "effective prompt text", "gpt-4.1");

      const snap = store.getEffectivePrompt("sdk-sess-1");
      expect(snap).toBeDefined();
      expect(snap!.sessionId).toBe("sdk-sess-1");
      expect(snap!.prompt).toBe("effective prompt text");
      expect(snap!.model).toBe("gpt-4.1");
    });

    it("returns undefined for unknown session", () => {
      expect(store.getEffectivePrompt("unknown")).toBeUndefined();
    });
  });

  describe("token usage aggregation", () => {
    it("aggregates token usage by model within time range", () => {
      store.appendEvent("sess-usage", {
        type: "assistant.usage",
        timestamp: "2026-03-30T10:00:00Z",
        data: { model: "gpt-5-mini", inputTokens: 100, outputTokens: 20 },
      });
      store.appendEvent("sess-usage", {
        type: "assistant.usage",
        timestamp: "2026-03-30T10:01:00Z",
        data: { model: "gpt-5-mini", inputTokens: 200, outputTokens: 30 },
      });
      store.appendEvent("sess-usage", {
        type: "assistant.usage",
        timestamp: "2026-03-30T10:02:00Z",
        data: { model: "gpt-4.1", inputTokens: 500, outputTokens: 50 },
      });

      const usage = store.getTokenUsage("2026-03-30T09:00:00Z", "2026-03-30T11:00:00Z");
      expect(usage).toHaveLength(2);
      const mini = usage.find((u) => u.model === "gpt-5-mini");
      expect(mini?.inputTokens).toBe(300);
      expect(mini?.outputTokens).toBe(50);
      const gpt4 = usage.find((u) => u.model === "gpt-4.1");
      expect(gpt4?.inputTokens).toBe(500);
      expect(gpt4?.outputTokens).toBe(50);
    });

    it("excludes events outside time range", () => {
      store.appendEvent("sess-range", {
        type: "assistant.usage",
        timestamp: "2026-03-30T08:00:00Z",
        data: { model: "gpt-5-mini", inputTokens: 100, outputTokens: 10 },
      });
      store.appendEvent("sess-range", {
        type: "assistant.usage",
        timestamp: "2026-03-30T12:00:00Z",
        data: { model: "gpt-5-mini", inputTokens: 200, outputTokens: 20 },
      });

      const usage = store.getTokenUsage("2026-03-30T09:00:00Z", "2026-03-30T11:00:00Z");
      expect(usage).toHaveLength(0);
    });

    it("returns empty array when no usage events exist", () => {
      const usage = store.getTokenUsage("2026-03-30T00:00:00Z", "2026-03-30T23:59:59Z");
      expect(usage).toEqual([]);
    });

    it("ignores non-usage events", () => {
      store.appendEvent("sess-other", {
        type: "tool.execution_start",
        timestamp: "2026-03-30T10:00:00Z",
        data: { toolName: "bash" },
      });
      store.appendEvent("sess-other", {
        type: "assistant.usage",
        timestamp: "2026-03-30T10:00:00Z",
        data: { model: "gpt-5-mini", inputTokens: 100, outputTokens: 10 },
      });

      const usage = store.getTokenUsage("2026-03-30T09:00:00Z", "2026-03-30T11:00:00Z");
      expect(usage).toHaveLength(1);
      expect(usage[0]?.model).toBe("gpt-5-mini");
    });
  });
});
