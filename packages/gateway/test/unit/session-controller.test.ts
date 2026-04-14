import { describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/session-controller.js";
import { SessionOrchestrator } from "../../src/session-orchestrator.js";
import { Store } from "../../src/store.js";

function makeMockAgentManager() {
  return {
    notifyAgent: vi.fn(),
    startPhysicalSession: vi.fn(),
    stopPhysicalSession: vi.fn(),
    getModels: vi.fn().mockResolvedValue(null),
  } as unknown as import("../../src/agent-manager.js").AgentManager;
}

function makeController(overrides?: { store?: Store; orchestrator?: SessionOrchestrator }) {
  const store = overrides?.store ?? new Store();
  const orchestrator = overrides?.orchestrator ?? new SessionOrchestrator();
  const agentManager = makeMockAgentManager();
  const sseBroadcast = vi.fn();
  const controller = new SessionController({
    orchestrator,
    store,
    agentManager,
    resolveModelForChannel: async () => "gpt-4.1",
  });
  controller.setSseBroadcast(sseBroadcast);
  // Create a default channel
  const channelId = store.createChannel().id;
  return { controller, store, orchestrator, agentManager, sseBroadcast, channelId };
}

describe("SessionController — state transitions", () => {
  it("rejects invalid transition and logs", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    // Put session in "idle" state
    orchestrator.updateSessionStatus(sessionId, "idle");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // idle → waiting is not valid (must go through starting first)
    controller.onPhysicalSessionStarted(sessionId, "copilot-123", "gpt-4.1");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("rejected transition"));
    consoleSpy.mockRestore();
  });

  it("allows valid transition: starting → waiting via onPhysicalSessionStarted", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    // startSession sets status — force to "starting" for test
    orchestrator.updateSessionStatus(sessionId, "starting");
    controller.onPhysicalSessionStarted(sessionId, "copilot-123", "gpt-4.1");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");
  });
});

describe("SessionController — deliverMessage", () => {
  it("adds message to store and starts session when no active session", async () => {
    const { controller, store, agentManager, channelId } = makeController();
    const { msg, delivery } = await controller.deliverMessage(channelId, "user", "hello");
    expect(msg).toBeDefined();
    expect(msg!.sender).toBe("user");
    expect(delivery).toBe("session-started");
    expect((agentManager as unknown as { startPhysicalSession: ReturnType<typeof vi.fn> }).startPhysicalSession).toHaveBeenCalled();
  });

  it("notifies existing active session instead of starting new one", async () => {
    const { controller, orchestrator, agentManager, channelId } = makeController();
    // Manually set up an active session
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "waiting");
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "idle",
    });

    const { delivery } = await controller.deliverMessage(channelId, "user", "hello");
    expect(delivery).toBe("delivered");
    expect((agentManager as unknown as { notifyAgent: ReturnType<typeof vi.fn> }).notifyAgent).toHaveBeenCalledWith(sessionId);
  });

  it("does not start session for agent sender messages", async () => {
    const { controller, agentManager, channelId } = makeController();
    const { delivery } = await controller.deliverMessage(channelId, "agent", "hi");
    expect(delivery).toBe("delivered");
    expect((agentManager as unknown as { startPhysicalSession: ReturnType<typeof vi.fn> }).startPhysicalSession).not.toHaveBeenCalled();
  });

  it("transitions waiting session to notified on message arrival", async () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "waiting");
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "tool:copilotclaw_wait",
    });

    await controller.deliverMessage(channelId, "user", "hello");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("notified");
  });
});

describe("SessionController — swallowed message detection", () => {
  it("sets pendingReplyExpected only when user messages are drained", () => {
    const { controller } = makeController();
    controller.onAgentDrainedMessages("sess-1", [
      { id: "1", channelId: "ch-1", sender: "cron", message: "cron task", createdAt: "" },
    ]);
    expect(controller.checkSwallowedMessage("sess-1")).toBe(false);
  });

  it("sets pendingReplyExpected when user messages are included", () => {
    const { controller } = makeController();
    controller.onAgentDrainedMessages("sess-1", [
      { id: "1", channelId: "ch-1", sender: "user", message: "hello", createdAt: "" },
    ]);
    expect(controller.checkSwallowedMessage("sess-1")).toBe(true);
    // Second check should be false (cleared)
    expect(controller.checkSwallowedMessage("sess-1")).toBe(false);
  });

  it("clears flag on agent reply", () => {
    const { controller } = makeController();
    controller.onAgentDrainedMessages("sess-1", [
      { id: "1", channelId: "ch-1", sender: "user", message: "hello", createdAt: "" },
    ]);
    controller.onAgentReplied("sess-1");
    expect(controller.checkSwallowedMessage("sess-1")).toBe(false);
  });
});

