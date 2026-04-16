import { describe, expect, it, vi } from "vitest";
import { semverSatisfies, AgentManager } from "../../src/agent-manager.js";
import { resolveModel } from "../../src/agent-config.js";

describe("semverSatisfies", () => {
  it("returns true when version equals minimum", () => {
    expect(semverSatisfies("0.1.0", "0.1.0")).toBe(true);
  });

  it("returns true when version exceeds minimum by patch", () => {
    expect(semverSatisfies("0.1.1", "0.1.0")).toBe(true);
  });

  it("returns true when version exceeds minimum by minor", () => {
    expect(semverSatisfies("0.2.0", "0.1.0")).toBe(true);
  });

  it("returns true when version exceeds minimum by major", () => {
    expect(semverSatisfies("1.0.0", "0.1.0")).toBe(true);
  });

  it("returns false when version is below minimum by patch", () => {
    expect(semverSatisfies("0.1.0", "0.1.1")).toBe(false);
  });

  it("returns false when version is below minimum by minor", () => {
    expect(semverSatisfies("0.1.0", "0.2.0")).toBe(false);
  });

  it("returns false when version is below minimum by major", () => {
    expect(semverSatisfies("0.1.0", "1.0.0")).toBe(false);
  });

  it("returns false for non-numeric version components (NaN guard)", () => {
    expect(semverSatisfies("invalid", "0.1.0")).toBe(false);
    expect(semverSatisfies("1.x.0", "0.1.0")).toBe(false);
  });

  it("handles pre-release suffix by ignoring it", () => {
    expect(semverSatisfies("1.0.0-beta", "0.1.0")).toBe(true);
    expect(semverSatisfies("0.1.0-rc.1", "0.1.0")).toBe(true);
  });

  it("returns false when pre-release version is below minimum", () => {
    expect(semverSatisfies("0.0.9-rc", "0.1.0")).toBe(false);
  });
});

