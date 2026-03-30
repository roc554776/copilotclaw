/**
 * Tests for the daemon's onSessionEvent handler logic.
 *
 * The handler lives inline in daemon.ts main(), so these tests replicate
 * its behavior using the real Store and a mock AgentManager to verify:
 *  - subagent.completed inserts a system message and calls notifyAgent
 *  - nested subagent (parentToolCallId present) does NOT insert system message
 *  - subagent.failed inserts a system message with error info
 */
import { describe, expect, it, vi } from "vitest";
import { Store } from "../../src/store.js";

/** Replicates the daemon's onSessionEvent handler logic for subagent events. */
function handleSessionEvent(
  store: Store,
  notifyAgent: (channelId: string) => void,
  channelId: string | undefined,
  eventType: string,
  data: Record<string, unknown>,
): void {
  if (channelId !== undefined && (eventType === "subagent.completed" || eventType === "subagent.failed")) {
    if (data["parentToolCallId"] === undefined) {
      const agentName = data["agentName"] as string ?? "unknown";
      const status = eventType === "subagent.completed" ? "completed" : "failed";
      const error = typeof data["error"] === "string" ? ` (error: ${data["error"]})` : "";
      const msg = `[SUBAGENT ${status.toUpperCase()}] ${agentName} ${status}${error}`;
      store.addMessage(channelId, "system", msg);
      notifyAgent(channelId);
    }
  }
}

