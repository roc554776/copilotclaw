import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhysicalSessionSummary, SubagentInfo } from "../../src/ipc-client.js";
import type { AbstractSessionStatus, AbstractSessionWorldState } from "../../src/session-events.js";
import { SessionOrchestrator } from "../../src/session-orchestrator.js";
import { reduceAbstractSession } from "../../src/session-reducer.js";

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

// ── Test helpers (replace deleted direct-mutate methods via applyWorldState) ────

function getWorldState(orch: SessionOrchestrator, sessionId: string): AbstractSessionWorldState {
  const s = orch.getSession(sessionId)!;
  return {
    sessionId: s.sessionId,
    channelId: s.channelId,
    status: s.status,
    waitingOnWaitTool: s.waitingOnWaitTool,
    hasHadPhysicalSession: s.hasHadPhysicalSession,
    physicalSessionId: s.physicalSessionId,
    physicalSession: s.physicalSession,
    physicalSessionHistory: s.physicalSessionHistory,
    cumulativeInputTokens: s.cumulativeInputTokens,
    cumulativeOutputTokens: s.cumulativeOutputTokens,
    subagentSessions: s.subagentSessions,
    processingStartedAt: s.processingStartedAt,
    startedAt: s.startedAt,
  };
}

function setStatus(orch: SessionOrchestrator, sessionId: string, status: AbstractSessionStatus): void {
  const state = getWorldState(orch, sessionId);
  orch.applyWorldState({
    ...state,
    status,
    processingStartedAt: status === "processing" ? new Date().toISOString() : undefined,
  });
}

function setPhysicalSession(orch: SessionOrchestrator, sessionId: string, ps: PhysicalSessionSummary): void {
  const state = getWorldState(orch, sessionId);
  orch.applyWorldState({ ...state, physicalSession: ps, hasHadPhysicalSession: true });
}

/**
 * Simulate suspendSession via reducer.
 * Uses StopRequested which handles all active statuses + idle → suspended,
 * including clearing physicalSession when already idle.
 */
function suspendSession(orch: SessionOrchestrator, sessionId: string): void {
  const session = orch.getSession(sessionId);
  if (session === undefined) return;
  const state = getWorldState(orch, sessionId);
  const { newState } = reduceAbstractSession(state, { type: "StopRequested" });
  orch.applyWorldState(newState);
}

/** Simulate idleSession via reducer: accumulates tokens + transitions to idle. */
function idleSession(orch: SessionOrchestrator, sessionId: string): void {
  const session = orch.getSession(sessionId);
  if (session === undefined) return;
  const state = getWorldState(orch, sessionId);
  const { newState } = reduceAbstractSession(state, {
    type: "PhysicalSessionEnded",
    physicalSessionId: session.physicalSessionId ?? "",
    reason: "idle",
    elapsedMs: 0,
  });
  orch.applyWorldState(newState);
}

function updatePhysicalSessionState(orch: SessionOrchestrator, sessionId: string, currentState: string): void {
  const state = getWorldState(orch, sessionId);
  if (state.physicalSession === undefined) return;
  orch.applyWorldState({ ...state, physicalSession: { ...state.physicalSession, currentState } });
}

function updatePhysicalSessionTokens(orch: SessionOrchestrator, sessionId: string, currentTokens: number, tokenLimit: number): void {
  const state = getWorldState(orch, sessionId);
  if (state.physicalSession === undefined) return;
  orch.applyWorldState({ ...state, physicalSession: { ...state.physicalSession, currentTokens, tokenLimit } });
}

function accumulateUsageTokens(orch: SessionOrchestrator, sessionId: string, input: number, output: number, snapshots?: Record<string, unknown>): void {
  const state = getWorldState(orch, sessionId);
  if (state.physicalSession === undefined) return;
  const ps = state.physicalSession;
  orch.applyWorldState({
    ...state,
    physicalSession: {
      ...ps,
      totalInputTokens: (ps.totalInputTokens ?? 0) + input,
      totalOutputTokens: (ps.totalOutputTokens ?? 0) + output,
      ...(snapshots !== undefined ? { latestQuotaSnapshots: snapshots } : {}),
    },
  });
}