describe("SessionController — onSessionIdle", () => {
  it("updates physical state to idle on true idle (no backgroundTasks)", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "waiting");
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "tool:copilotclaw_wait",
    });

    controller.onSessionIdle(sessionId, false);
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("idle");
  });

  it("does NOT update physical state on backgroundTasks idle", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "waiting");
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "tool:copilotclaw_wait",
    });

    controller.onSessionIdle(sessionId, true);
    // Physical state should NOT change — session is still running
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("tool:copilotclaw_wait");
  });
});

describe("SessionController — lifecycle decisions", () => {
  it("returns stop on error", () => {
    const { controller } = makeController();
    const result = controller.decideLifecycleAction("sess-1", "error");
    expect(result.action).toBe("stop");
    expect(result.clearCopilotSessionId).toBe(true);
  });

  it("always returns stop on idle (agent-side handles backgroundTasks)", () => {
    const { controller } = makeController();
    // Even after backgroundTasks idle, decideLifecycleAction returns stop
    // because agent-side session loop handles backgroundTasks continuation
    controller.onSessionIdle("sess-1", true);
    const result = controller.decideLifecycleAction("sess-1", "idle");
    expect(result.action).toBe("stop");
  });
});

describe("SessionController — onPhysicalSessionEnded", () => {
  it("clears session context on end", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "waiting");
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "idle",
    });

    // Set some context
    controller.onAgentDrainedMessages(sessionId, [
      { id: "1", channelId, sender: "user", message: "hello", createdAt: "" },
    ]);

    controller.onPhysicalSessionEnded(sessionId, "idle", 60000);
    // Context should be cleared
    expect(controller.checkSwallowedMessage(sessionId)).toBe(false);
  });

  it("transitions to idle on idle reason", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "waiting");
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "idle",
    });

    controller.onPhysicalSessionEnded(sessionId, "idle", 60000);
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("idle");
  });

  it("transitions to suspended on error", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "waiting");
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "idle",
    });

    controller.onPhysicalSessionEnded(sessionId, "error", 5000, "SDK error");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");
  });
});

