import { describe, expect, it, vi } from "vitest";
import { semverSatisfies, AgentManager } from "../../src/agent-manager.js";

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
      channelId: "ch-1",
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
      channelId: "ch-1",
      eventType: "tool.execution_start",
      timestamp: "2026-01-01T00:00:00Z",
      data: { toolName: "Read" },
    });

    expect(onSessionEvent).toHaveBeenCalledWith(
      "s-1", "ch-1", "tool.execution_start", "2026-01-01T00:00:00Z",
      { toolName: "Read" }, undefined,
    );
  });

  it("dispatches session_event with parentId", () => {
    const manager = new AgentManager();
    const onSessionEvent = vi.fn();
    manager.setStreamMessageHandler({ onSessionEvent });

    invokeHandleAgentMessage(manager, {
      type: "session_event",
      sessionId: "s-1",
      eventType: "subagent.completed",
      timestamp: "2026-01-01T00:00:00Z",
      data: { agentName: "worker" },
      parentId: "parent-123",
    });

    expect(onSessionEvent).toHaveBeenCalledWith(
      "s-1", undefined, "subagent.completed", "2026-01-01T00:00:00Z",
      { agentName: "worker" }, "parent-123",
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
      channelId: "ch-1",
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
      channelId: "ch-1",
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
      channelId: "ch-1",
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
      channelId: "ch-1",
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
      channelId: "ch-1",
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
    invokeHandleAgentMessage(manager, { type: "channel_message", channelId: "ch-1", sender: "agent", message: "hi" });
  });

  it("ignores messages with no type field", () => {
    const manager = new AgentManager();
    const onChannelMessage = vi.fn();
    manager.setStreamMessageHandler({ onChannelMessage });

    invokeHandleAgentMessage(manager, { channelId: "ch-1", sender: "agent", message: "hi" });
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
    expect(streamSend).toHaveBeenCalledWith({ type: "agent_notify", channelId: "ch-1" });
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
