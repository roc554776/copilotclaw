import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhysicalSessionSummary } from "../../src/ipc-client.js";
import { SessionOrchestrator } from "../../src/session-orchestrator.js";

const TEST_DIR = join(import.meta.dirname, "..", "..", "..", "..", "tmp", "test-state", "gateway", "session-orchestrator");

function makePhysicalSession(overrides?: Partial<PhysicalSessionSummary>): PhysicalSessionSummary {
  return {
    sessionId: "phys-1",
    model: "gpt-4",
    startedAt: new Date().toISOString(),
    currentState: "running",
    totalInputTokens: 100,
    totalOutputTokens: 200,
    ...overrides,
  };
}

describe("SessionOrchestrator", () => {
  describe("startSession and basic lifecycle", () => {
    it("creates a new session bound to a channel", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      expect(sessionId).toBeTruthy();
      expect(orch.hasSessionForChannel("ch-1")).toBe(true);
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(true);
      expect(orch.getSessionIdForChannel("ch-1")).toBe(sessionId);
    });

    it("returns the same sessionId when channel already has an active session", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-1");
      expect(id1).toBe(id2);
    });

    it("creates unique sessions for different channels", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");
      expect(id1).not.toBe(id2);
    });
  });

  describe("suspendSession", () => {
    it("transitions session to suspended and accumulates tokens", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updatePhysicalSession(sessionId, makePhysicalSession({ totalInputTokens: 50, totalOutputTokens: 75 }));

      orch.suspendSession(sessionId);

      const statuses = orch.getSessionStatuses();
      const session = statuses[sessionId];
      expect(session).toBeDefined();
      expect(session.status).toBe("suspended");
      expect(session.cumulativeInputTokens).toBe(50);
      expect(session.cumulativeOutputTokens).toBe(75);
      expect(session.physicalSession).toBeUndefined();
      expect(session.physicalSessionHistory).toHaveLength(1);
    });

    it("accumulates tokens across multiple suspend cycles", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");

      orch.updatePhysicalSession(sessionId, makePhysicalSession({ totalInputTokens: 100, totalOutputTokens: 200 }));
      orch.suspendSession(sessionId);

      // Revive
      orch.startSession("ch-1");
      orch.updatePhysicalSession(sessionId, makePhysicalSession({ totalInputTokens: 50, totalOutputTokens: 30 }));
      orch.suspendSession(sessionId);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.cumulativeInputTokens).toBe(150);
      expect(session.cumulativeOutputTokens).toBe(230);
      expect(session.physicalSessionHistory).toHaveLength(2);
    });

    it("does nothing for an unknown sessionId", () => {
      const orch = new SessionOrchestrator();
      expect(() => orch.suspendSession("nonexistent")).not.toThrow();
    });
  });

  describe("revive (startSession on suspended)", () => {
    it("revives a suspended session instead of creating a new one", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.suspendSession(sessionId);

      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(false);
      expect(orch.hasSessionForChannel("ch-1")).toBe(true);

      const revivedId = orch.startSession("ch-1");
      expect(revivedId).toBe(sessionId);
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(true);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.status).toBe("starting");
    });
  });

  describe("channel bindings", () => {
    it("hasSessionForChannel returns false for unknown channel", () => {
      const orch = new SessionOrchestrator();
      expect(orch.hasSessionForChannel("ch-unknown")).toBe(false);
    });

    it("hasActiveSessionForChannel returns false for suspended session", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.suspendSession(sessionId);
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(false);
    });

    it("getSessionIdForChannel returns undefined for unbound channel", () => {
      const orch = new SessionOrchestrator();
      expect(orch.getSessionIdForChannel("ch-unknown")).toBeUndefined();
    });
  });

  describe("backoff", () => {
    it("reports no backoff for unknown channel", () => {
      const orch = new SessionOrchestrator();
      expect(orch.isChannelInBackoff("ch-1")).toBe(false);
    });

    it("reports backoff after recordBackoff", () => {
      const orch = new SessionOrchestrator();
      orch.recordBackoff("ch-1", 60_000);
      expect(orch.isChannelInBackoff("ch-1")).toBe(true);
    });

    it("backoff expires after duration", () => {
      const orch = new SessionOrchestrator();
      // Set backoff that has already expired
      vi.useFakeTimers();
      try {
        orch.recordBackoff("ch-1", 1000);
        expect(orch.isChannelInBackoff("ch-1")).toBe(true);
        vi.advanceTimersByTime(1001);
        expect(orch.isChannelInBackoff("ch-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("checkSessionMaxAge", () => {
    it("returns false for a young session", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      expect(orch.checkSessionMaxAge(sessionId, 3600_000)).toBe(false);
    });

    it("returns true for an old session", () => {
      vi.useFakeTimers();
      try {
        const orch = new SessionOrchestrator();
        const sessionId = orch.startSession("ch-1");
        // Advance time so the session exceeds maxAge
        vi.advanceTimersByTime(5000);
        expect(orch.checkSessionMaxAge(sessionId, 1000)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns false for unknown session", () => {
      const orch = new SessionOrchestrator();
      expect(orch.checkSessionMaxAge("nonexistent", 1000)).toBe(false);
    });
  });

  describe("stopSession", () => {
    it("removes the session and its channel binding", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.stopSession(sessionId);

      expect(orch.hasSessionForChannel("ch-1")).toBe(false);
      expect(orch.getSessionIdForChannel("ch-1")).toBeUndefined();
      expect(orch.getSessionStatuses()[sessionId]).toBeUndefined();
    });

    it("does nothing for unknown session", () => {
      const orch = new SessionOrchestrator();
      expect(() => orch.stopSession("nonexistent")).not.toThrow();
    });
  });

  describe("getSessionStatuses", () => {
    it("returns all sessions", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");

      const statuses = orch.getSessionStatuses();
      expect(Object.keys(statuses)).toHaveLength(2);
      expect(statuses[id1]).toBeDefined();
      expect(statuses[id2]).toBeDefined();
    });

    it("returns empty object when no sessions", () => {
      const orch = new SessionOrchestrator();
      expect(orch.getSessionStatuses()).toEqual({});
    });
  });

  describe("updatePhysicalSession", () => {
    it("sets the physical session on the abstract session", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      const ps = makePhysicalSession();
      orch.updatePhysicalSession(sessionId, ps);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession).toEqual(ps);
    });

    it("does nothing for unknown session", () => {
      const orch = new SessionOrchestrator();
      expect(() => orch.updatePhysicalSession("nonexistent", makePhysicalSession())).not.toThrow();
    });
  });

  describe("updateSessionStatus", () => {
    it("updates session status", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updateSessionStatus(sessionId, "processing");

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.status).toBe("processing");
    });
  });

  describe("multiple channels independent", () => {
    it("operations on one channel do not affect another", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");

      orch.suspendSession(id1);
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(false);
      expect(orch.hasActiveSessionForChannel("ch-2")).toBe(true);

      orch.stopSession(id2);
      expect(orch.hasSessionForChannel("ch-1")).toBe(true);
      expect(orch.hasSessionForChannel("ch-2")).toBe(false);
    });

    it("backoff on one channel does not affect another", () => {
      const orch = new SessionOrchestrator();
      orch.recordBackoff("ch-1", 60_000);
      expect(orch.isChannelInBackoff("ch-1")).toBe(true);
      expect(orch.isChannelInBackoff("ch-2")).toBe(false);
    });
  });

  describe("persistence (saveState / loadState)", () => {
    const persistPath = join(TEST_DIR, "orchestrator-state.json");

    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("round-trips sessions and channel bindings", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");
      orch.updatePhysicalSession(id1, makePhysicalSession({ totalInputTokens: 10, totalOutputTokens: 20 }));
      orch.suspendSession(id1);
      orch.updateSessionStatus(id2, "processing");

      orch.saveState(persistPath);

      const orch2 = new SessionOrchestrator();
      orch2.loadState(persistPath);

      const statuses = orch2.getSessionStatuses();
      expect(Object.keys(statuses)).toHaveLength(2);
      expect(statuses[id1].status).toBe("suspended");
      expect(statuses[id1].cumulativeInputTokens).toBe(10);
      expect(statuses[id1].cumulativeOutputTokens).toBe(20);
      expect(statuses[id1].physicalSessionHistory).toHaveLength(1);
      expect(statuses[id2].status).toBe("processing");

      expect(orch2.hasSessionForChannel("ch-1")).toBe(true);
      expect(orch2.getSessionIdForChannel("ch-1")).toBe(id1);
      expect(orch2.getSessionIdForChannel("ch-2")).toBe(id2);
    });

    it("skips expired backoff entries on load", () => {
      vi.useFakeTimers();
      try {
        const orch = new SessionOrchestrator();
        orch.recordBackoff("ch-expired", 1000);
        orch.recordBackoff("ch-active", 60_000);
        orch.saveState(persistPath);

        vi.advanceTimersByTime(2000);

        const orch2 = new SessionOrchestrator();
        orch2.loadState(persistPath);

        expect(orch2.isChannelInBackoff("ch-expired")).toBe(false);
        expect(orch2.isChannelInBackoff("ch-active")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("handles missing file gracefully", () => {
      const orch = new SessionOrchestrator();
      expect(() => orch.loadState(join(TEST_DIR, "nonexistent.json"))).not.toThrow();
    });

    it("handles invalid JSON gracefully", () => {
      const badPath = join(TEST_DIR, "bad.json");
      writeFileSyncHelper(badPath, "not json");
      const orch = new SessionOrchestrator();
      expect(() => orch.loadState(badPath)).not.toThrow();
    });

    it("works with constructor persistPath", () => {
      const path = join(TEST_DIR, "ctor-persist.json");
      const orch = new SessionOrchestrator({ persistPath: path });
      orch.startSession("ch-1");
      orch.saveState();

      const orch2 = new SessionOrchestrator({ persistPath: path });
      orch2.loadState();
      expect(orch2.hasSessionForChannel("ch-1")).toBe(true);
    });
  });
});

function writeFileSyncHelper(path: string, content: string): void {
  const { writeFileSync: wfs } = require("node:fs");
  wfs(path, content, "utf-8");
}