describe("SessionController — SSE broadcast", () => {
  it("broadcasts session status changes", () => {
    const { controller, orchestrator, sseBroadcast, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "starting");

    controller.onPhysicalSessionStarted(sessionId, "copilot-123", "gpt-4.1");
    expect(sseBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "session_status_change",
    }));
  });

  it("includes derivedStatus in session_status_change event data", () => {
    const { controller, orchestrator, sseBroadcast, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "starting");

    controller.onPhysicalSessionStarted(sessionId, "copilot-123", "gpt-4.1");

    const calls = (sseBroadcast as ReturnType<typeof vi.fn>).mock.calls;
    const statusChangeCalls = calls.filter((c: unknown[]) => {
      const evt = c[0] as { type: string };
      return evt.type === "session_status_change";
    });
    expect(statusChangeCalls.length).toBeGreaterThan(0);
    const lastCall = statusChangeCalls[statusChangeCalls.length - 1]!;
    const evt = lastCall[0] as { type: string; data: Record<string, unknown> };
    expect(evt.data).toHaveProperty("derivedStatus");
    expect(typeof evt.data["derivedStatus"]).toBe("string");
  });

  it("derivedStatus reflects no-physical-session-initial for brand-new session (physicalSession not yet set)", () => {
    const { controller, orchestrator, sseBroadcast, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "starting");

    // onPhysicalSessionStarted broadcasts BEFORE updatePhysicalSession is called,
    // so at broadcast time physicalSession is still undefined → no-physical-session-initial
    controller.onPhysicalSessionStarted(sessionId, "copilot-123", "gpt-4.1");

    const calls = (sseBroadcast as ReturnType<typeof vi.fn>).mock.calls;
    const statusChangeCalls = calls.filter((c: unknown[]) => {
      const evt = c[0] as { type: string; data: Record<string, unknown> };
      return evt.type === "session_status_change" && evt.data["status"] === "waiting";
    });
    expect(statusChangeCalls.length).toBeGreaterThan(0);
    const lastCall = statusChangeCalls[statusChangeCalls.length - 1]!;
    const evt = lastCall[0] as { type: string; data: Record<string, unknown> };
    // At broadcast time, physicalSession is not yet set, history is empty → no-physical-session-initial
    expect(evt.data["derivedStatus"]).toBe("no-physical-session-initial");
  });

  it("derivedStatus reflects running after physicalSession is set and non-wait tool starts", () => {
    const { controller, orchestrator, sseBroadcast, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "starting");
    controller.onPhysicalSessionStarted(sessionId, "copilot-123", "gpt-4.1");

    // physicalSession is now set; start a non-wait tool → processing
    controller.onToolExecutionStart(sessionId, "bash");

    const calls = (sseBroadcast as ReturnType<typeof vi.fn>).mock.calls;
    const processingCalls = calls.filter((c: unknown[]) => {
      const evt = c[0] as { type: string; data: Record<string, unknown> };
      return evt.type === "session_status_change" && evt.data["status"] === "processing";
    });
    expect(processingCalls.length).toBeGreaterThan(0);
    const lastCall = processingCalls[processingCalls.length - 1]!;
    const evt = lastCall[0] as { type: string; data: Record<string, unknown> };
    // physicalSession is set, status is "processing" → running
    expect(evt.data["derivedStatus"]).toBe("running");
  });

  it("derivedStatus reflects running for processing status", () => {
    const { controller, orchestrator, sseBroadcast, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "starting");
    controller.onPhysicalSessionStarted(sessionId, "copilot-123", "gpt-4.1");
    // Tool execution → processing
    controller.onToolExecutionStart(sessionId, "bash");

    const calls = (sseBroadcast as ReturnType<typeof vi.fn>).mock.calls;
    const processingCalls = calls.filter((c: unknown[]) => {
      const evt = c[0] as { type: string; data: Record<string, unknown> };
      return evt.type === "session_status_change" && evt.data["status"] === "processing";
    });
    expect(processingCalls.length).toBeGreaterThan(0);
    const lastCall = processingCalls[processingCalls.length - 1]!;
    const evt = lastCall[0] as { type: string; data: Record<string, unknown> };
    expect(evt.data["derivedStatus"]).toBe("running");
  });
});

// --- Integration tests: full lifecycle flows ---

describe("SessionController — full message delivery → session lifecycle flow", () => {
  it("message arrival → session start → physical session → tool execution → wait → idle → new message restarts", async () => {
    const { controller, orchestrator, agentManager, store, channelId } = makeController();
    const am = agentManager as unknown as {
      notifyAgent: ReturnType<typeof vi.fn>;
      startPhysicalSession: ReturnType<typeof vi.fn>;
      stopPhysicalSession: ReturnType<typeof vi.fn>;
    };

    // Step: user sends message → session starts
    const { msg, delivery } = await controller.deliverMessage(channelId, "user", "hello");
    expect(msg).toBeDefined();
    expect(delivery).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalled();
    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");

    // Step: physical session started
    controller.onPhysicalSessionStarted(sessionId, "copilot-sess-1", "gpt-4.1");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");

    // Step: agent executes a non-wait tool → processing
    controller.onToolExecutionStart(sessionId, "bash");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("processing");

    // Step: tool completes
    controller.onToolExecutionComplete(sessionId);
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("idle");

    // Step: agent calls copilotclaw_wait → waiting
    controller.onToolExecutionStart(sessionId, "copilotclaw_wait");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");

    // Step: second message arrives while waiting → notified
    const { delivery: d2 } = await controller.deliverMessage(channelId, "user", "second message");
    expect(d2).toBe("delivered");
    expect(am.notifyAgent).toHaveBeenCalledWith(sessionId);
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("notified");

    // Step: agent drains messages → swallowed message tracking
    controller.onAgentDrainedMessages(sessionId, [
      { id: "m1", channelId, sender: "user", message: "second message", createdAt: "" },
    ]);
    expect(controller.checkSwallowedMessage(sessionId)).toBe(true);

    // Step: agent replies → clears swallowed flag
    controller.onAgentReplied(sessionId);
    expect(controller.checkSwallowedMessage(sessionId)).toBe(false);

    // Step: agent starts processing the drained message → processing
    controller.onToolExecutionStart(sessionId, "bash");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("processing");

    // Step: agent calls copilotclaw_wait again → waiting
    controller.onToolExecutionStart(sessionId, "copilotclaw_wait");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");

    // Step: session goes idle (LLM stops calling tools)
    controller.onSessionIdle(sessionId, false);
    controller.onPhysicalSessionEnded(sessionId, "idle", 120000);
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("idle");

    // Step: new message arrives → new session starts from idle
    am.startPhysicalSession.mockClear();
    const { delivery: d3 } = await controller.deliverMessage(channelId, "user", "third message");
    expect(d3).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalled();
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");
  });
});

