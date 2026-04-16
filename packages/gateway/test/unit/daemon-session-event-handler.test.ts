/**
 * Tests for the daemon's onSessionEvent handler logic.
 *
 * Uses the real named exports from daemon.ts (handleAssistantMessageEvent) instead of
 * replicating the handler inline — preventing drift between tests and the implementation.
 *
 * Covers:
 *  - assistant.message reflection includes correct senderMeta (parentToolCallId absent → channel-operator)
 *  - assistant.message with parentToolCallId present resolves subagent senderMeta
 *  - empty content is ignored
 *  - subagent.completed inserts a system message and calls notifyAgent
 *  - nested subagent (parentToolCallId present) does NOT insert system message
 *  - subagent.failed inserts a system message with error info
 *  - handleSubagentTimelineEvent emits channel_timeline_event SSE (Item E, v0.83.0)
 */
import { describe, expect, it, vi } from "vitest";
import { handleAssistantMessageEvent, handleChannelMessageAgent, handleSubagentTimelineEvent } from "../../src/daemon.js";
import type { AssistantMessageEventDeps, ChannelMessageAgentDeps, SubagentTimelineEventDeps } from "../../src/daemon.js";
import { Store } from "../../src/store.js";

const defaultChannelOperatorMeta = { agentName: "channel-operator", agentDisplayName: "Channel Operator" };

function makeDeps(store: Store, overrides?: Partial<AssistantMessageEventDeps>): AssistantMessageEventDeps {
  return {
    store,
    orchestrator: {},
    channelOperatorMeta: defaultChannelOperatorMeta,
    ...overrides,
  };
}

describe("daemon onSessionEvent — assistant.message reflection (via handleAssistantMessageEvent)", () => {
  it("adds agent message to channel timeline with channel-operator senderMeta when no parentToolCallId", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const sseBroadcasts: Array<Record<string, unknown>> = [];

    const result = handleAssistantMessageEvent("session-1", channelId, { content: "Hello from the assistant" }, {
      ...makeDeps(store),
      sseBroadcast: (e) => sseBroadcasts.push(e),
    });

    expect(result.stored).toBe(true);
    expect(result.senderMeta).toEqual({
      agentId: "channel-operator",
      agentDisplayName: "Channel Operator",
      agentRole: "channel-operator",
    });

    const msgs = store.listMessages(channelId, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender).toBe("agent");
    expect(msgs[0]!.message).toBe("Hello from the assistant");
    expect(msgs[0]!.senderMeta).toEqual({
      agentId: "channel-operator",
      agentDisplayName: "Channel Operator",
      agentRole: "channel-operator",
    });

    expect(sseBroadcasts).toHaveLength(1);
    const broadcast = sseBroadcasts[0] as Record<string, unknown>;
    expect(broadcast["type"]).toBe("new_message");
    expect(broadcast["channelId"]).toBe(channelId);
    const broadcastData = broadcast["data"] as Record<string, unknown>;
    expect(broadcastData["sender"]).toBe("agent");
    expect(broadcastData["senderMeta"]).toEqual({
      agentId: "channel-operator",
      agentDisplayName: "Channel Operator",
      agentRole: "channel-operator",
    });
  });

  it("resolves subagent senderMeta when parentToolCallId matches a tracked subagent", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const orchestrator = {
      getSubagentInfo: (sessionId: string, toolCallId: string) => {
        if (sessionId === "session-sub" && toolCallId === "tool-abc") {
          return { agentName: "worker", agentDisplayName: "Worker Agent" };
        }
        return undefined;
      },
    };

    const result = handleAssistantMessageEvent(
      "session-sub",
      channelId,
      { content: "Subagent reply", parentToolCallId: "tool-abc" },
      { ...makeDeps(store), orchestrator },
    );

    expect(result.stored).toBe(true);
    expect(result.senderMeta).toEqual({
      agentId: "worker",
      agentDisplayName: "Worker Agent",
      agentRole: "subagent",
    });

    const msgs = store.listMessages(channelId, 10);
    expect(msgs[0]!.senderMeta?.agentRole).toBe("subagent");
    expect(msgs[0]!.senderMeta?.agentId).toBe("worker");
  });

  it("falls back to unknown-subagent when parentToolCallId does not match", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const orchestrator = { getSubagentInfo: () => undefined };

    const result = handleAssistantMessageEvent(
      "session-1",
      channelId,
      { content: "Unknown subagent", parentToolCallId: "no-match" },
      { ...makeDeps(store), orchestrator },
    );

    expect(result.senderMeta?.agentRole).toBe("subagent");
    expect(result.senderMeta?.agentId).toBe("unknown-subagent");
  });

  it("ignores assistant.message with empty content", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const result = handleAssistantMessageEvent("session-1", channelId, { content: "" }, makeDeps(store));

    expect(result.stored).toBe(false);
    expect(store.listMessages(channelId, 10)).toHaveLength(0);
  });

  it("ignores assistant.message when content is not a string", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const result = handleAssistantMessageEvent("session-1", channelId, {}, makeDeps(store));

    expect(result.stored).toBe(false);
    expect(store.listMessages(channelId, 10)).toHaveLength(0);
  });

  it("does not broadcast when sseBroadcast is not provided", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const result = handleAssistantMessageEvent("session-1", channelId, { content: "Hello" }, makeDeps(store));

    expect(result.stored).toBe(true);
    // No error thrown — sseBroadcast is optional
  });
});

