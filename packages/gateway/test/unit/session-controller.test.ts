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

describe("SessionController — lifecycle decisions", () => {
  it("returns stop on error", () => {
    const { controller } = makeController();
    const result = controller.decideLifecycleAction("sess-1", "error");
    expect(result.action).toBe("stop");
    expect(result.clearCopilotSessionId).toBe(true);
  });

  it("returns wait when backgroundTasks present", () => {
    const { controller } = makeController();
    controller.onSessionIdle("sess-1", true);
    const result = controller.decideLifecycleAction("sess-1", "idle");
    expect(result.action).toBe("wait");
  });

  it("returns stop on true idle (no backgroundTasks, no copilotclaw_wait)", () => {
    const { controller, orchestrator, channelId } = makeController();
    const sessionId = orchestrator.startSession(channelId);
    orchestrator.updatePhysicalSession(sessionId, {
      sessionId: "copilot-123",
      model: "gpt-4.1",
      startedAt: new Date().toISOString(),
      currentState: "idle",
    });
    controller.onSessionIdle(sessionId, false);
    const result = controller.decideLifecycleAction(sessionId, "idle");
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
});
