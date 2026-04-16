/**
 * Unit tests for the AbstractSession reducer (pure function).
 *
 * Each test exercises a specific event type × status combination.
 * Tests verify state transitions AND emitted commands without any side effects.
 */

import { describe, expect, it } from "vitest";
import { reduceAbstractSession } from "../../src/session-reducer.js";
import type { AbstractSessionWorldState } from "../../src/session-events.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AbstractSessionWorldState> = {}): AbstractSessionWorldState {
  return {
    sessionId: "session-abc",
    channelId: "channel-xyz",
    status: "new",
    waitingOnWaitTool: false,
    hasHadPhysicalSession: false,
    physicalSessionId: undefined,
    physicalSession: undefined,
    physicalSessionHistory: [],
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    subagentSessions: undefined,
    processingStartedAt: undefined,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePhysicalSession(overrides: Partial<import("../../src/ipc-client.js").PhysicalSessionSummary> = {}): import("../../src/ipc-client.js").PhysicalSessionSummary {
  return {
    sessionId: "phys-123",
    model: "gpt-4.1",
    startedAt: "2026-01-01T00:00:00.000Z",
    currentState: "idle",
    totalInputTokens: 100,
    totalOutputTokens: 50,
    ...overrides,
  };
}

// ── PhysicalSessionStarted ────────────────────────────────────────────────────

describe("reduceAbstractSession — PhysicalSessionStarted", () => {
  it("starting → waiting with physical session set and hasHadPhysicalSession=true", () => {
    const state = makeState({ status: "starting" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionStarted",
      physicalSessionId: "phys-999",
      model: "claude-sonnet",
    });

    expect(newState.status).toBe("waiting");
    expect(newState.physicalSessionId).toBe("phys-999");
    expect(newState.physicalSession).toBeDefined();
    expect(newState.physicalSession!.model).toBe("claude-sonnet");
    expect(newState.hasHadPhysicalSession).toBe(true);

    const types = commands.map((c) => c.type);
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
    expect(commands.find((c) => c.type === "BroadcastStatusChange")).toMatchObject({
      sessionId: "session-abc",
      status: "waiting",
    });
  });

  it("idle → waiting is invalid — no transition (PhysicalSessionStarted rejected)", () => {
    const state = makeState({ status: "idle" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionStarted",
      physicalSessionId: "phys-999",
      model: "claude-sonnet",
    });

    // Invalid transition: idle → waiting is not in VALID_TRANSITIONS
    expect(newState.status).toBe("idle");
    expect(commands).toHaveLength(0);
  });
});

// ── PhysicalSessionEnded ──────────────────────────────────────────────────────

describe("reduceAbstractSession — PhysicalSessionEnded", () => {
  it("reason=idle: transitions to idle and accumulates tokens", () => {
    const ps = makePhysicalSession({ totalInputTokens: 200, totalOutputTokens: 100 });
    const state = makeState({ status: "waiting", physicalSession: ps, physicalSessionId: "phys-123" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "idle",
      elapsedMs: 5000,
    });

    expect(newState.status).toBe("idle");
    expect(newState.cumulativeInputTokens).toBe(200);
    expect(newState.cumulativeOutputTokens).toBe(100);
    expect(newState.physicalSessionHistory).toHaveLength(1);
    expect(newState.subagentSessions).toBeUndefined();
    expect(newState.waitingOnWaitTool).toBe(false);

    const types = commands.map((c) => c.type);
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
    // No backoff for idle reason
    expect(types).not.toContain("RecordBackoff");
    // No system message for clean idle
    expect(types).not.toContain("AddSystemMessage");
  });

  it("reason=error: transitions to suspended, records backoff on rapid failure, adds system message", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "processing", physicalSession: ps, physicalSessionId: "phys-123" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "error",
      elapsedMs: 5000, // < 30s threshold → rapid failure
      error: "something went wrong",
    });

    expect(newState.status).toBe("suspended");
    const types = commands.map((c) => c.type);
    expect(types).toContain("RecordBackoff");
    expect(types).toContain("AddSystemMessage");
    expect(types).toContain("FlushPendingMessages");
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
  });

  it("reason=error with elapsed > 30s: no backoff", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "processing", physicalSession: ps });
    const { commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "error",
      elapsedMs: 35_000, // > 30s → no backoff
    });

    expect(commands.map((c) => c.type)).not.toContain("RecordBackoff");
  });

  it("reason=aborted: transitions to suspended, no backoff (aborted != error)", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "processing", physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "aborted",
      elapsedMs: 1000,
    });

    expect(newState.status).toBe("suspended");
    // No backoff for aborted
    expect(commands.map((c) => c.type)).not.toContain("RecordBackoff");
    // No system message for aborted (intentional stop)
    expect(commands.map((c) => c.type)).not.toContain("AddSystemMessage");
  });

  it("already idle: PhysicalSessionEnded(idle) is no-op", () => {
    const state = makeState({ status: "idle" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "idle",
      elapsedMs: 1000,
    });

    expect(newState.status).toBe("idle");
    expect(commands).toHaveLength(0);
  });

  it("already suspended: PhysicalSessionEnded is no-op", () => {
    const state = makeState({ status: "suspended" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "error",
      elapsedMs: 1000,
    });

    expect(newState.status).toBe("suspended");
    expect(commands).toHaveLength(0);
  });
});