describe("AgentManager — stream message handler dispatch", () => {
  /** Invoke handleAgentMessage by simulating a message from agent on the stream.
   *  We use the public setStreamMessageHandler + private handleAgentMessage via cast. */
  function invokeHandleAgentMessage(manager: AgentManager, msg: Record<string, unknown>): void {
    // Access private method via cast for white-box testing
    (manager as unknown as { handleAgentMessage: (msg: Record<string, unknown>) => void }).handleAgentMessage(msg);
  }

  it("dispatches channel_message to onChannelMessage handler", () => {
    const manager = new AgentManager();
    const onChannelMessage = vi.fn();
    manager.setStreamMessageHandler({ onChannelMessage });

    invokeHandleAgentMessage(manager, {
      type: "channel_message",
      sessionId: "ch-1",
      sender: "agent",
      message: "hello",
    });

    expect(onChannelMessage).toHaveBeenCalledWith("ch-1", "agent", "hello");
  });

  it("dispatches session_event to onSessionEvent handler", () => {
    const manager = new AgentManager();
    const onSessionEvent = vi.fn();
    manager.setStreamMessageHandler({ onSessionEvent });

    invokeHandleAgentMessage(manager, {
      type: "session_event",
      sessionId: "s-1",
      copilotSessionId: "cs-1",
      eventType: "tool.execution_start",
      timestamp: "2026-01-01T00:00:00Z",
      data: { toolName: "Read" },
    });

    expect(onSessionEvent).toHaveBeenCalledWith(
      "s-1", "cs-1", "tool.execution_start", "2026-01-01T00:00:00Z",
      { toolName: "Read" },
    );
  });

  it("dispatches system_prompt_original to onSystemPromptOriginal handler", () => {
    const manager = new AgentManager();
    const onSystemPromptOriginal = vi.fn();
    manager.setStreamMessageHandler({ onSystemPromptOriginal });

    invokeHandleAgentMessage(manager, {
      type: "system_prompt_original",
      model: "gpt-4.1",
      prompt: "system prompt text",
      capturedAt: "2026-01-01T00:00:00Z",
    });

    expect(onSystemPromptOriginal).toHaveBeenCalledWith("gpt-4.1", "system prompt text", "2026-01-01T00:00:00Z");
  });

  it("dispatches system_prompt_session to onSystemPromptSession handler", () => {
    const manager = new AgentManager();
    const onSystemPromptSession = vi.fn();
    manager.setStreamMessageHandler({ onSystemPromptSession });

    invokeHandleAgentMessage(manager, {
      type: "system_prompt_session",
      sessionId: "s-1",
      model: "gpt-4.1",
      prompt: "effective prompt text",
    });

    expect(onSystemPromptSession).toHaveBeenCalledWith("s-1", "gpt-4.1", "effective prompt text");
  });

  it("dispatches drain_pending and sends response via stream", () => {
    const manager = new AgentManager();
    const mockMessages = [{ id: "m1", message: "hello" }];
    const onDrainPending = vi.fn().mockReturnValue(mockMessages);
    manager.setStreamMessageHandler({ onDrainPending });

    // Mock the stream to capture the response
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    invokeHandleAgentMessage(manager, {
      type: "drain_pending",
      sessionId: "ch-1",
      id: "req-123",
    });

    expect(onDrainPending).toHaveBeenCalledWith("ch-1");
    expect(streamSend).toHaveBeenCalledWith({ type: "response", id: "req-123", data: mockMessages });
  });

  it("dispatches peek_pending and sends response via stream", () => {
    const manager = new AgentManager();
    const mockMsg = { id: "m1", message: "oldest" };
    const onPeekPending = vi.fn().mockReturnValue(mockMsg);
    manager.setStreamMessageHandler({ onPeekPending });

    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    invokeHandleAgentMessage(manager, {
      type: "peek_pending",
      sessionId: "ch-1",
      id: "req-456",
    });

    expect(onPeekPending).toHaveBeenCalledWith("ch-1");
    expect(streamSend).toHaveBeenCalledWith({ type: "response", id: "req-456", data: mockMsg });
  });

  it("dispatches flush_pending and sends response via stream", () => {
    const manager = new AgentManager();
    const onFlushPending = vi.fn().mockReturnValue(3);
    manager.setStreamMessageHandler({ onFlushPending });

    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    invokeHandleAgentMessage(manager, {
      type: "flush_pending",
      sessionId: "ch-1",
      id: "req-789",
    });

    expect(onFlushPending).toHaveBeenCalledWith("ch-1");
    expect(streamSend).toHaveBeenCalledWith({ type: "response", id: "req-789", data: { flushed: 3 } });
  });

  it("dispatches list_messages with limit and sends response via stream", () => {
    const manager = new AgentManager();
    const mockMsgs = [{ id: "m1" }, { id: "m2" }];
    const onListMessages = vi.fn().mockReturnValue(mockMsgs);
    manager.setStreamMessageHandler({ onListMessages });

    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    invokeHandleAgentMessage(manager, {
      type: "list_messages",
      sessionId: "ch-1",
      id: "req-list",
      limit: 10,
    });

    expect(onListMessages).toHaveBeenCalledWith("ch-1", 10);
    expect(streamSend).toHaveBeenCalledWith({ type: "response", id: "req-list", data: mockMsgs });
  });

  it("uses default limit of 5 for list_messages when not provided", () => {
    const manager = new AgentManager();
    const onListMessages = vi.fn().mockReturnValue([]);
    manager.setStreamMessageHandler({ onListMessages });

    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    invokeHandleAgentMessage(manager, {
      type: "list_messages",
      sessionId: "ch-1",
      id: "req-default",
    });

    expect(onListMessages).toHaveBeenCalledWith("ch-1", 5);
  });

  it("ignores unknown message types", () => {
    const manager = new AgentManager();
    const onChannelMessage = vi.fn();
    manager.setStreamMessageHandler({ onChannelMessage });

    // Should not throw
    invokeHandleAgentMessage(manager, { type: "unknown_type", foo: "bar" });
    expect(onChannelMessage).not.toHaveBeenCalled();
  });

  it("ignores messages when handler is null", () => {
    const manager = new AgentManager();
    // No setStreamMessageHandler called — handler is null
    // Should not throw
    invokeHandleAgentMessage(manager, { type: "channel_message", sessionId: "ch-1", sender: "agent", message: "hi" });
  });

  it("ignores messages with no type field", () => {
    const manager = new AgentManager();
    const onChannelMessage = vi.fn();
    manager.setStreamMessageHandler({ onChannelMessage });

    invokeHandleAgentMessage(manager, { sessionId: "ch-1", sender: "agent", message: "hi" });
    expect(onChannelMessage).not.toHaveBeenCalled();
  });
});