describe("daemon onSessionEvent — subagent completion", () => {
  it("inserts system message and calls notifyAgent on subagent.completed", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "subagent.completed", {
      agentName: "worker",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sender).toBe("system");
    expect(pending[0]!.message).toBe("[SUBAGENT COMPLETED] worker completed");
    expect(notifyAgent).toHaveBeenCalledWith(channelId);
  });

  it("inserts system message with error info on subagent.failed", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "subagent.failed", {
      agentName: "worker",
      error: "timeout exceeded",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sender).toBe("system");
    expect(pending[0]!.message).toBe("[SUBAGENT FAILED] worker failed (error: timeout exceeded)");
    expect(notifyAgent).toHaveBeenCalledWith(channelId);
  });

  it("does NOT insert system message for nested subagent (parentToolCallId present)", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "subagent.completed", {
      agentName: "nested-worker",
      parentToolCallId: "outer-tool-call-123",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(0);
    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it("does NOT insert system message when channelId is undefined", () => {
    const store = new Store();
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, undefined, "subagent.completed", {
      agentName: "worker",
    });

    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it("does NOT react to non-subagent event types", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "tool.invoked", {
      agentName: "worker",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(0);
    expect(notifyAgent).not.toHaveBeenCalled();
  });
});

import { SessionOrchestrator } from "../../src/session-orchestrator.js";

/**
 * Replicates the orchestrator routing block added to daemon.ts onSessionEvent.
 * Dispatches SDK event types to the appropriate orchestrator methods via findSessionByCopilotId.
 */
function routeEventToOrchestrator(
  orchestrator: SessionOrchestrator,
  copilotSessionId: string,
  eventType: string,
  timestamp: string,
  data: Record<string, unknown>,
): void {
  const orchSessionId = orchestrator.findSessionByCopilotId(copilotSessionId);
  if (orchSessionId === undefined) return;

  switch (eventType) {
    case "tool.execution_start":
      orchestrator.updatePhysicalSessionState(orchSessionId, `tool:${data["toolName"] as string ?? "unknown"}`);
      break;
    case "tool.execution_complete":
    case "session.idle":
      orchestrator.updatePhysicalSessionState(orchSessionId, "idle");
      break;
    case "session.usage_info":
      orchestrator.updatePhysicalSessionTokens(
        orchSessionId,
        data["currentTokens"] as number ?? 0,
        data["tokenLimit"] as number ?? 0,
      );
      break;
    case "assistant.usage":
      orchestrator.accumulateUsageTokens(
        orchSessionId,
        data["inputTokens"] as number ?? 0,
        data["outputTokens"] as number ?? 0,
        data["quotaSnapshots"] as Record<string, unknown> | undefined,
      );
      break;
    case "session.model_change":
      orchestrator.updatePhysicalSessionModel(orchSessionId, data["newModel"] as string ?? "unknown");
      break;
    case "subagent.started":
      orchestrator.addSubagentSession(orchSessionId, {
        toolCallId: data["toolCallId"] as string ?? "",
        agentName: data["agentName"] as string ?? "unknown",
        agentDisplayName: data["agentDisplayName"] as string ?? "unknown",
        status: "running",
        startedAt: timestamp,
      });
      break;
    case "subagent.completed":
      orchestrator.updateSubagentStatus(orchSessionId, data["toolCallId"] as string ?? "", "completed");
      break;
    case "subagent.failed":
      orchestrator.updateSubagentStatus(orchSessionId, data["toolCallId"] as string ?? "", "failed");
      break;
  }
}

describe("daemon onSessionEvent — orchestrator routing via findSessionByCopilotId", () => {
  it("routes assistant.usage to accumulateUsageTokens after physical_session_started", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-routing");
    orch.updatePhysicalSession(sessionId, {
      sessionId: "copilot-xyz",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });

    routeEventToOrchestrator(orch, "copilot-xyz", "assistant.usage", "2026-01-01T00:00:01Z", {
      inputTokens: 100,
      outputTokens: 50,
    });
    routeEventToOrchestrator(orch, "copilot-xyz", "assistant.usage", "2026-01-01T00:00:02Z", {
      inputTokens: 200,
      outputTokens: 75,
    });

    const session = orch.getSessionStatuses()[sessionId];
    expect(session?.physicalSession?.totalInputTokens).toBe(300);
    expect(session?.physicalSession?.totalOutputTokens).toBe(125);
  });

  it("routes tool.execution_start to updatePhysicalSessionState", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-tool");
    orch.updatePhysicalSession(sessionId, {
      sessionId: "copilot-abc",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
    });

    routeEventToOrchestrator(orch, "copilot-abc", "tool.execution_start", "2026-01-01T00:00:01Z", {
      toolName: "read_file",
    });

    const session = orch.getSessionStatuses()[sessionId];
    expect(session?.physicalSession?.currentState).toBe("tool:read_file");
  });

  it("resets currentState to idle on tool.execution_complete", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-idle");
    orch.updatePhysicalSession(sessionId, {
      sessionId: "copilot-idle",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "tool:read_file",
    });

    routeEventToOrchestrator(orch, "copilot-idle", "tool.execution_complete", "2026-01-01T00:00:02Z", {});

    const session = orch.getSessionStatuses()[sessionId];
    expect(session?.physicalSession?.currentState).toBe("idle");
  });

  it("silently discards events when no physical session matches the copilot sessionId", () => {
    const orch = new SessionOrchestrator();
    orch.startSession("ch-no-match");
    // No updatePhysicalSession — so findSessionByCopilotId returns undefined

    expect(() =>
      routeEventToOrchestrator(orch, "copilot-unknown", "assistant.usage", "2026-01-01T00:00:00Z", {
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).not.toThrow();
  });

  it("routes session.model_change to updatePhysicalSessionModel", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-model");
    orch.updatePhysicalSession(sessionId, {
      sessionId: "copilot-model",
      model: "gpt-4",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
    });

    routeEventToOrchestrator(orch, "copilot-model", "session.model_change", "2026-01-01T00:00:01Z", {
      newModel: "gpt-4.1",
    });

    const session = orch.getSessionStatuses()[sessionId];
    expect(session?.physicalSession?.model).toBe("gpt-4.1");
  });

  it("routes subagent.started and subagent.completed through the orchestrator", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-sub");
    orch.updatePhysicalSession(sessionId, {
      sessionId: "copilot-sub",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
    });

    routeEventToOrchestrator(orch, "copilot-sub", "subagent.started", "2026-01-01T00:00:01Z", {
      toolCallId: "tc-1",
      agentName: "worker",
      agentDisplayName: "Worker",
    });

    let session = orch.getSessionStatuses()[sessionId];
    expect(session?.subagentSessions).toHaveLength(1);
    expect(session?.subagentSessions?.[0]?.status).toBe("running");

    routeEventToOrchestrator(orch, "copilot-sub", "subagent.completed", "2026-01-01T00:00:02Z", {
      toolCallId: "tc-1",
    });

    session = orch.getSessionStatuses()[sessionId];
    expect(session?.subagentSessions?.[0]?.status).toBe("completed");
  });
});
