/**
 * Unit tests for the PhysicalSession reducer and CopilotClient reducer (agent side).
 *
 * Both are pure functions — no mocking needed.
 */

import { describe, expect, it } from "vitest";
import { reducePhysicalSession, reduceCopilotClient } from "../src/session-reducer.js";
import type { PhysicalSessionWorldState, CopilotClientWorldState } from "../src/session-events.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makePhysicalState(overrides: Partial<PhysicalSessionWorldState> = {}): PhysicalSessionWorldState {
  return {
    sessionId: "session-abc",
    physicalSessionId: undefined,
    status: "starting",
    startedAt: "2026-01-01T00:00:00.000Z",
    resolvedModel: "gpt-4.1",
    reinjectCount: 0,
    currentToolName: undefined,
    ...overrides,
  };
}

// ── StartRequested ────────────────────────────────────────────────────────────

describe("reducePhysicalSession — StartRequested", () => {
  it("fresh start: emits CreateSession command (no physicalSessionId)", () => {
    const state = makePhysicalState({ status: "stopped", physicalSessionId: undefined });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "StartRequested",
      sessionId: "session-abc",
      model: "gpt-4.1",
      physicalSessionId: undefined,
    });

    expect(newState.status).toBe("starting");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("CreateSession");
  });

  it("resume: emits ResumeSession command (physicalSessionId present)", () => {
    const state = makePhysicalState({ status: "stopped", physicalSessionId: "phys-old" });
    const { commands } = reducePhysicalSession(state, {
      type: "StartRequested",
      sessionId: "session-abc",
      model: "gpt-4.1",
      physicalSessionId: "phys-old",
    });

    expect(commands[0]!.type).toBe("ResumeSession");
    expect((commands[0] as { type: "ResumeSession"; physicalSessionId: string }).physicalSessionId).toBe("phys-old");
  });

  it("active session: no-op (cannot start while active)", () => {
    const state = makePhysicalState({ status: "waiting" });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "StartRequested",
      sessionId: "session-abc",
      model: "gpt-4.1",
      physicalSessionId: undefined,
    });

    expect(newState.status).toBe("waiting");
    expect(commands).toHaveLength(0);
  });
});

// ── SessionCreated / SessionResumed ───────────────────────────────────────────

describe("reducePhysicalSession — SessionCreated / SessionResumed", () => {
  it("SessionCreated: starting → waiting, emits SetModel + NotifyGatewayStarted + RunSessionLoop", () => {
    const state = makePhysicalState({ status: "starting" });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "SessionCreated",
      physicalSessionId: "phys-new",
    });

    expect(newState.status).toBe("waiting");
    expect(newState.physicalSessionId).toBe("phys-new");

    const types = commands.map((c) => c.type);
    expect(types).toContain("SetModel");
    expect(types).toContain("NotifyGatewayStarted");
    expect(types).toContain("RunSessionLoop");
  });

  it("SessionResumed: same transitions as SessionCreated", () => {
    const state = makePhysicalState({ status: "starting" });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "SessionResumed",
      physicalSessionId: "phys-resumed",
    });

    expect(newState.status).toBe("waiting");
    expect(newState.physicalSessionId).toBe("phys-resumed");
    expect(commands.map((c) => c.type)).toContain("NotifyGatewayStarted");
  });
});

// ── WaitToolCalled / WaitToolCompleted ────────────────────────────────────────