describe("AgentManager — notifyAgent", () => {
  it("does nothing when stream is not connected", () => {
    const manager = new AgentManager();
    // No stream connected — should not throw
    manager.notifyAgent("ch-1");
  });

  it("sends agent_notify when stream is connected", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    manager.notifyAgent("ch-1");
    expect(streamSend).toHaveBeenCalledWith({ type: "agent_notify", sessionId: "ch-1" });
  });

  it("does not send when stream exists but is disconnected", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => false,
    };

    manager.notifyAgent("ch-1");
    expect(streamSend).not.toHaveBeenCalled();
  });
});

describe("AgentManager — setConfigToSend", () => {
  it("sends config immediately when stream is already connected", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    const config = { model: "gpt-4.1", zeroPremium: false };
    manager.setConfigToSend(config);

    expect(streamSend).toHaveBeenCalledWith({ type: "config", config });
  });

  it("does not send config when stream is not connected", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => false,
    };

    manager.setConfigToSend({ model: "gpt-4.1" });
    expect(streamSend).not.toHaveBeenCalled();
  });

  it("does not send config when no stream exists", () => {
    const manager = new AgentManager();
    // Should not throw
    manager.setConfigToSend({ model: "gpt-4.1" });
  });
});

describe("AgentManager — physical session IPC", () => {
  function invokeHandleAgentMessage(manager: AgentManager, msg: Record<string, unknown>): void {
    (manager as unknown as { handleAgentMessage: (msg: Record<string, unknown>) => void }).handleAgentMessage(msg);
  }

  it("dispatches physical_session_started to onPhysicalSessionStarted handler", () => {
    const manager = new AgentManager();
    const onPhysicalSessionStarted = vi.fn();
    manager.setStreamMessageHandler({ onPhysicalSessionStarted });

    invokeHandleAgentMessage(manager, {
      type: "physical_session_started",
      sessionId: "ps-1",
      copilotSessionId: "cs-1",
      model: "gpt-4.1",
    });

    expect(onPhysicalSessionStarted).toHaveBeenCalledWith("ps-1", "cs-1", "gpt-4.1");
  });

  it("dispatches physical_session_ended to onPhysicalSessionEnded handler", () => {
    const manager = new AgentManager();
    const onPhysicalSessionEnded = vi.fn();
    manager.setStreamMessageHandler({ onPhysicalSessionEnded });

    invokeHandleAgentMessage(manager, {
      type: "physical_session_ended",
      sessionId: "ps-1",
      reason: "idle",
      copilotSessionId: "cs-1",
      elapsedMs: 5000,
    });

    expect(onPhysicalSessionEnded).toHaveBeenCalledWith("ps-1", "idle", "cs-1", 5000, undefined);
  });

  it("dispatches physical_session_ended with error field", () => {
    const manager = new AgentManager();
    const onPhysicalSessionEnded = vi.fn();
    manager.setStreamMessageHandler({ onPhysicalSessionEnded });

    invokeHandleAgentMessage(manager, {
      type: "physical_session_ended",
      sessionId: "ps-2",
      reason: "error",
      copilotSessionId: "cs-2",
      elapsedMs: 1000,
      error: "rate limited",
    });

    expect(onPhysicalSessionEnded).toHaveBeenCalledWith("ps-2", "error", "cs-2", 1000, "rate limited");
  });

  it("sends start_physical_session via stream with all fields", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    manager.startPhysicalSession("ps-1", "cs-1", "gpt-4.1");
    expect(streamSend).toHaveBeenCalledWith({
      type: "start_physical_session",
      sessionId: "ps-1",
      physicalSessionId: "cs-1",
      model: "gpt-4.1",
    });
  });

  it("sends start_physical_session without optional fields", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    manager.startPhysicalSession("ps-1");
    expect(streamSend).toHaveBeenCalledWith({
      type: "start_physical_session",
      sessionId: "ps-1",
    });
  });

  it("does not send start_physical_session when stream is not connected", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => false,
    };

    manager.startPhysicalSession("ps-1");
    expect(streamSend).not.toHaveBeenCalled();
  });

  it("does not send start_physical_session when no stream exists", () => {
    const manager = new AgentManager();
    // Should not throw
    manager.startPhysicalSession("ps-1");
  });

  it("sends stop_physical_session via stream", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    manager.stopPhysicalSession("ps-1");
    expect(streamSend).toHaveBeenCalledWith({
      type: "stop_physical_session",
      sessionId: "ps-1",
    });
  });

  it("does not send stop_physical_session when stream is not connected", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => false,
    };

    manager.stopPhysicalSession("ps-1");
    expect(streamSend).not.toHaveBeenCalled();
  });
});

