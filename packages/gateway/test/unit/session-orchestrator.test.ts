import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  describe("suspendAllActive", () => {
    it("suspends all non-suspended sessions", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");
      orch.updateSessionStatus(id1, "processing");
      orch.updateSessionStatus(id2, "waiting");

      orch.suspendAllActive();

      const statuses = orch.getSessionStatuses();
      expect(statuses[id1].status).toBe("suspended");
      expect(statuses[id2].status).toBe("suspended");
    });

    it("does not affect already suspended sessions", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      orch.suspendSession(id1);

      expect(() => orch.suspendAllActive()).not.toThrow();

      const statuses = orch.getSessionStatuses();
      expect(statuses[id1].status).toBe("suspended");
    });

    it("handles empty orchestrator", () => {
      const orch = new SessionOrchestrator();
      expect(() => orch.suspendAllActive()).not.toThrow();
    });
  });

  describe("SQLite persistence", () => {
    const dbPath = join(TEST_DIR, "orchestrator-state.db");

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

    it("round-trips sessions and channel bindings across restarts", () => {
      const orch = new SessionOrchestrator({ persistPath: dbPath });
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");
      orch.updatePhysicalSession(id1, makePhysicalSession({ totalInputTokens: 10, totalOutputTokens: 20 }));
      orch.suspendSession(id1);
      orch.updateSessionStatus(id2, "processing");
      orch.close();

      const orch2 = new SessionOrchestrator({ persistPath: dbPath });

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
      orch2.close();
    });

    it("persists stopSession deletions", () => {
      const orch = new SessionOrchestrator({ persistPath: dbPath });
      const id1 = orch.startSession("ch-1");
      orch.stopSession(id1);
      orch.close();

      const orch2 = new SessionOrchestrator({ persistPath: dbPath });
      expect(orch2.getSessionStatuses()[id1]).toBeUndefined();
      expect(orch2.hasSessionForChannel("ch-1")).toBe(false);
      orch2.close();
    });

    it("persists immediately on mutation", () => {
      const orch = new SessionOrchestrator({ persistPath: dbPath });
      const id1 = orch.startSession("ch-1");
      // Do NOT call close — simulate a crash
      // Re-open the DB
      const orch2 = new SessionOrchestrator({ persistPath: dbPath });
      expect(orch2.hasSessionForChannel("ch-1")).toBe(true);
      expect(orch2.getSessionIdForChannel("ch-1")).toBe(id1);
      orch.close();
      orch2.close();
    });
  });

  describe("real-time physical session state updates from events", () => {
    it("updatePhysicalSessionState changes currentState", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updatePhysicalSession(sessionId, makePhysicalSession({ currentState: "idle" }));

      orch.updatePhysicalSessionState(sessionId, "tool:copilotclaw_wait");

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.currentState).toBe("tool:copilotclaw_wait");
    });

    it("updatePhysicalSessionTokens updates currentTokens and tokenLimit", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updatePhysicalSession(sessionId, makePhysicalSession());

      orch.updatePhysicalSessionTokens(sessionId, 5000, 100000);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.currentTokens).toBe(5000);
      expect(session.physicalSession?.tokenLimit).toBe(100000);
    });

    it("accumulateUsageTokens adds to totals and stores quotaSnapshots", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updatePhysicalSession(sessionId, makePhysicalSession({ totalInputTokens: 0, totalOutputTokens: 0 }));

      orch.accumulateUsageTokens(sessionId, 100, 50, { premium: { used: 1 } });
      orch.accumulateUsageTokens(sessionId, 200, 75);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.totalInputTokens).toBe(300);
      expect(session.physicalSession?.totalOutputTokens).toBe(125);
      expect(session.physicalSession?.latestQuotaSnapshots).toEqual({ premium: { used: 1 } });
    });

    it("updatePhysicalSessionModel changes model", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updatePhysicalSession(sessionId, makePhysicalSession({ model: "gpt-4" }));

      orch.updatePhysicalSessionModel(sessionId, "gpt-4.1");

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.model).toBe("gpt-4.1");
    });

    it("addSubagentSession tracks subagent and updateSubagentStatus updates it", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");

      orch.addSubagentSession(sessionId, {
        toolCallId: "tc-1",
        agentName: "worker",
        agentDisplayName: "Worker",
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
      });

      let session = orch.getSessionStatuses()[sessionId];
      expect(session.subagentSessions).toHaveLength(1);
      expect(session.subagentSessions![0]!.status).toBe("running");

      orch.updateSubagentStatus(sessionId, "tc-1", "completed");

      session = orch.getSessionStatuses()[sessionId];
      expect(session.subagentSessions![0]!.status).toBe("completed");
    });

    it("findSessionByCopilotId returns correct orchestrator sessionId", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updatePhysicalSession(sessionId, makePhysicalSession({ sessionId: "copilot-abc" }));

      expect(orch.findSessionByCopilotId("copilot-abc")).toBe(sessionId);
      expect(orch.findSessionByCopilotId("nonexistent")).toBeUndefined();
    });

    it("does nothing for unknown session", () => {
      const orch = new SessionOrchestrator();
      expect(() => orch.updatePhysicalSessionState("nonexistent", "idle")).not.toThrow();
      expect(() => orch.updatePhysicalSessionTokens("nonexistent", 0, 0)).not.toThrow();
      expect(() => orch.accumulateUsageTokens("nonexistent", 0, 0)).not.toThrow();
      expect(() => orch.updatePhysicalSessionModel("nonexistent", "gpt-4")).not.toThrow();
      expect(() => orch.addSubagentSession("nonexistent", { toolCallId: "t", agentName: "w", agentDisplayName: "W", status: "running", startedAt: "" })).not.toThrow();
      expect(() => orch.updateSubagentStatus("nonexistent", "t", "completed")).not.toThrow();
    });
  });

  describe("reconcileWithAgent", () => {
    it("revives suspended session when agent reports it running", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.suspendSession(sessionId);
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(false);

      orch.reconcileWithAgent([{ sessionId, channelId: "ch-1", status: "waiting" }]);

      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(true);
      const session = orch.getSessionStatuses()[sessionId];
      expect(session.status).toBe("waiting");
    });

    it("adopts unknown session reported by agent", () => {
      const orch = new SessionOrchestrator();
      orch.reconcileWithAgent([{ sessionId: "agent-sess-1", channelId: "ch-new", status: "processing" }]);

      expect(orch.hasActiveSessionForChannel("ch-new")).toBe(true);
      const session = orch.getSessionStatuses()["agent-sess-1"];
      expect(session).toBeDefined();
      expect(session.status).toBe("processing");
      expect(session.channelId).toBe("ch-new");
    });

    it("remaps sessionId when agent's id differs from orchestrator's", () => {
      const orch = new SessionOrchestrator();
      const orchSessionId = orch.startSession("ch-1");
      orch.suspendSession(orchSessionId);

      orch.reconcileWithAgent([{ sessionId: "agent-different-id", channelId: "ch-1", status: "waiting" }]);

      // Old id should be gone
      expect(orch.getSessionStatuses()[orchSessionId]).toBeUndefined();
      // New id should exist
      const session = orch.getSessionStatuses()["agent-different-id"];
      expect(session).toBeDefined();
      expect(session.status).toBe("waiting");
      expect(orch.getSessionIdForChannel("ch-1")).toBe("agent-different-id");
    });

    it("does not affect already-active sessions", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      orch.updateSessionStatus(sessionId, "processing");

      orch.reconcileWithAgent([{ sessionId, channelId: "ch-1", status: "waiting" }]);

      // Should remain processing (already active, no change needed)
      const session = orch.getSessionStatuses()[sessionId];
      expect(session.status).toBe("processing");
    });

    it("handles empty running sessions list", () => {
      const orch = new SessionOrchestrator();
      orch.startSession("ch-1");
      expect(() => orch.reconcileWithAgent([])).not.toThrow();
    });
  });

  describe("legacy migration", () => {
    const dbPath = join(TEST_DIR, "migration-test.db");
    const legacyPath = join(TEST_DIR, "agent-bindings.json");

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

    it("migrates sessions from legacy orchestrator JSON format", () => {
      const legacyData = {
        sessions: [
          {
            sessionId: "sess-1",
            channelId: "ch-1",
            status: "suspended",
            startedAt: "2026-01-01T00:00:00.000Z",
            copilotSessionId: "copilot-1",
            cumulativeInputTokens: 100,
            cumulativeOutputTokens: 200,
            physicalSessionHistory: [{ sessionId: "phys-1", model: "gpt-4", startedAt: "2026-01-01T00:00:00.000Z", currentState: "stopped" }],
          },
        ],
        channelBindings: { "ch-1": "sess-1" },
        channelBackoff: {},
      };
      writeFileSync(legacyPath, JSON.stringify(legacyData), "utf-8");

      const orch = new SessionOrchestrator({ persistPath: dbPath, legacyBindingsPath: legacyPath });

      expect(orch.hasSessionForChannel("ch-1")).toBe(true);
      const session = orch.getSessionStatuses()["sess-1"];
      expect(session).toBeDefined();
      expect(session.status).toBe("suspended");
      expect(session.cumulativeInputTokens).toBe(100);
      expect(session.physicalSessionHistory).toHaveLength(1);
      orch.close();
    });

    it("renames legacy file after migration", () => {
      writeFileSync(legacyPath, JSON.stringify({ sessions: [] }), "utf-8");
      const orch = new SessionOrchestrator({ persistPath: dbPath, legacyBindingsPath: legacyPath });

      const { existsSync } = require("node:fs");
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
      orch.close();
    });

    it("skips migration when legacy file does not exist", () => {
      const orch = new SessionOrchestrator({ persistPath: dbPath, legacyBindingsPath: join(TEST_DIR, "nonexistent.json") });
      expect(Object.keys(orch.getSessionStatuses())).toHaveLength(0);
      orch.close();
    });

    it("skips migration when DB already has sessions", () => {
      // Pre-populate DB
      const orch1 = new SessionOrchestrator({ persistPath: dbPath });
      orch1.startSession("ch-existing");
      orch1.close();

      // Write legacy file
      writeFileSync(legacyPath, JSON.stringify({
        sessions: [{ sessionId: "sess-legacy", channelId: "ch-legacy", status: "suspended", startedAt: "2026-01-01T00:00:00.000Z" }],
      }), "utf-8");

      const orch2 = new SessionOrchestrator({ persistPath: dbPath, legacyBindingsPath: legacyPath });
      expect(orch2.hasSessionForChannel("ch-existing")).toBe(true);
      expect(orch2.hasSessionForChannel("ch-legacy")).toBe(false);
      orch2.close();
    });
  });
});