// ── ToolExecutionStarted ──────────────────────────────────────────────────────

describe("reduceAbstractSession — ToolExecutionStarted", () => {
  it("non-wait tool: waiting → processing, updates currentState", () => {
    const ps = makePhysicalSession({ currentState: "idle" });
    const state = makeState({ status: "waiting", physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "ToolExecutionStarted",
      toolName: "bash",
    });

    expect(newState.status).toBe("processing");
    expect(newState.physicalSession?.currentState).toBe("tool:bash");

    const types = commands.map((c) => c.type);
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
  });

  it("copilotclaw_wait tool: sets waitingOnWaitTool=true and stays in waiting", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "waiting", physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "ToolExecutionStarted",
      toolName: "copilotclaw_wait",
    });

    expect(newState.status).toBe("waiting"); // stays in waiting
    expect(newState.waitingOnWaitTool).toBe(true);
    expect(newState.physicalSession?.currentState).toBe("tool:copilotclaw_wait");

    const types = commands.map((c) => c.type);
    // Transition to same status (waiting→waiting) — but canTransition returns false for same
    // Actually, waiting→waiting is invalid per VALID_TRANSITIONS
    // The reducer tries applyTransition(state, "waiting") which returns no-op for same status
    // So no PersistSession/BroadcastStatusChange from the transition itself
    // The flag update is on the newState though
    expect(newState.waitingOnWaitTool).toBe(true);
  });

  it("processing: copilotclaw_wait — processing → waiting with waitingOnWaitTool=true", () => {
    const state = makeState({ status: "processing" });
    const { newState } = reduceAbstractSession(state, {
      type: "ToolExecutionStarted",
      toolName: "copilotclaw_wait",
    });

    expect(newState.waitingOnWaitTool).toBe(true);
  });
});

// ── IdleDetected ──────────────────────────────────────────────────────────────

describe("reduceAbstractSession — IdleDetected", () => {
  it("waitingOnWaitTool=true: rejects idle detection (wait/idle race prevention)", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "waiting", waitingOnWaitTool: true, physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "IdleDetected",
      hasBackgroundTasks: false,
    });

    // Must NOT transition to idle
    expect(newState.status).toBe("waiting");
    expect(newState.waitingOnWaitTool).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("hasBackgroundTasks=true: rejects idle (subagent still running)", () => {
    const state = makeState({ status: "waiting" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "IdleDetected",
      hasBackgroundTasks: true,
    });

    expect(newState.status).toBe("waiting");
    expect(commands).toHaveLength(0);
  });

  it("hasBackgroundTasks=false, waitingOnWaitTool=false: updates physical session state only", () => {
    const ps = makePhysicalSession({ currentState: "tool:bash" });
    const state = makeState({ status: "waiting", physicalSession: ps, waitingOnWaitTool: false });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "IdleDetected",
      hasBackgroundTasks: false,
    });

    // IdleDetected doesn't change abstract status — only updates physical session currentState
    expect(newState.status).toBe("waiting");
    expect(newState.physicalSession?.currentState).toBe("idle");
    expect(commands).toHaveLength(0);
  });
});