describe("AgentManager — closeStream", () => {
  it("closes and nullifies the stream", () => {
    const manager = new AgentManager();
    const closeFn = vi.fn();
    (manager as unknown as { stream: { close: typeof closeFn } | null }).stream = {
      close: closeFn,
    };

    manager.closeStream();
    expect(closeFn).toHaveBeenCalled();
    expect((manager as unknown as { stream: null }).stream).toBeNull();
  });

  it("does nothing when no stream exists", () => {
    const manager = new AgentManager();
    // Should not throw
    manager.closeStream();
  });
});

describe("AgentManager — running_sessions dispatch", () => {
  function invokeHandleAgentMessage(manager: AgentManager, msg: Record<string, unknown>): void {
    (manager as unknown as { handleAgentMessage: (msg: Record<string, unknown>) => void }).handleAgentMessage(msg);
  }

  it("dispatches running_sessions to onRunningSessionsReport handler", () => {
    const manager = new AgentManager();
    const onRunningSessionsReport = vi.fn();
    manager.setStreamMessageHandler({ onRunningSessionsReport });

    invokeHandleAgentMessage(manager, {
      type: "running_sessions",
      sessions: [
        { sessionId: "s-1", status: "waiting" },
        { sessionId: "s-2", status: "processing" },
      ],
    });

    expect(onRunningSessionsReport).toHaveBeenCalledWith([
      { sessionId: "s-1", status: "waiting" },
      { sessionId: "s-2", status: "processing" },
    ]);
  });
});

// ── Item F (v0.83.0): reconcile coordinator request-response protocol ──────────

describe("AgentManager — requestRunningSessions (Item F, v0.83.0)", () => {
  it("sends request_running_sessions to the agent via stream", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => true,
    };

    manager.requestRunningSessions();

    expect(streamSend).toHaveBeenCalledWith({ type: "request_running_sessions" });
  });

  it("does not send when stream is not connected", () => {
    const manager = new AgentManager();
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => false,
    };

    manager.requestRunningSessions();

    expect(streamSend).not.toHaveBeenCalled();
  });

  it("does not throw when no stream exists", () => {
    const manager = new AgentManager();
    // Should not throw
    manager.requestRunningSessions();
  });
});