describe("SessionController — backgroundTasks idle → notify → session continues", () => {
  it("backgroundTasks idle does not change physical state, agent is notified on subsequent event", async () => {
    const { controller, orchestrator, agentManager, channelId } = makeController();
    const am = agentManager as unknown as { notifyAgent: ReturnType<typeof vi.fn> };

    // Set up active session in waiting state
    await controller.deliverMessage(channelId, "user", "start");
    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    controller.onPhysicalSessionStarted(sessionId, "copilot-1", "gpt-4.1");
    controller.onToolExecutionStart(sessionId, "copilotclaw_wait");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("tool:copilotclaw_wait");

    // Step: subagent starts (task tool)
    controller.onToolExecutionStart(sessionId, "task");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("processing");

    // Step: session.idle with backgroundTasks — subagent stopped
    controller.onSessionIdle(sessionId, true);
    // Physical state should NOT change to idle
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("tool:task");
    // Status should remain processing (not idle)
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("processing");

    // Step: subagent completes, agent processes result
    controller.onToolExecutionComplete(sessionId);
    controller.onToolExecutionStart(sessionId, "copilotclaw_send_message");
    controller.onToolExecutionComplete(sessionId);
    controller.onToolExecutionStart(sessionId, "copilotclaw_wait");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");
  });

  it("multiple backgroundTasks idles followed by true idle", async () => {
    const { controller, orchestrator, channelId } = makeController();

    await controller.deliverMessage(channelId, "user", "start");
    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    controller.onPhysicalSessionStarted(sessionId, "copilot-1", "gpt-4.1");
    controller.onToolExecutionStart(sessionId, "copilotclaw_wait");

    // Multiple subagent idles — session continues
    controller.onSessionIdle(sessionId, true);
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("tool:copilotclaw_wait");
    controller.onSessionIdle(sessionId, true);
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("tool:copilotclaw_wait");

    // True idle — physical state updates
    controller.onSessionIdle(sessionId, false);
    expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("idle");
  });
});

describe("SessionController — reconcile + concurrent message arrival", () => {
  it("reconcile idles stale sessions, pending message starts new session after reconcile", async () => {
    const { controller, orchestrator, agentManager, store, channelId } = makeController();
    const am = agentManager as unknown as { startPhysicalSession: ReturnType<typeof vi.fn> };

    // Set up a session that is "starting" (stale — agent doesn't know about it)
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updateSessionStatus(sessionId, "starting");

    // Add a pending message
    store.addMessage(channelId, "user", "pending message");

    // Reconcile with empty running sessions — stale session gets idled,
    // then checkAllChannelsPending detects pending message and starts a new session
    controller.onReconcile([]);
    // Wait a tick for the async ensureSessionForChannel
    await new Promise((r) => setTimeout(r, 10));
    // The session should have been revived (idle → starting) due to pending message
    expect(am.startPhysicalSession).toHaveBeenCalled();
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");
  });

  it("message arriving during reconcile is picked up", async () => {
    const { controller, orchestrator, agentManager, store, channelId } = makeController();
    const am = agentManager as unknown as {
      startPhysicalSession: ReturnType<typeof vi.fn>;
      notifyAgent: ReturnType<typeof vi.fn>;
    };

    // Reconcile with no sessions
    controller.onReconcile([]);

    // Message arrives right after reconcile
    const { delivery } = await controller.deliverMessage(channelId, "user", "hello after reconcile");
    expect(delivery).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalled();
  });
});