// ── WaitToolCalled / WaitToolCompleted ────────────────────────────────────────

describe("reduceAbstractSession — WaitTool flags", () => {
  it("WaitToolCalled sets waitingOnWaitTool=true", () => {
    const state = makeState({ status: "waiting", waitingOnWaitTool: false });
    const { newState, commands } = reduceAbstractSession(state, { type: "WaitToolCalled" });

    expect(newState.waitingOnWaitTool).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("WaitToolCompleted clears waitingOnWaitTool and sets physical state to idle", () => {
    const ps = makePhysicalSession({ currentState: "tool:copilotclaw_wait" });
    const state = makeState({ status: "waiting", waitingOnWaitTool: true, physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, { type: "WaitToolCompleted" });

    expect(newState.waitingOnWaitTool).toBe(false);
    expect(newState.physicalSession?.currentState).toBe("idle");
    expect(commands).toHaveLength(0);
  });

  it("wait/idle race scenario: WaitToolCalled followed by IdleDetected → no idle transition", () => {
    const state = makeState({ status: "waiting" });

    // Step 1: tool starts
    const { newState: state1 } = reduceAbstractSession(state, { type: "WaitToolCalled" });
    expect(state1.waitingOnWaitTool).toBe(true);

    // Step 2: idle detected while wait tool active
    const { newState: state2, commands } = reduceAbstractSession(state1, {
      type: "IdleDetected",
      hasBackgroundTasks: false,
    });

    // Must not transition to idle
    expect(state2.status).toBe("waiting");
    expect(commands).toHaveLength(0);
  });
});

// ── StopRequested ─────────────────────────────────────────────────────────────

describe("reduceAbstractSession — StopRequested", () => {
  it("new → no-op", () => {
    const state = makeState({ status: "new" });
    const { newState, commands } = reduceAbstractSession(state, { type: "StopRequested" });
    expect(newState.status).toBe("new");
    expect(commands).toHaveLength(0);
  });

  it("starting → no-op", () => {
    const state = makeState({ status: "starting" });
    const { newState, commands } = reduceAbstractSession(state, { type: "StopRequested" });
    expect(newState.status).toBe("starting");
    expect(commands).toHaveLength(0);
  });

  it("suspended → no-op", () => {
    const state = makeState({ status: "suspended" });
    const { newState, commands } = reduceAbstractSession(state, { type: "StopRequested" });
    expect(newState.status).toBe("suspended");
    expect(commands).toHaveLength(0);
  });

  it("waiting → suspended with StopPhysicalSession + FlushPendingMessages + Persist + Broadcast", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "waiting", physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, { type: "StopRequested" });

    expect(newState.status).toBe("suspended");
    expect(newState.waitingOnWaitTool).toBe(false);

    const types = commands.map((c) => c.type);
    expect(types).toContain("StopPhysicalSession");
    expect(types).toContain("FlushPendingMessages");
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
  });

  it("processing → suspended", () => {
    const state = makeState({ status: "processing" });
    const { newState } = reduceAbstractSession(state, { type: "StopRequested" });
    expect(newState.status).toBe("suspended");
  });

  it("idle → suspended", () => {
    const state = makeState({ status: "idle" });
    const { newState } = reduceAbstractSession(state, { type: "StopRequested" });
    expect(newState.status).toBe("suspended");
  });
});

// ── ReviveRequested ───────────────────────────────────────────────────────────

describe("reduceAbstractSession — ReviveRequested", () => {
  it("suspended → starting", () => {
    const state = makeState({ status: "suspended" });
    const { newState, commands } = reduceAbstractSession(state, { type: "ReviveRequested" });

    expect(newState.status).toBe("starting");
    const types = commands.map((c) => c.type);
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
  });

  it("idle → starting", () => {
    const state = makeState({ status: "idle" });
    const { newState } = reduceAbstractSession(state, { type: "ReviveRequested" });
    expect(newState.status).toBe("starting");
  });

  it("already active (waiting) → no-op", () => {
    const state = makeState({ status: "waiting" });
    const { newState, commands } = reduceAbstractSession(state, { type: "ReviveRequested" });
    expect(newState.status).toBe("waiting");
    expect(commands).toHaveLength(0);
  });
});

// ── MaxAgeExceeded ────────────────────────────────────────────────────────────

describe("reduceAbstractSession — MaxAgeExceeded", () => {
  it("active session → suspended with StopPhysicalSession", () => {
    const state = makeState({ status: "processing" });
    const { newState, commands } = reduceAbstractSession(state, { type: "MaxAgeExceeded" });

    expect(newState.status).toBe("suspended");
    expect(commands.map((c) => c.type)).toContain("StopPhysicalSession");
  });

  it("suspended → no-op", () => {
    const state = makeState({ status: "suspended" });
    const { newState, commands } = reduceAbstractSession(state, { type: "MaxAgeExceeded" });
    expect(newState.status).toBe("suspended");
    expect(commands).toHaveLength(0);
  });
});

// ── KeepaliveTimedOut ─────────────────────────────────────────────────────────

describe("reduceAbstractSession — KeepaliveTimedOut", () => {
  it("waiting → suspended (intentional constraint: keepalive only active in waiting)", () => {
    const state = makeState({ status: "waiting", waitingOnWaitTool: true });
    const { newState, commands } = reduceAbstractSession(state, { type: "KeepaliveTimedOut" });

    expect(newState.status).toBe("suspended");
    expect(newState.waitingOnWaitTool).toBe(false);
    expect(commands.map((c) => c.type)).toContain("StopPhysicalSession");
  });

  it("notified → no-op (keepalive only active in waiting — intentional constraint)", () => {
    const state = makeState({ status: "notified" });
    const { newState, commands } = reduceAbstractSession(state, { type: "KeepaliveTimedOut" });
    expect(newState.status).toBe("notified");
    expect(commands).toHaveLength(0);
  });

  it("processing → no-op (intentional constraint)", () => {
    const state = makeState({ status: "processing" });
    const { newState, commands } = reduceAbstractSession(state, { type: "KeepaliveTimedOut" });
    expect(newState.status).toBe("processing");
    expect(commands).toHaveLength(0);
  });
});

// ── Reconciliation events ─────────────────────────────────────────────────────

describe("reduceAbstractSession — Reconciliation", () => {
  it("PhysicalSessionAliveConfirmed: no-op (maintain current status)", () => {
    const state = makeState({ status: "processing" });
    const { newState, commands } = reduceAbstractSession(state, { type: "PhysicalSessionAliveConfirmed" });
    expect(newState.status).toBe("processing");
    expect(commands).toHaveLength(0);
  });

  it("PhysicalSessionAliveRefuted: active → suspended", () => {
    const state = makeState({ status: "processing" });
    const { newState, commands } = reduceAbstractSession(state, { type: "PhysicalSessionAliveRefuted" });
    expect(newState.status).toBe("suspended");
    expect(commands.map((c) => c.type)).toContain("PersistSession");
  });

  it("PhysicalSessionAliveRefuted on suspended: no-op", () => {
    const state = makeState({ status: "suspended" });
    const { newState, commands } = reduceAbstractSession(state, { type: "PhysicalSessionAliveRefuted" });
    expect(newState.status).toBe("suspended");
    expect(commands).toHaveLength(0);
  });
});

// ── Observability events ──────────────────────────────────────────────────────

describe("reduceAbstractSession — observability events (no status transition)", () => {
  it("UsageUpdated accumulates on physical session tokens", () => {
    const ps = makePhysicalSession({ totalInputTokens: 100, totalOutputTokens: 50 });
    const state = makeState({ physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "UsageUpdated",
      inputTokens: 20,
      outputTokens: 10,
    });

    expect(newState.status).toBe("new"); // unchanged
    expect(newState.physicalSession?.totalInputTokens).toBe(120);
    expect(newState.physicalSession?.totalOutputTokens).toBe(60);
    expect(commands).toHaveLength(0);
  });

  it("UsageUpdated with no physicalSession: no-op", () => {
    const state = makeState({ physicalSession: undefined });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "UsageUpdated",
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(newState.physicalSession).toBeUndefined();
    expect(commands).toHaveLength(0);
  });

  it("TokensAccumulated updates currentTokens and tokenLimit", () => {
    const ps = makePhysicalSession({ currentTokens: 0, tokenLimit: 0 });
    const state = makeState({ physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "TokensAccumulated",
      currentTokens: 4096,
      tokenLimit: 200000,
    });

    expect(newState.physicalSession?.currentTokens).toBe(4096);
    expect(newState.physicalSession?.tokenLimit).toBe(200000);
    expect(newState.status).toBe("new");
    expect(commands).toHaveLength(0);
  });

  it("ModelResolved updates model on physical session", () => {
    const ps = makePhysicalSession({ model: "gpt-4.1" });
    const state = makeState({ physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "ModelResolved",
      model: "claude-3-5-sonnet",
    });

    expect(newState.physicalSession?.model).toBe("claude-3-5-sonnet");
    expect(commands).toHaveLength(0);
  });

  it("SubagentStarted appends to subagentSessions", () => {
    const state = makeState({ subagentSessions: undefined });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "SubagentStarted",
      info: {
        toolCallId: "tc-1",
        agentName: "worker",
        agentDisplayName: "Worker",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(newState.subagentSessions).toHaveLength(1);
    expect(newState.subagentSessions![0]!.toolCallId).toBe("tc-1");
    expect(commands).toHaveLength(0);
  });

  it("SubagentStatusChanged updates matching subagent status", () => {
    const state = makeState({
      subagentSessions: [
        { toolCallId: "tc-1", agentName: "worker", agentDisplayName: "Worker", status: "running", startedAt: "2026-01-01T00:00:00.000Z" },
        { toolCallId: "tc-2", agentName: "worker", agentDisplayName: "Worker", status: "running", startedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "SubagentStatusChanged",
      toolCallId: "tc-1",
      status: "completed",
    });

    expect(newState.subagentSessions![0]!.status).toBe("completed");
    expect(newState.subagentSessions![1]!.status).toBe("running");
    expect(commands).toHaveLength(0);
  });

  it("PhysicalSessionStateUpdated updates currentState on physical session", () => {
    const ps = makePhysicalSession({ currentState: "idle" });
    const state = makeState({ physicalSession: ps });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionStateUpdated",
      currentState: "tool:bash",
    });

    expect(newState.physicalSession?.currentState).toBe("tool:bash");
    expect(commands).toHaveLength(0);
  });
});

// ── MessageDelivered ──────────────────────────────────────────────────────────

describe("reduceAbstractSession — MessageDelivered", () => {
  it("active session in waiting: transitions to notified and notifies agent", () => {
    const state = makeState({ status: "waiting" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "MessageDelivered",
      channelId: "channel-xyz",
      messageId: "msg-1",
    });

    expect(newState.status).toBe("notified");
    const types = commands.map((c) => c.type);
    expect(types).toContain("NotifyAgent");
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
  });

  it("active session in processing: notifies agent without status change", () => {
    const state = makeState({ status: "processing" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "MessageDelivered",
      channelId: "channel-xyz",
      messageId: "msg-1",
    });

    expect(newState.status).toBe("processing"); // unchanged
    const types = commands.map((c) => c.type);
    expect(types).toContain("NotifyAgent");
    expect(types).not.toContain("BroadcastStatusChange");
  });

  it("idle session: no commands (session-start is handled by effect runtime/controller)", () => {
    const state = makeState({ status: "idle" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "MessageDelivered",
      channelId: "channel-xyz",
      messageId: "msg-1",
    });

    expect(newState.status).toBe("idle");
    expect(commands).toHaveLength(0);
  });
});

// ── Regression: "starting forever stuck" (Finding 2) ─────────────────────────
//
// Scenario: startPhysicalSession was called but the agent never responds.
// The session stays in "starting" indefinitely unless MaxAgeExceeded or
// PhysicalSessionEnded(error) forces it out.

describe("regression — starting state escape paths", () => {
  it("starting + PhysicalSessionEnded(error) → suspended (agent never responded)", () => {
    const state = makeState({ status: "starting" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "",
      reason: "error",
      elapsedMs: 1000,
    });

    // Must not stay stuck in starting
    expect(newState.status).toBe("suspended");
    const types = commands.map((c) => c.type);
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
  });

  it("starting + MaxAgeExceeded → suspended (safety net for stuck starting sessions)", () => {
    const state = makeState({ status: "starting" });
    const { newState, commands } = reduceAbstractSession(state, { type: "MaxAgeExceeded" });

    expect(newState.status).toBe("suspended");
    const types = commands.map((c) => c.type);
    expect(types).toContain("StopPhysicalSession");
    expect(types).toContain("PersistSession");
  });

  it("starting + StopRequested → no-op (stop while starting is intentionally ignored)", () => {
    const state = makeState({ status: "starting" });
    const { newState, commands } = reduceAbstractSession(state, { type: "StopRequested" });

    // starting is explicitly excluded from StopRequested handling
    expect(newState.status).toBe("starting");
    expect(commands).toHaveLength(0);
  });
});

// ── Regression: "processing deadlock / pending消費なし" (Finding 3) ──────────
//
// Scenario: a message is in the pending queue, session is processing,
// then physical session ends unexpectedly. The pending message must be
// flushed (not consumed = deadlock) and recovery must be possible.

describe("regression — processing deadlock prevention", () => {
  it("processing + PhysicalSessionEnded(error) → suspended + FlushPendingMessages emitted", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "processing", physicalSession: ps, physicalSessionId: "phys-123" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "error",
      elapsedMs: 1000,
    });

    // Session transitions out of processing (no deadlock)
    expect(newState.status).toBe("suspended");
    const types = commands.map((c) => c.type);
    // FlushPendingMessages must be emitted so the pending message is not lost
    expect(types).toContain("FlushPendingMessages");
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
  });

  it("processing + PhysicalSessionEnded(aborted) → suspended + FlushPendingMessages emitted", () => {
    const ps = makePhysicalSession();
    const state = makeState({ status: "processing", physicalSession: ps, channelId: "channel-xyz" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "aborted",
      elapsedMs: 5000,
    });

    expect(newState.status).toBe("suspended");
    // FlushPendingMessages must be present to unblock pending queue
    expect(commands.map((c) => c.type)).toContain("FlushPendingMessages");
  });

  it("suspended + ReviveRequested → starting (recovery path from processing deadlock)", () => {
    const state = makeState({ status: "suspended" });
    const { newState, commands } = reduceAbstractSession(state, { type: "ReviveRequested" });

    // After deadlock recovery (suspended), the session can be revived
    expect(newState.status).toBe("starting");
    expect(commands.map((c) => c.type)).toContain("PersistSession");
    expect(commands.map((c) => c.type)).toContain("BroadcastStatusChange");
  });

  it("full deadlock-free sequence: message → processing → session ended → suspended → new message → starting", () => {
    // Start: session waiting, message arrives
    const ps = makePhysicalSession();
    let state = makeState({ status: "waiting", physicalSession: ps });

    // Message delivered → notified
    const { newState: notifiedState } = reduceAbstractSession(state, {
      type: "MessageDelivered",
      channelId: "channel-xyz",
      messageId: "msg-1",
    });
    expect(notifiedState.status).toBe("notified");

    // Tool starts → processing
    const { newState: processingState } = reduceAbstractSession(notifiedState, {
      type: "ToolExecutionStarted",
      toolName: "bash",
    });
    expect(processingState.status).toBe("processing");

    // Session ends unexpectedly
    const { newState: suspendedState, commands: suspendedCmds } = reduceAbstractSession(processingState, {
      type: "PhysicalSessionEnded",
      physicalSessionId: "phys-123",
      reason: "error",
      elapsedMs: 1000,
    });
    expect(suspendedState.status).toBe("suspended");
    // Pending queue must be flushed to prevent deadlock
    expect(suspendedCmds.map((c) => c.type)).toContain("FlushPendingMessages");

    // New message arrives → ReviveRequested leads to starting
    const { newState: startingState } = reduceAbstractSession(suspendedState, {
      type: "ReviveRequested",
    });
    expect(startingState.status).toBe("starting");
    // No deadlock: session has escaped and can start again
  });
});