describe("AgentManager — running_sessions_report dispatch (Item F, v0.83.0)", () => {
  function invokeHandleAgentMessage(manager: AgentManager, msg: Record<string, unknown>): void {
    (manager as unknown as { handleAgentMessage: (msg: Record<string, unknown>) => void }).handleAgentMessage(msg);
  }

  it("dispatches running_sessions_report to onRunningSessionsReport handler", () => {
    const manager = new AgentManager();
    const onRunningSessionsReport = vi.fn();
    manager.setStreamMessageHandler({ onRunningSessionsReport });

    invokeHandleAgentMessage(manager, {
      type: "running_sessions_report",
      physicalSessionIds: ["ps-1", "ps-2"],
    });

    expect(onRunningSessionsReport).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "ps-1" }),
        expect.objectContaining({ sessionId: "ps-2" }),
      ]),
    );
  });

  it("dispatches running_sessions_report with empty list", () => {
    const manager = new AgentManager();
    const onRunningSessionsReport = vi.fn();
    manager.setStreamMessageHandler({ onRunningSessionsReport });

    invokeHandleAgentMessage(manager, {
      type: "running_sessions_report",
      physicalSessionIds: [],
    });

    expect(onRunningSessionsReport).toHaveBeenCalledWith([]);
  });
});

describe("AgentManager — SendQueue ACK protocol", () => {
  function invokeHandleAgentMessage(manager: AgentManager, msg: Record<string, unknown>): void {
    (manager as unknown as { handleAgentMessage: (msg: Record<string, unknown>) => void }).handleAgentMessage(msg);
  }

  function attachStream(manager: AgentManager): { streamSend: ReturnType<typeof vi.fn> } {
    const streamSend = vi.fn();
    (manager as unknown as { stream: { send: typeof streamSend; isConnected: () => boolean } | null }).stream = {
      send: streamSend,
      isConnected: () => true,
    };
    return { streamSend };
  }

  it("sends message_acknowledged when session_event has _queueId", () => {
    const manager = new AgentManager();
    const { streamSend } = attachStream(manager);
    const onSessionEvent = vi.fn();
    manager.setStreamMessageHandler({ onSessionEvent });

    invokeHandleAgentMessage(manager, {
      type: "session_event",
      sessionId: "s-1",
      copilotSessionId: "cs-1",
      eventType: "tool.execution_start",
      timestamp: "2026-01-01T00:00:00Z",
      data: {},
      _queueId: "q1",
    });

    expect(onSessionEvent).toHaveBeenCalled();
    expect(streamSend).toHaveBeenCalledWith({ type: "message_acknowledged", queueId: "q1" });
  });

  it("sends message_acknowledged when channel_message has _queueId", () => {
    const manager = new AgentManager();
    const { streamSend } = attachStream(manager);
    const onChannelMessage = vi.fn();
    manager.setStreamMessageHandler({ onChannelMessage });

    invokeHandleAgentMessage(manager, {
      type: "channel_message",
      sessionId: "s-1",
      sender: "agent",
      message: "hello",
      _queueId: "q2",
    });

    expect(onChannelMessage).toHaveBeenCalled();
    expect(streamSend).toHaveBeenCalledWith({ type: "message_acknowledged", queueId: "q2" });
  });

  it("sends message_acknowledged when physical_session_started has _queueId", () => {
    const manager = new AgentManager();
    const { streamSend } = attachStream(manager);
    const onPhysicalSessionStarted = vi.fn();
    manager.setStreamMessageHandler({ onPhysicalSessionStarted });

    invokeHandleAgentMessage(manager, {
      type: "physical_session_started",
      sessionId: "ps-1",
      copilotSessionId: "cs-1",
      model: "gpt-4.1",
      _queueId: "q3",
    });

    expect(onPhysicalSessionStarted).toHaveBeenCalled();
    expect(streamSend).toHaveBeenCalledWith({ type: "message_acknowledged", queueId: "q3" });
  });

  it("does NOT send message_acknowledged when message has no _queueId (direct send)", () => {
    const manager = new AgentManager();
    const { streamSend } = attachStream(manager);
    const onSessionEvent = vi.fn();
    manager.setStreamMessageHandler({ onSessionEvent });

    invokeHandleAgentMessage(manager, {
      type: "session_event",
      sessionId: "s-1",
      copilotSessionId: "cs-1",
      eventType: "tool.execution_start",
      timestamp: "2026-01-01T00:00:00Z",
      data: {},
      // No _queueId — this was sent directly (not buffered)
    });

    expect(onSessionEvent).toHaveBeenCalled();
    expect(streamSend).not.toHaveBeenCalled();
  });

  it("does NOT send message_acknowledged when stream is not connected", () => {
    const manager = new AgentManager();
    // No stream attached
    const onSessionEvent = vi.fn();
    manager.setStreamMessageHandler({ onSessionEvent });

    // Should not throw even with _queueId but no stream
    invokeHandleAgentMessage(manager, {
      type: "session_event",
      sessionId: "s-1",
      copilotSessionId: "cs-1",
      eventType: "tool.execution_start",
      timestamp: "2026-01-01T00:00:00Z",
      data: {},
      _queueId: "q99",
    });

    expect(onSessionEvent).toHaveBeenCalled();
    // No crash — no stream to send on
  });
});