describe("SessionController — error and edge cases", () => {
  it("session error → suspended, new message starts fresh session", async () => {
    const { controller, orchestrator, agentManager, store, channelId } = makeController();
    const am = agentManager as unknown as { startPhysicalSession: ReturnType<typeof vi.fn> };

    // Start session
    await controller.deliverMessage(channelId, "user", "hello");
    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    controller.onPhysicalSessionStarted(sessionId, "copilot-1", "gpt-4.1");

    // Session errors
    controller.onPhysicalSessionEnded(sessionId, "error", 5000, "SDK crash");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");

    // System message should be added
    const msgs = store.listMessages(channelId, 10);
    expect(msgs.some((m) => m.message.includes("[SYSTEM] Agent session stopped unexpectedly"))).toBe(true);

    // New message starts a new session (suspended → starting via startSession revive)
    am.startPhysicalSession.mockClear();
    const { delivery } = await controller.deliverMessage(channelId, "user", "try again");
    expect(delivery).toBe("session-started");
  });

  it("cron message triggers session start same as user message", async () => {
    const { controller, orchestrator, agentManager, channelId } = makeController();
    const am = agentManager as unknown as { startPhysicalSession: ReturnType<typeof vi.fn> };

    const { msg, delivery } = await controller.deliverMessage(channelId, "cron", "[cron:test] do work");
    expect(msg).toBeDefined();
    expect(msg!.sender).toBe("cron");
    expect(delivery).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalled();
  });

  it("system message triggers session start", async () => {
    const { controller, orchestrator, agentManager, channelId } = makeController();
    const am = agentManager as unknown as { startPhysicalSession: ReturnType<typeof vi.fn> };

    const { delivery } = await controller.deliverMessage(channelId, "system", "[SUBAGENT COMPLETED] done");
    expect(delivery).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalled();
  });

  it("agent message does NOT trigger session start", async () => {
    const { controller, agentManager, channelId } = makeController();
    const am = agentManager as unknown as { startPhysicalSession: ReturnType<typeof vi.fn> };

    const { delivery } = await controller.deliverMessage(channelId, "agent", "agent reply");
    expect(delivery).toBe("delivered");
    expect(am.startPhysicalSession).not.toHaveBeenCalled();
  });

  it("swallowed message detection only fires for user messages, not cron/system", () => {
    const { controller } = makeController();

    // Drain only cron messages
    controller.onAgentDrainedMessages("sess-1", [
      { id: "1", channelId: "ch-1", sender: "cron", message: "[cron:x] task", createdAt: "" },
      { id: "2", channelId: "ch-1", sender: "system", message: "[SUBAGENT] done", createdAt: "" },
    ]);
    expect(controller.checkSwallowedMessage("sess-1")).toBe(false);

    // Drain with a user message included
    controller.onAgentDrainedMessages("sess-1", [
      { id: "3", channelId: "ch-1", sender: "cron", message: "[cron:x] task", createdAt: "" },
      { id: "4", channelId: "ch-1", sender: "user", message: "hello", createdAt: "" },
    ]);
    expect(controller.checkSwallowedMessage("sess-1")).toBe(true);
  });

  it("stopSession via API transitions to suspended and clears context", async () => {
    const { controller, orchestrator, agentManager, channelId } = makeController();
    const am = agentManager as unknown as { stopPhysicalSession: ReturnType<typeof vi.fn> };

    await controller.deliverMessage(channelId, "user", "hello");
    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    controller.onPhysicalSessionStarted(sessionId, "copilot-1", "gpt-4.1");

    // Set some context
    controller.onAgentDrainedMessages(sessionId, [
      { id: "1", channelId, sender: "user", message: "hello", createdAt: "" },
    ]);

    controller.stopSession(sessionId);
    expect(am.stopPhysicalSession).toHaveBeenCalledWith(sessionId);
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");
    // Context cleared
    expect(controller.checkSwallowedMessage(sessionId)).toBe(false);
  });

  it("stream disconnect idles all active sessions", async () => {
    const { controller, orchestrator, channelId, store } = makeController();
    const ch2 = store.createChannel().id;

    // Start sessions on two channels
    await controller.deliverMessage(channelId, "user", "msg1");
    await controller.deliverMessage(ch2, "user", "msg2");
    const sid1 = orchestrator.getSessionIdForChannel(channelId)!;
    const sid2 = orchestrator.getSessionIdForChannel(ch2)!;
    controller.onPhysicalSessionStarted(sid1, "cs1", "gpt-4.1");
    controller.onPhysicalSessionStarted(sid2, "cs2", "gpt-4.1");
    expect(orchestrator.getSessionStatuses()[sid1]?.status).toBe("waiting");
    expect(orchestrator.getSessionStatuses()[sid2]?.status).toBe("waiting");

    // Stream disconnects
    controller.onStreamDisconnected();
    expect(orchestrator.getSessionStatuses()[sid1]?.status).toBe("idle");
    expect(orchestrator.getSessionStatuses()[sid2]?.status).toBe("idle");
  });
});