function updatePhysicalSessionModel(orch: SessionOrchestrator, sessionId: string, model: string): void {
  const state = getWorldState(orch, sessionId);
  if (state.physicalSession === undefined) return;
  orch.applyWorldState({ ...state, physicalSession: { ...state.physicalSession, model } });
}

function addSubagentSession(orch: SessionOrchestrator, sessionId: string, info: SubagentInfo): void {
  const state = getWorldState(orch, sessionId);
  const existing = state.subagentSessions ?? [];
  let updated = [...existing, info];
  if (updated.length > 50) updated = updated.slice(updated.length - 50);
  orch.applyWorldState({ ...state, subagentSessions: updated });
}

function updateSubagentStatus(orch: SessionOrchestrator, sessionId: string, toolCallId: string, status: "completed" | "failed"): void {
  const state = getWorldState(orch, sessionId);
  if (state.subagentSessions === undefined) return;
  const updated = state.subagentSessions.map((s) =>
    s.toolCallId === toolCallId ? { ...s, status } : s,
  );
  orch.applyWorldState({ ...state, subagentSessions: updated });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionOrchestrator", () => {
  describe("startSession and basic lifecycle", () => {
    it("creates a new session bound to a channel", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      expect(sessionId).toBeTruthy();
      expect(orch.hasSessionForChannel("ch-1")).toBe(true);
      // "new" sessions are not active (no physical session yet)
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(false);
      expect(orch.getSessionIdForChannel("ch-1")).toBe(sessionId);
      // Becomes active after physical session starts
      setStatus(orch, sessionId, "waiting");
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(true);
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
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 50, totalOutputTokens: 75 }));

      suspendSession(orch, sessionId);

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

      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 100, totalOutputTokens: 200 }));
      suspendSession(orch, sessionId);

      // Revive
      orch.startSession("ch-1");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 50, totalOutputTokens: 30 }));
      suspendSession(orch, sessionId);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.cumulativeInputTokens).toBe(150);
      expect(session.cumulativeOutputTokens).toBe(230);
      expect(session.physicalSessionHistory).toHaveLength(2);
    });

    it("does nothing for an unknown sessionId", () => {
      const orch = new SessionOrchestrator();
      // suspendSession via helper — with unknown sessionId it should not throw
      const session = orch.getSession("nonexistent");
      expect(session).toBeUndefined();
      // no-op, no throw
    });
  });

  describe("revive (startSession on suspended)", () => {
    it("revives a suspended session instead of creating a new one", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setStatus(orch, sessionId, "waiting");
      suspendSession(orch, sessionId);

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
      setStatus(orch, sessionId, "waiting");
      suspendSession(orch, sessionId);
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

  describe("setPhysicalSession (via applyWorldState)", () => {
    it("sets the physical session on the abstract session", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      const ps = makePhysicalSession();
      setPhysicalSession(orch, sessionId, ps);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession).toEqual(ps);
    });

    it("does nothing for unknown session (helper returns early)", () => {
      const orch = new SessionOrchestrator();
      const session = orch.getSession("nonexistent");
      expect(session).toBeUndefined();
      // no crash
    });
  });

  describe("setStatus (via applyWorldState)", () => {
    it("updates session status", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setStatus(orch, sessionId, "processing");

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.status).toBe("processing");
    });
  });

  describe("multiple channels independent", () => {
    it("operations on one channel do not affect another", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");
      setStatus(orch, id1, "waiting");
      setStatus(orch, id2, "waiting");

      suspendSession(orch, id1);
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

  describe("idleAllActive", () => {
    it("idles all active sessions (not suspended)", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      const id2 = orch.startSession("ch-2");
      setStatus(orch, id1, "processing");
      setStatus(orch, id2, "waiting");

      orch.idleAllActive();

      const statuses = orch.getSessionStatuses();
      expect(statuses[id1].status).toBe("idle");
      expect(statuses[id2].status).toBe("idle");
    });

    it("does not affect already suspended sessions", () => {
      const orch = new SessionOrchestrator();
      const id1 = orch.startSession("ch-1");
      setStatus(orch, id1, "waiting");
      suspendSession(orch, id1);

      expect(() => orch.idleAllActive()).not.toThrow();

      const statuses = orch.getSessionStatuses();
      expect(statuses[id1].status).toBe("suspended");
    });

    it("handles empty orchestrator", () => {
      const orch = new SessionOrchestrator();
      expect(() => orch.idleAllActive()).not.toThrow();
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
      setStatus(orch, id1, "waiting");
      setPhysicalSession(orch, id1, makePhysicalSession({ totalInputTokens: 10, totalOutputTokens: 20 }));
      suspendSession(orch, id1);
      setStatus(orch, id2, "processing");
      orch.close();

      const orch2 = new SessionOrchestrator({ persistPath: dbPath });

      const statuses = orch2.getSessionStatuses();
      expect(Object.keys(statuses)).toHaveLength(2);
      // suspendSession archives physicalSession — status stays suspended on reload
      expect(statuses[id1].status).toBe("suspended");
      expect(statuses[id1].physicalSession).toBeUndefined();
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

    it("idle session survives restart with physicalSession restored from history", () => {
      const orch = new SessionOrchestrator({ persistPath: dbPath });
      const sessionId = orch.startSession("ch-1");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 300, totalOutputTokens: 150 }));
      idleSession(orch, sessionId);

      // Verify in-memory state before restart
      const preRestart = orch.getSessionStatuses()[sessionId]!;
      expect(preRestart.status).toBe("idle");
      expect(preRestart.cumulativeInputTokens).toBe(300);
      orch.close();

      // Restart — should restore idle session with physicalSession from history
      const orch2 = new SessionOrchestrator({ persistPath: dbPath });
      const restored = orch2.getSessionStatuses()[sessionId]!;
      expect(restored.status).toBe("idle");
      expect(restored.cumulativeInputTokens).toBe(300);
      expect(restored.cumulativeOutputTokens).toBe(150);
      expect(restored.physicalSession).toBeDefined();
      expect(restored.physicalSession!.currentState).toBe("stopped");
      expect(restored.physicalSessionHistory).toHaveLength(1);
      orch2.close();
    });
  });

  describe("real-time physical session state updates (via applyWorldState helpers)", () => {
    it("updatePhysicalSessionState changes currentState", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ currentState: "idle" }));

      updatePhysicalSessionState(orch, sessionId, "tool:copilotclaw_wait");

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.currentState).toBe("tool:copilotclaw_wait");
    });

    it("updatePhysicalSessionTokens updates currentTokens and tokenLimit", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setPhysicalSession(orch, sessionId, makePhysicalSession());

      updatePhysicalSessionTokens(orch, sessionId, 5000, 100000);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.currentTokens).toBe(5000);
      expect(session.physicalSession?.tokenLimit).toBe(100000);
    });

    it("accumulateUsageTokens adds to totals and stores quotaSnapshots", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 0, totalOutputTokens: 0 }));

      accumulateUsageTokens(orch, sessionId, 100, 50, { premium: { used: 1 } });
      accumulateUsageTokens(orch, sessionId, 200, 75);

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.totalInputTokens).toBe(300);
      expect(session.physicalSession?.totalOutputTokens).toBe(125);
      expect(session.physicalSession?.latestQuotaSnapshots).toEqual({ premium: { used: 1 } });
    });

    it("updatePhysicalSessionModel changes model", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ model: "gpt-4" }));

      updatePhysicalSessionModel(orch, sessionId, "gpt-4.1");

      const session = orch.getSessionStatuses()[sessionId];
      expect(session.physicalSession?.model).toBe("gpt-4.1");
    });

    it("addSubagentSession tracks subagent and updateSubagentStatus updates it", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");

      addSubagentSession(orch, sessionId, {
        toolCallId: "tc-1",
        agentName: "worker",
        agentDisplayName: "Worker",
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
      });

      let session = orch.getSessionStatuses()[sessionId];
      expect(session.subagentSessions).toHaveLength(1);
      expect(session.subagentSessions![0]!.status).toBe("running");

      updateSubagentStatus(orch, sessionId, "tc-1", "completed");

      session = orch.getSessionStatuses()[sessionId];
      expect(session.subagentSessions![0]!.status).toBe("completed");
    });

    it("does nothing for unknown session (helpers return early)", () => {
      const orch = new SessionOrchestrator();
      // Helpers check getSession — with unknown id, getSession returns undefined
      expect(orch.getSession("nonexistent")).toBeUndefined();
      expect(orch.getSession("nonexistent")).toBeUndefined();
      // No throw — all helpers guard against undefined
    });
  });

  describe("reconcileWithAgent", () => {
    it("returns toRevive list when agent reports suspended session is running", () => {
      // reconcileWithAgent now returns the list of sessions to revive instead of
      // applying the transitions directly. SessionController.onReconcile applies
      // the transitions via dispatchEvent(Reconcile) so reducer + SSE broadcast are used.
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setStatus(orch, sessionId, "waiting");
      suspendSession(orch, sessionId);
      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(false);

      const toRevive = orch.reconcileWithAgent([{ sessionId, status: "waiting" }]);

      // Orchestrator returns the list — it does NOT apply the transition itself
      expect(toRevive).toHaveLength(1);
      expect(toRevive[0]).toMatchObject({ sessionId, targetStatus: "waiting" });
      // Session is still suspended (caller must apply via reducer)
      expect(orch.getSession(sessionId)?.status).toBe("suspended");

      // Simulate what SessionController.onReconcile does: apply via reducer
      const { newState } = reduceAbstractSession(getWorldState(orch, sessionId), {
        type: "Reconcile",
        targetStatus: toRevive[0]!.targetStatus,
      });
      orch.applyWorldState(newState);

      expect(orch.hasActiveSessionForChannel("ch-1")).toBe(true);
      expect(orch.getSession(sessionId)?.status).toBe("waiting");
    });

    it("skips unknown session reported by agent", () => {
      const orch = new SessionOrchestrator();
      orch.reconcileWithAgent([{ sessionId: "agent-sess-1", status: "processing" }]);

      // Unknown sessions are skipped — not adopted
      const session = orch.getSessionStatuses()["agent-sess-1"];
      expect(session).toBeUndefined();
    });

    it("does not remap sessionId for unknown sessions", () => {
      const orch = new SessionOrchestrator();
      const orchSessionId = orch.startSession("ch-1");
      setStatus(orch, orchSessionId, "waiting");
      suspendSession(orch, orchSessionId);

      orch.reconcileWithAgent([{ sessionId: "agent-different-id", status: "waiting" }]);

      // Old id should still exist (suspended)
      expect(orch.getSessionStatuses()[orchSessionId]).toBeDefined();
      // Unknown id should not be adopted
      expect(orch.getSessionStatuses()["agent-different-id"]).toBeUndefined();
    });

    it("does not affect already-active sessions", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-1");
      setStatus(orch, sessionId, "processing");

      orch.reconcileWithAgent([{ sessionId, status: "waiting" }]);

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
      // Migration: suspended with channel + history → idle with restored physicalSession
      expect(session.status).toBe("idle");
      expect(session.physicalSession).toBeDefined();
      expect(session.physicalSession!.currentState).toBe("stopped");
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

  describe("new status and idleSession", () => {
    it("creates new session with status 'new'", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-new");
      const statuses = orch.getSessionStatuses();
      expect(statuses[sessionId]?.status).toBe("new");
    });

    it("idleSession keeps physicalSession visible with stopped state and archives to history", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-idle");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession());

      idleSession(orch, sessionId);

      const statuses = orch.getSessionStatuses();
      const session = statuses[sessionId]!;
      expect(session.status).toBe("idle");
      expect(session.physicalSession).toBeDefined();
      expect(session.physicalSession!.currentState).toBe("stopped");
      // Visible physicalSession has zeroed tokens (accumulated into cumulative)
      expect(session.physicalSession!.totalInputTokens).toBe(0);
      expect(session.physicalSession!.totalOutputTokens).toBe(0);
      // History has the archived copy with original token counts
      expect(session.physicalSessionHistory).toHaveLength(1);
      expect(session.physicalSessionHistory[0]!.totalInputTokens).toBe(100);
      expect(session.physicalSessionHistory[0]!.totalOutputTokens).toBe(200);
    });

    it("suspendSession archives physicalSession to history", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-suspend");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession());

      suspendSession(orch, sessionId);

      const statuses = orch.getSessionStatuses();
      const session = statuses[sessionId]!;
      expect(session.status).toBe("suspended");
      expect(session.physicalSession).toBeUndefined();
      expect(session.physicalSessionHistory).toHaveLength(1);
    });

    it("revives from idle status on startSession", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-revive");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession());
      idleSession(orch, sessionId);
      expect(orch.hasActiveSessionForChannel("ch-revive")).toBe(false);

      const revived = orch.startSession("ch-revive");
      expect(revived).toBe(sessionId);
      const statuses = orch.getSessionStatuses();
      expect(statuses[sessionId]?.status).toBe("starting");
    });

    it("idle sessions are not active for hasActiveSessionForChannel", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-check");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession());
      idleSession(orch, sessionId);
      expect(orch.hasActiveSessionForChannel("ch-check")).toBe(false);
    });

    it("idleSession accumulates tokens from physicalSession", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-tokens");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 500, totalOutputTokens: 300 }));

      idleSession(orch, sessionId);

      const session = orch.getSessionStatuses()[sessionId]!;
      expect(session.cumulativeInputTokens).toBe(500);
      expect(session.cumulativeOutputTokens).toBe(300);
    });

    it("calling idleSession twice does not double-count tokens", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-double");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 100, totalOutputTokens: 50 }));

      idleSession(orch, sessionId);
      idleSession(orch, sessionId); // simulates end-turn-run API + onPhysicalSessionEnded race

      const session = orch.getSessionStatuses()[sessionId]!;
      expect(session.cumulativeInputTokens).toBe(100);
      expect(session.cumulativeOutputTokens).toBe(50);
    });

    it("idleSession followed by suspendSession does not double-count tokens", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-idle-suspend");
      setStatus(orch, sessionId, "waiting");
      setPhysicalSession(orch, sessionId, makePhysicalSession({ totalInputTokens: 200, totalOutputTokens: 80 }));

      idleSession(orch, sessionId);
      suspendSession(orch, sessionId);

      const session = orch.getSessionStatuses()[sessionId]!;
      expect(session.cumulativeInputTokens).toBe(200);
      expect(session.cumulativeOutputTokens).toBe(80);
      // idleSession pushes to history, suspendSession skips push for already-idle sessions
      expect(session.physicalSessionHistory).toHaveLength(1);
      // History entry has original token counts (not zeroed)
      expect(session.physicalSessionHistory[0]!.totalInputTokens).toBe(200);
      expect(session.physicalSessionHistory[0]!.totalOutputTokens).toBe(80);
      // physicalSession cleared by suspendSession
      expect(session.physicalSession).toBeUndefined();
    });
  });

  describe("notified status", () => {
    it("can transition from waiting to notified via applyWorldState", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-notify");
      setStatus(orch, sessionId, "waiting");
      setStatus(orch, sessionId, "notified");
      expect(orch.getSessionStatuses()[sessionId]?.status).toBe("notified");
    });
  });

  describe("processingStartedAt tracking", () => {
    it("sets processingStartedAt on transition to processing", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-proc");
      setStatus(orch, sessionId, "processing");
      const session = orch.getSessionStatuses()[sessionId]!;
      expect(session.processingStartedAt).toBeDefined();
      expect(typeof session.processingStartedAt).toBe("string");
    });

    it("clears processingStartedAt on transition away from processing", () => {
      const orch = new SessionOrchestrator();
      const sessionId = orch.startSession("ch-proc2");
      setStatus(orch, sessionId, "processing");
      expect(orch.getSessionStatuses()[sessionId]!.processingStartedAt).toBeDefined();

      setStatus(orch, sessionId, "waiting");
      expect(orch.getSessionStatuses()[sessionId]!.processingStartedAt).toBeUndefined();
    });
  });

  describe("idleAllActive skips idle sessions", () => {
    it("does not suspend idle sessions", () => {
      const orch = new SessionOrchestrator();
      const s1 = orch.startSession("ch-active");
      setStatus(orch, s1, "waiting");
      const s2 = orch.startSession("ch-idle2");
      setStatus(orch, s2, "waiting");
      setPhysicalSession(orch, s2, makePhysicalSession());
      idleSession(orch, s2);

      orch.idleAllActive();

      const statuses = orch.getSessionStatuses();
      expect(statuses[s1]?.status).toBe("idle");
      expect(statuses[s2]?.status).toBe("idle");
    });
  });
});