describe("resolveModel (gateway-side model selection)", () => {
  it("returns undefined when models response is null", () => {
    expect(resolveModel(null, null, false)).toBeUndefined();
  });

  it("returns undefined when models list is empty", () => {
    expect(resolveModel({ models: [] }, null, false)).toBeUndefined();
  });

  it("picks cheapest model when no config model set", () => {
    const models = {
      models: [
        { id: "expensive", billing: { multiplier: 10 } },
        { id: "cheap", billing: { multiplier: 1 } },
      ],
    };
    expect(resolveModel(models, null, false)).toBe("cheap");
  });

  it("uses config model when set", () => {
    const models = {
      models: [
        { id: "gpt-4.1", billing: { multiplier: 1 } },
        { id: "gpt-4.1-mini", billing: { multiplier: 0 } },
      ],
    };
    expect(resolveModel(models, "gpt-4.1", false)).toBe("gpt-4.1");
  });

  it("zeroPremium overrides premium config model", () => {
    const models = {
      models: [
        { id: "gpt-4.1", billing: { multiplier: 1 } },
        { id: "gpt-4.1-mini", billing: { multiplier: 0 } },
      ],
    };
    expect(resolveModel(models, "gpt-4.1", true)).toBe("gpt-4.1-mini");
  });

  it("zeroPremium keeps non-premium config model", () => {
    const models = {
      models: [
        { id: "gpt-4.1", billing: { multiplier: 1 } },
        { id: "gpt-4.1-mini", billing: { multiplier: 0 } },
      ],
    };
    expect(resolveModel(models, "gpt-4.1-mini", true)).toBe("gpt-4.1-mini");
  });

  it("zeroPremium returns undefined when no non-premium models", () => {
    const models = {
      models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }],
    };
    expect(resolveModel(models, null, true)).toBeUndefined();
  });
  it("zeroPremium with unknown config model falls through to configModel (consistent with agent fallback)", () => {
    // When the configured model ID is not in the models list, the gateway cannot
    // determine its billing tier, so it passes the model ID through unchanged.
    // The agent will receive this model and either use it or fall back on its own.
    const models = {
      models: [
        { id: "gpt-4.1", billing: { multiplier: 1 } },
        { id: "gpt-4.1-mini", billing: { multiplier: 0 } },
      ],
    };
    expect(resolveModel(models, "unknown-model-id", true)).toBe("unknown-model-id");
  });
});