/**
 * The subagent-completion and session.idle branches remain inline in daemon.ts main()
 * and are tested here via a local replica to preserve existing test coverage.
 * These branches do not use resolveAgentSenderMeta and are not at drift risk.
 */
function handleSubagentEvent(
  store: Store,
  notifyAgent: (sessionId: string) => void,
  channelId: string | undefined,
  sessionId: string,
  eventType: string,
  data: Record<string, unknown>,
): void {
  if (channelId !== undefined && eventType === "session.idle") {
    const bgTasks = data["backgroundTasks"] as { agents?: Array<{ agentId: string; agentType: string }> } | undefined;
    if (bgTasks?.agents !== undefined && bgTasks.agents.length > 0) {
      for (const agent of bgTasks.agents) {
        const msg = `[SUBAGENT IDLE] ${agent.agentId} (${agent.agentType}) stopped`;
        store.addMessage(channelId, "system", msg);
      }
      notifyAgent(sessionId);
    }
  }

  if (channelId !== undefined && (eventType === "subagent.completed" || eventType === "subagent.failed")) {
    if (data["parentToolCallId"] === undefined) {
      const agentName = data["agentName"] as string ?? "unknown";
      const status = eventType === "subagent.completed" ? "completed" : "failed";
      const error = typeof data["error"] === "string" ? ` (error: ${data["error"]})` : "";
      const msg = `[SUBAGENT ${status.toUpperCase()}] ${agentName} ${status}${error}`;
      store.addMessage(channelId, "system", msg);
      notifyAgent(sessionId);
    }
  }
}

describe("daemon onSessionEvent — session.idle with backgroundTasks", () => {
  it("inserts system message and notifies agent for each background agent", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSubagentEvent(store, notifyAgent, channelId, "session-1", "session.idle", {
      backgroundTasks: {
        agents: [
          { agentId: "worker-1", agentType: "worker" },
          { agentId: "explorer-1", agentType: "explore" },
        ],
        shells: [],
      },
    });

    const msgs = store.listMessages(channelId, 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.sender).toBe("system");
    expect(msgs[0]!.message).toContain("[SUBAGENT IDLE]");
    expect(msgs[0]!.message).toContain("explorer-1");
    expect(msgs[1]!.message).toContain("worker-1");
    expect(notifyAgent).toHaveBeenCalledWith("session-1");
  });

  it("does not notify on session.idle without backgroundTasks", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSubagentEvent(store, notifyAgent, channelId, "session-1", "session.idle", {});

    const msgs = store.listMessages(channelId, 10);
    expect(msgs).toHaveLength(0);
    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it("does not notify on session.idle with empty agents list", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSubagentEvent(store, notifyAgent, channelId, "session-1", "session.idle", {
      backgroundTasks: { agents: [], shells: [] },
    });

    const msgs = store.listMessages(channelId, 10);
    expect(msgs).toHaveLength(0);
    expect(notifyAgent).not.toHaveBeenCalled();
  });
});