describe("reducePhysicalSession — WaitTool", () => {
  it("WaitToolCalled: waiting → waiting_on_wait_tool", () => {
    const state = makePhysicalState({ status: "waiting" });
    const { newState, commands } = reducePhysicalSession(state, { type: "WaitToolCalled" });

    expect(newState.status).toBe("waiting_on_wait_tool");
    expect(newState.currentToolName).toBe("copilotclaw_wait");
    expect(commands).toHaveLength(0);
  });

  it("WaitToolCompleted: waiting_on_wait_tool → waiting", () => {
    const state = makePhysicalState({ status: "waiting_on_wait_tool", currentToolName: "copilotclaw_wait" });
    const { newState, commands } = reducePhysicalSession(state, { type: "WaitToolCompleted" });

    expect(newState.status).toBe("waiting");
    expect(newState.currentToolName).toBeUndefined();
    expect(commands).toHaveLength(0);
  });

  it("WaitToolCompleted on non-wait status: no-op", () => {
    const state = makePhysicalState({ status: "processing" });
    const { newState, commands } = reducePhysicalSession(state, { type: "WaitToolCompleted" });

    expect(newState.status).toBe("processing");
    expect(commands).toHaveLength(0);
  });

  it("wait/idle race: waiting_on_wait_tool rejects IdleDetected", () => {
    const state = makePhysicalState({ status: "waiting_on_wait_tool" });
    const { newState, commands } = reducePhysicalSession(state, { type: "IdleDetected" });

    expect(newState.status).toBe("waiting_on_wait_tool");
    expect(commands).toHaveLength(0);
  });
});

// ── ToolExecutionStarted / ToolExecutionCompleted ────────────────────────────

describe("reducePhysicalSession — ToolExecution", () => {
  it("ToolExecutionStarted: waiting → processing with currentToolName set", () => {
    const state = makePhysicalState({ status: "waiting" });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "ToolExecutionStarted",
      toolName: "bash",
    });

    expect(newState.status).toBe("processing");
    expect(newState.currentToolName).toBe("bash");
    expect(commands).toHaveLength(0);
  });

  it("ToolExecutionCompleted: processing → waiting with currentToolName cleared", () => {
    const state = makePhysicalState({ status: "processing", currentToolName: "bash" });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "ToolExecutionCompleted",
      toolName: "bash",
    });

    expect(newState.status).toBe("waiting");
    expect(newState.currentToolName).toBeUndefined();
    expect(commands).toHaveLength(0);
  });
});

// ── StopRequested / DisconnectRequested ───────────────────────────────────────

describe("reducePhysicalSession — Stop / Disconnect", () => {
  it("StopRequested: active → suspended with AbortSession", () => {
    const state = makePhysicalState({ status: "processing" });
    const { newState, commands } = reducePhysicalSession(state, { type: "StopRequested" });

    expect(newState.status).toBe("suspended");
    expect(newState.currentToolName).toBeUndefined();
    expect(commands.map((c) => c.type)).toContain("AbortSession");
  });

  it("DisconnectRequested: active → suspended with AbortSession + DisconnectSession", () => {
    const state = makePhysicalState({ status: "waiting", physicalSessionId: "phys-123" });
    const { newState, commands } = reducePhysicalSession(state, { type: "DisconnectRequested" });

    expect(newState.status).toBe("suspended");
    const types = commands.map((c) => c.type);
    expect(types).toContain("AbortSession");
    expect(types).toContain("DisconnectSession");
  });
});

// ── ReinjectDecided ───────────────────────────────────────────────────────────

describe("reducePhysicalSession — ReinjectDecided", () => {
  it("increments reinjectCount and emits ReinjectSession", () => {
    const state = makePhysicalState({ status: "waiting", reinjectCount: 2 });
    const { newState, commands } = reducePhysicalSession(state, { type: "ReinjectDecided" });

    expect(newState.reinjectCount).toBe(3);
    expect(newState.status).toBe("reinject");
    expect(commands.map((c) => c.type)).toContain("ReinjectSession");
  });
});

// ── SessionEnded / ErrorOccurred ──────────────────────────────────────────────