// ── Regression: Reconcile event (Finding 1) ──────────────────────────────────

describe("reduceAbstractSession — Reconcile", () => {
  it("suspended → waiting via Reconcile (agent reports session still running)", () => {
    const state = makeState({ status: "suspended" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "Reconcile",
      targetStatus: "waiting",
    });

    expect(newState.status).toBe("waiting");
    const types = commands.map((c) => c.type);
    expect(types).toContain("PersistSession");
    expect(types).toContain("BroadcastStatusChange");
    expect(commands.find((c) => c.type === "BroadcastStatusChange")).toMatchObject({
      status: "waiting",
    });
  });

  it("suspended → processing via Reconcile sets processingStartedAt", () => {
    const state = makeState({ status: "suspended" });
    const { newState } = reduceAbstractSession(state, {
      type: "Reconcile",
      targetStatus: "processing",
    });

    expect(newState.status).toBe("processing");
    expect(newState.processingStartedAt).toBeDefined();
  });

  it("idle → starting via Reconcile (agent reports session running after idle)", () => {
    const state = makeState({ status: "idle" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "Reconcile",
      targetStatus: "starting",
    });

    expect(newState.status).toBe("starting");
    expect(commands.map((c) => c.type)).toContain("BroadcastStatusChange");
  });

  it("already active (processing): Reconcile is no-op", () => {
    const state = makeState({ status: "processing" });
    const { newState, commands } = reduceAbstractSession(state, {
      type: "Reconcile",
      targetStatus: "waiting",
    });

    // Already active — Reconcile must not change status
    expect(newState.status).toBe("processing");
    expect(commands).toHaveLength(0);
  });
});

// ── Immutability ──────────────────────────────────────────────────────────────

describe("reduceAbstractSession — immutability", () => {
  it("no-op events return the same state reference", () => {
    const state = makeState({ status: "processing" });
    const { newState } = reduceAbstractSession(state, { type: "KeepaliveTimedOut" });
    // KeepaliveTimedOut in processing is a no-op — same reference
    expect(newState).toBe(state);
  });

  it("transition events return a new state object", () => {
    const state = makeState({ status: "starting" });
    const { newState } = reduceAbstractSession(state, {
      type: "PhysicalSessionStarted",
      physicalSessionId: "phys-999",
      model: "gpt-4.1",
    });
    expect(newState).not.toBe(state);
  });

  it("original state is never mutated", () => {
    const state = makeState({ status: "waiting", waitingOnWaitTool: false });
    const stateCopy = { ...state };
    reduceAbstractSession(state, { type: "WaitToolCalled" });
    expect(state.waitingOnWaitTool).toBe(stateCopy.waitingOnWaitTool);
    expect(state.status).toBe(stateCopy.status);
  });
});