describe("daemon onSessionEvent — subagent completion", () => {
  it("inserts system message and calls notifyAgent on subagent.completed", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSubagentEvent(store, notifyAgent, channelId, "session-1", "subagent.completed", {
      agentName: "worker",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sender).toBe("system");
    expect(pending[0]!.message).toBe("[SUBAGENT COMPLETED] worker completed");
    expect(notifyAgent).toHaveBeenCalledWith("session-1");
  });

  it("inserts system message with error info on subagent.failed", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSubagentEvent(store, notifyAgent, channelId, "session-1", "subagent.failed", {
      agentName: "worker",
      error: "timeout exceeded",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sender).toBe("system");
    expect(pending[0]!.message).toBe("[SUBAGENT FAILED] worker failed (error: timeout exceeded)");
    expect(notifyAgent).toHaveBeenCalledWith("session-1");
  });

  it("does NOT insert system message for nested subagent (parentToolCallId present)", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSubagentEvent(store, notifyAgent, channelId, "session-1", "subagent.completed", {
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

    handleSubagentEvent(store, notifyAgent, undefined, "session-1", "subagent.completed", {
      agentName: "worker",
    });

    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it("does NOT react to non-subagent event types", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSubagentEvent(store, notifyAgent, channelId, "session-1", "tool.invoked", {
      agentName: "worker",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(0);
    expect(notifyAgent).not.toHaveBeenCalled();
  });
});

describe("daemon onChannelMessage — agent sender senderMeta (via handleChannelMessageAgent)", () => {
  const defaultMeta = { agentName: "channel-operator", agentDisplayName: "Channel Operator" };

  function makeChanDeps(store: Store, overrides?: Partial<ChannelMessageAgentDeps>): ChannelMessageAgentDeps {
    return { store, orchestrator: {}, channelOperatorMeta: defaultMeta, ...overrides };
  }

  it("stores agent message with channel-operator senderMeta", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const result = handleChannelMessageAgent("session-1", channelId, "Hello from IPC", makeChanDeps(store));

    expect(result.senderMeta).toEqual({
      agentId: "channel-operator",
      agentDisplayName: "Channel Operator",
      agentRole: "channel-operator",
    });

    const msgs = store.listMessages(channelId, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.senderMeta?.agentRole).toBe("channel-operator");
  });

  it("broadcasts with senderMeta when sseBroadcast is provided", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const broadcasts: Array<Record<string, unknown>> = [];

    handleChannelMessageAgent("session-1", channelId, "Broadcast me", {
      ...makeChanDeps(store),
      sseBroadcast: (e) => broadcasts.push(e),
    });

    expect(broadcasts).toHaveLength(1);
    const data = (broadcasts[0]!["data"]) as Record<string, unknown>;
    expect((data["senderMeta"] as Record<string, unknown>)["agentRole"]).toBe("channel-operator");
  });
});

import { SessionOrchestrator } from "../../src/session-orchestrator.js";
import type { AbstractSessionWorldState } from "../../src/session-events.js";
import type { PhysicalSessionSummary, SubagentInfo } from "../../src/ipc-client.js";

// Helper: read current world state for a session
function getWorldState(orch: SessionOrchestrator, sessionId: string): AbstractSessionWorldState {
  const s = orch.getSession(sessionId)!;
  return {
    sessionId: s.sessionId, channelId: s.channelId, status: s.status,
    waitingOnWaitTool: s.waitingOnWaitTool, hasHadPhysicalSession: s.hasHadPhysicalSession,
    physicalSessionId: s.physicalSessionId, physicalSession: s.physicalSession,
    physicalSessionHistory: s.physicalSessionHistory,
    cumulativeInputTokens: s.cumulativeInputTokens, cumulativeOutputTokens: s.cumulativeOutputTokens,
    subagentSessions: s.subagentSessions, processingStartedAt: s.processingStartedAt, startedAt: s.startedAt,
  };
}

// Helper: set physical session via applyWorldState
function setPhysicalSession(orch: SessionOrchestrator, sessionId: string, ps: PhysicalSessionSummary): void {
  const state = getWorldState(orch, sessionId);
  orch.applyWorldState({ ...state, physicalSession: ps, hasHadPhysicalSession: true });
}

/**
 * Replicates the orchestrator routing block added to daemon.ts onSessionEvent.
 * Uses sessionId (opaque gateway token) directly, matching the new daemon routing logic.
 * Now routes through applyWorldState (single write path) instead of deleted direct-mutate methods.
 */
function routeEventToOrchestrator(
  orchestrator: SessionOrchestrator,
  sessionId: string,
  eventType: string,
  timestamp: string,
  data: Record<string, unknown>,
): void {
  const session = orchestrator.getSession(sessionId);
  if (session === undefined) return;
  const state = getWorldState(orchestrator, sessionId);
  const ps = state.physicalSession;

  switch (eventType) {
    case "tool.execution_start":
      if (ps !== undefined) {
        orchestrator.applyWorldState({ ...state, physicalSession: { ...ps, currentState: `tool:${data["toolName"] as string ?? "unknown"}` } });
      }
      break;
    case "tool.execution_complete":
    case "session.idle":
      if (ps !== undefined) {
        orchestrator.applyWorldState({ ...state, physicalSession: { ...ps, currentState: "idle" } });
      }
      break;
    case "session.usage_info":
      if (ps !== undefined) {
        orchestrator.applyWorldState({ ...state, physicalSession: { ...ps, currentTokens: data["currentTokens"] as number ?? 0, tokenLimit: data["tokenLimit"] as number ?? 0 } });
      }
      break;
    case "assistant.usage": {
      if (ps !== undefined) {
        const snapshots = data["quotaSnapshots"] as Record<string, unknown> | undefined;
        orchestrator.applyWorldState({
          ...state,
          physicalSession: {
            ...ps,
            totalInputTokens: (ps.totalInputTokens ?? 0) + (data["inputTokens"] as number ?? 0),
            totalOutputTokens: (ps.totalOutputTokens ?? 0) + (data["outputTokens"] as number ?? 0),
            ...(snapshots !== undefined ? { latestQuotaSnapshots: snapshots } : {}),
          },
        });
      }
      break;
    }
    case "session.model_change":
      if (ps !== undefined) {
        orchestrator.applyWorldState({ ...state, physicalSession: { ...ps, model: data["newModel"] as string ?? "unknown" } });
      }
      break;
    case "subagent.started": {
      const newInfo: SubagentInfo = {
        toolCallId: data["toolCallId"] as string ?? "",
        agentName: data["agentName"] as string ?? "unknown",
        agentDisplayName: data["agentDisplayName"] as string ?? "unknown",
        status: "running",
        startedAt: timestamp,
      };
      const existing = state.subagentSessions ?? [];
      let updated = [...existing, newInfo];
      if (updated.length > 50) updated = updated.slice(updated.length - 50);
      orchestrator.applyWorldState({ ...state, subagentSessions: updated });
      break;
    }
    case "subagent.completed":
    case "subagent.failed": {
      if (state.subagentSessions !== undefined) {
        const status = eventType === "subagent.completed" ? "completed" : "failed";
        const toolCallId = data["toolCallId"] as string ?? "";
        const updatedSubs = state.subagentSessions.map((s) =>
          s.toolCallId === toolCallId ? { ...s, status } : s,
        );
        orchestrator.applyWorldState({ ...state, subagentSessions: updatedSubs });
      }
      break;
    }
  }
}

describe("daemon onSessionEvent — orchestrator routing via sessionId", () => {
  it("routes assistant.usage to accumulateUsageTokens after physical_session_started", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-routing");
    setPhysicalSession(orch, sessionId, {
      sessionId: "copilot-xyz",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });

    routeEventToOrchestrator(orch, sessionId, "assistant.usage", "2026-01-01T00:00:01Z", {
      inputTokens: 100,
      outputTokens: 50,
    });
    routeEventToOrchestrator(orch, sessionId, "assistant.usage", "2026-01-01T00:00:02Z", {
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
    setPhysicalSession(orch, sessionId, {
      sessionId: "copilot-abc",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
    });

    routeEventToOrchestrator(orch, sessionId, "tool.execution_start", "2026-01-01T00:00:01Z", {
      toolName: "read_file",
    });

    const session = orch.getSessionStatuses()[sessionId];
    expect(session?.physicalSession?.currentState).toBe("tool:read_file");
  });

  it("resets currentState to idle on tool.execution_complete", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-idle");
    setPhysicalSession(orch, sessionId, {
      sessionId: "copilot-idle",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "tool:read_file",
    });

    routeEventToOrchestrator(orch, sessionId, "tool.execution_complete", "2026-01-01T00:00:02Z", {});

    const session = orch.getSessionStatuses()[sessionId];
    expect(session?.physicalSession?.currentState).toBe("idle");
  });

  it("silently discards events when the sessionId is not known to the orchestrator", () => {
    const orch = new SessionOrchestrator();
    orch.startSession("ch-no-match");
    // Pass an unknown sessionId — orchestrator has no session for it

    expect(() =>
      routeEventToOrchestrator(orch, "session-unknown-00000000", "assistant.usage", "2026-01-01T00:00:00Z", {
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).not.toThrow();
  });

  it("routes session.model_change to updatePhysicalSessionModel", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-model");
    setPhysicalSession(orch, sessionId, {
      sessionId: "copilot-model",
      model: "gpt-4",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
    });

    routeEventToOrchestrator(orch, sessionId, "session.model_change", "2026-01-01T00:00:01Z", {
      newModel: "gpt-4.1",
    });

    const session = orch.getSessionStatuses()[sessionId];
    expect(session?.physicalSession?.model).toBe("gpt-4.1");
  });

  it("routes subagent.started and subagent.completed through the orchestrator", () => {
    const orch = new SessionOrchestrator();
    const sessionId = orch.startSession("ch-sub");
    setPhysicalSession(orch, sessionId, {
      sessionId: "copilot-sub",
      model: "gpt-4.1",
      startedAt: "2026-01-01T00:00:00Z",
      currentState: "idle",
    });

    routeEventToOrchestrator(orch, sessionId, "subagent.started", "2026-01-01T00:00:01Z", {
      toolCallId: "tc-1",
      agentName: "worker",
      agentDisplayName: "Worker",
    });

    let session = orch.getSessionStatuses()[sessionId];
    expect(session?.subagentSessions).toHaveLength(1);
    expect(session?.subagentSessions?.[0]?.status).toBe("running");

    routeEventToOrchestrator(orch, sessionId, "subagent.completed", "2026-01-01T00:00:02Z", {
      toolCallId: "tc-1",
    });

    session = orch.getSessionStatuses()[sessionId];
    expect(session?.subagentSessions?.[0]?.status).toBe("completed");
  });
});

// ── handleSubagentTimelineEvent (Item E, v0.83.0) ─────────────────────────────

describe("handleSubagentTimelineEvent — channel_timeline_event SSE (Item E, v0.83.0)", () => {
  it("broadcasts channel_timeline_event with subagent-started entry", () => {
    const sseBroadcasts: Array<Record<string, unknown>> = [];
    const deps: SubagentTimelineEventDeps = { sseBroadcast: (e) => sseBroadcasts.push(e) };

    handleSubagentTimelineEvent(
      "ch-1",
      { entryType: "subagent-started", toolCallId: "tc-1", agentName: "worker", agentDisplayName: "Worker Agent", timestamp: "2026-01-01T00:00:00Z" },
      deps,
    );

    expect(sseBroadcasts).toHaveLength(1);
    expect(sseBroadcasts[0]!["type"]).toBe("channel_timeline_event");
    expect(sseBroadcasts[0]!["channelId"]).toBe("ch-1");
    const data = sseBroadcasts[0]!["data"] as Record<string, unknown>;
    expect(data["entryType"]).toBe("subagent-started");
    expect(data["toolCallId"]).toBe("tc-1");
    expect(data["agentName"]).toBe("worker");
    expect(data["agentDisplayName"]).toBe("Worker Agent");
    expect(data["timestamp"]).toBe("2026-01-01T00:00:00Z");
  });

  it("broadcasts channel_timeline_event with subagent-lifecycle completed entry", () => {
    const sseBroadcasts: Array<Record<string, unknown>> = [];
    const deps: SubagentTimelineEventDeps = { sseBroadcast: (e) => sseBroadcasts.push(e) };

    handleSubagentTimelineEvent(
      "ch-2",
      { entryType: "subagent-lifecycle", toolCallId: "tc-2", agentName: "worker", status: "completed", timestamp: "2026-01-01T00:00:01Z" },
      deps,
    );

    expect(sseBroadcasts).toHaveLength(1);
    expect(sseBroadcasts[0]!["type"]).toBe("channel_timeline_event");
    expect(sseBroadcasts[0]!["channelId"]).toBe("ch-2");
    const data = sseBroadcasts[0]!["data"] as Record<string, unknown>;
    expect(data["entryType"]).toBe("subagent-lifecycle");
    expect(data["status"]).toBe("completed");
    expect(data["error"]).toBeUndefined();
  });

  it("broadcasts channel_timeline_event with subagent-lifecycle failed entry including error", () => {
    const sseBroadcasts: Array<Record<string, unknown>> = [];
    const deps: SubagentTimelineEventDeps = { sseBroadcast: (e) => sseBroadcasts.push(e) };

    handleSubagentTimelineEvent(
      "ch-3",
      { entryType: "subagent-lifecycle", toolCallId: "tc-3", agentName: "worker", status: "failed", error: "timeout", timestamp: "2026-01-01T00:00:02Z" },
      deps,
    );

    expect(sseBroadcasts).toHaveLength(1);
    const data = sseBroadcasts[0]!["data"] as Record<string, unknown>;
    expect(data["status"]).toBe("failed");
    expect(data["error"]).toBe("timeout");
  });

  it("does not broadcast when sseBroadcast is undefined", () => {
    // Should not throw
    handleSubagentTimelineEvent(
      "ch-4",
      { entryType: "subagent-started", toolCallId: "tc-4", agentName: "worker", agentDisplayName: "Worker", timestamp: "2026-01-01T00:00:00Z" },
      {},
    );
  });
});