describe("reducePhysicalSession — SessionEnded / ErrorOccurred", () => {
  it("SessionEnded(idle): status → stopped, emits NotifyGatewayEnded(reason=idle)", () => {
    const state = makePhysicalState({ status: "waiting", physicalSessionId: "phys-123" });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "SessionEnded",
      reason: "idle",
    });

    expect(newState.status).toBe("stopped");
    const ended = commands.find((c) => c.type === "NotifyGatewayEnded") as { reason: string } | undefined;
    expect(ended).toBeDefined();
    expect(ended!.reason).toBe("idle");
  });

  it("SessionEnded(error): status → suspended", () => {
    const state = makePhysicalState({ status: "processing", physicalSessionId: "phys-123" });
    const { newState } = reducePhysicalSession(state, {
      type: "SessionEnded",
      reason: "error",
    });

    expect(newState.status).toBe("suspended");
  });

  it("ErrorOccurred: status → suspended, emits NotifyGatewayEnded(reason=error)", () => {
    const state = makePhysicalState({ status: "processing", physicalSessionId: "phys-123" });
    const { newState, commands } = reducePhysicalSession(state, {
      type: "ErrorOccurred",
      error: "SDK threw",
    });

    expect(newState.status).toBe("suspended");
    const ended = commands.find((c) => c.type === "NotifyGatewayEnded") as { reason: string; error?: string } | undefined;
    expect(ended?.reason).toBe("error");
    expect(ended?.error).toBe("SDK threw");
  });
});

// ── CopilotClient reducer ─────────────────────────────────────────────────────

describe("reduceCopilotClient", () => {
  const uninitialized: CopilotClientWorldState = { status: "uninitialized" };

  it("StartRequested in uninitialized: → starting, emits StartClient", () => {
    const { newState, commands } = reduceCopilotClient(uninitialized, { type: "StartRequested" });
    expect(newState.status).toBe("starting");
    expect(commands[0]!.type).toBe("StartClient");
  });

  it("StartRequested in starting: no-op (double-start prevention)", () => {
    const state: CopilotClientWorldState = { status: "starting" };
    const { newState, commands } = reduceCopilotClient(state, { type: "StartRequested" });
    expect(newState.status).toBe("starting");
    expect(commands).toHaveLength(0);
  });

  it("StartRequested in running: no-op (double-start prevention)", () => {
    const state: CopilotClientWorldState = { status: "running" };
    const { newState, commands } = reduceCopilotClient(state, { type: "StartRequested" });
    expect(newState.status).toBe("running");
    expect(commands).toHaveLength(0);
  });

  it("StartCompleted: starting → running", () => {
    const state: CopilotClientWorldState = { status: "starting" };
    const { newState } = reduceCopilotClient(state, { type: "StartCompleted" });
    expect(newState.status).toBe("running");
  });

  it("StopRequested: running → stopping, emits StopClient", () => {
    const state: CopilotClientWorldState = { status: "running" };
    const { newState, commands } = reduceCopilotClient(state, { type: "StopRequested" });
    expect(newState.status).toBe("stopping");
    expect(commands[0]!.type).toBe("StopClient");
  });

  it("StopCompleted: → stopped", () => {
    const state: CopilotClientWorldState = { status: "stopping" };
    const { newState } = reduceCopilotClient(state, { type: "StopCompleted" });
    expect(newState.status).toBe("stopped");
  });

  it("ErrorOccurred: → stopped", () => {
    const state: CopilotClientWorldState = { status: "starting" };
    const { newState } = reduceCopilotClient(state, { type: "ErrorOccurred", error: "oops" });
    expect(newState.status).toBe("stopped");
  });
});

// ── Immutability ──────────────────────────────────────────────────────────────

describe("reducePhysicalSession — immutability", () => {
  it("original state is never mutated", () => {
    const state = makePhysicalState({ status: "waiting", reinjectCount: 0 });
    const original = { ...state };
    reducePhysicalSession(state, { type: "ReinjectDecided" });
    expect(state.reinjectCount).toBe(original.reinjectCount);
    expect(state.status).toBe(original.status);
  });

  it("no-op events return same state reference", () => {
    const state = makePhysicalState({ status: "processing" });
    const { newState } = reducePhysicalSession(state, { type: "IdleDetected" });
    // IdleDetected in non-wait-tool state is no-op
    expect(newState).toBe(state);
  });
});
