import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the IPC server module before importing channel tools
vi.mock("../../src/ipc-server.js", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    sendToGateway: vi.fn(),
    requestFromGateway: vi.fn().mockResolvedValue(null),
    streamEvents: new EventEmitter(),
    hasStream: vi.fn().mockReturnValue(true),
    getStreamSocket: vi.fn().mockReturnValue(null),
    setStreamSocket: vi.fn(),
  };
});

import { createChannelTools } from "../../src/tools/channel.js";
import { sendToGateway, requestFromGateway, streamEvents } from "../../src/ipc-server.js";

const WAIT_INSTRUCTION = "copilotclaw_wait";
const KEEPALIVE_MARKER = "keepalive cycle";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("channel tools — abort signal", () => {
  it("aborts polling when abort signal fires", async () => {
    const controller = new AbortController();
    // requestFromGateway returns empty array (no pending)
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { wait } = createChannelTools({
      channelId: "ch-abc",
      abortSignal: controller.signal,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };

    setTimeout(() => { controller.abort(); }, 50);

    // wait NEVER throws — even on abort, it returns keepalive response
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("copilotclaw_wait");
  });

  it("never throws on IPC error — returns keepalive response", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IPC error"));

    const { wait } = createChannelTools({
      channelId: "ch-err",
      keepaliveTimeoutMs: 50,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must NOT throw — returns keepalive instead
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("copilotclaw_wait");

    errSpy.mockRestore();
  });
});

describe("copilotclaw_send_message", () => {
  it("sends message via IPC and returns immediately", async () => {
    const { sendMessage } = createChannelTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await sendMessage.handler({ message: "hello" }, invocation) as { status: string };

    expect(result.status).toBe("sent");
    const sendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    expect(sendSpy).toHaveBeenCalledWith({
      type: "channel_message",
      channelId: "ch-abc",
      sender: "agent",
      message: "hello",
    });
  });

  it("has correct tool name", () => {
    const { sendMessage } = createChannelTools({
      channelId: "ch-abc",
    });
    expect(sendMessage.name).toBe("copilotclaw_send_message");
  });
});

describe("copilotclaw_wait", () => {
  it("drains immediately when messages available", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "input-1", message: "hello" },
      { id: "input-2", message: "how are you" },
    ]);

    const { wait } = createChannelTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(result.userMessage).toContain("hello");
    expect(result.userMessage).toContain("how are you");
    expect(result.userMessage).toContain(WAIT_INSTRUCTION);
  });

  it("returns keepalive instruction on timeout (no messages, no notify)", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { wait } = createChannelTools({
      channelId: "ch-abc",
      keepaliveTimeoutMs: 20,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(result.userMessage).toContain(KEEPALIVE_MARKER);
    expect(result.userMessage).toContain(WAIT_INSTRUCTION);
  });

  it("drains after agent_notify push", async () => {
    let callCount = 0;
    (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return []; // First drain: empty
      return [{ id: "input-1", message: "arrived via notify" }]; // Second drain after notify
    });

    const { wait } = createChannelTools({
      channelId: "ch-notify",
      keepaliveTimeoutMs: 5000,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };

    // Emit agent_notify shortly after wait starts polling
    setTimeout(() => {
      streamEvents.emit("agent_notify", { channelId: "ch-notify" });
    }, 30);

    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(result.userMessage).toContain("arrived via notify");
    expect(result.userMessage).not.toContain(KEEPALIVE_MARKER);
  });

  it("formats system messages with [SYSTEM EVENT] prefix", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "sys-1", sender: "system", message: "[SUBAGENT COMPLETED] worker completed" },
    ]);

    const { wait } = createChannelTools({ channelId: "ch-sys", keepaliveTimeoutMs: 100 });
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("[SYSTEM EVENT]");
    expect(result.userMessage).toContain("SUBAGENT COMPLETED");
  });

  it("combines user and system messages together", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "u-1", sender: "user", message: "hello" },
      { id: "sys-1", sender: "system", message: "[SUBAGENT COMPLETED] worker completed" },
    ]);

    const { wait } = createChannelTools({ channelId: "ch-mixed", keepaliveTimeoutMs: 100 });
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("hello");
    expect(result.userMessage).toContain("[SYSTEM EVENT]");
  });

  it("formats cron messages with [CRON TASK] prefix", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "c-1", sender: "cron", message: "[cron:daily] report task" },
    ]);

    const { wait } = createChannelTools({ channelId: "ch-cron-fmt", keepaliveTimeoutMs: 100 });
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("[CRON TASK]");
    expect(result.userMessage).toContain("report task");
  });
});

describe("copilotclaw_wait — swallowed message detection", () => {
  it("returns swallowed-message reminder when wait called twice without send_message", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "input-1", sender: "user", message: "hello" },
    ]);

    const logErrorSpy = vi.fn();
    const { wait } = createChannelTools({
      channelId: "ch-swallow",
      keepaliveTimeoutMs: 20,
      logError: logErrorSpy,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };

    // First wait: returns user message and sets pendingReplyExpected = true
    const result1 = await wait.handler({}, invocation) as { userMessage: string };
    expect(result1.userMessage).toContain("hello");

    // Second wait: send_message was NOT called, so swallowed-message guard fires
    const result2 = await wait.handler({}, invocation) as { userMessage: string };
    expect(result2.userMessage).toContain("CRITICAL");
    expect(result2.userMessage).toContain("copilotclaw_send_message");
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining("swallowed message"));
  });

  it("does NOT trigger swallowed-message after send_message is called", async () => {
    let callCount = 0;
    (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ id: "input-1", sender: "user", message: "hello" }];
      return [];
    });

    const { sendMessage, wait } = createChannelTools({
      channelId: "ch-no-swallow",
      keepaliveTimeoutMs: 20,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };

    // First wait: returns user message
    await wait.handler({}, invocation);

    // Call send_message — clears pendingReplyExpected
    await sendMessage.handler({ message: "reply" }, invocation);

    // Second wait: should NOT fire swallowed-message guard
    const result2 = await wait.handler({}, invocation) as { userMessage: string };
    expect(result2.userMessage).not.toContain("CRITICAL");
  });
});

describe("copilotclaw_wait — onStatusChange callback", () => {
  it("fires waiting on poll start, processing when messages arrive", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "input-1", sender: "user", message: "hi" },
    ]);

    const statusChanges: string[] = [];
    const { wait } = createChannelTools({
      channelId: "ch-status",
      keepaliveTimeoutMs: 20,
      onStatusChange: (status) => { statusChanges.push(status); },
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    await wait.handler({}, invocation);

    expect(statusChanges).toContain("waiting");
    expect(statusChanges).toContain("processing");
  });

  it("fires waiting but not processing on keepalive timeout", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const statusChanges: string[] = [];
    const { wait } = createChannelTools({
      channelId: "ch-status-timeout",
      keepaliveTimeoutMs: 20,
      onStatusChange: (status) => { statusChanges.push(status); },
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    await wait.handler({}, invocation);

    expect(statusChanges).toContain("waiting");
    expect(statusChanges).not.toContain("processing");
  });
});

describe("copilotclaw_wait — IPC returns non-array", () => {
  it("treats non-array IPC response as no pending messages (keepalive)", async () => {
    // drainPendingViaIpc checks Array.isArray(data) — non-array means no messages
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ unexpected: true });

    const { wait } = createChannelTools({
      channelId: "ch-nonarray",
      keepaliveTimeoutMs: 20,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("keepalive");
  });
});

describe("copilotclaw_wait — pre-aborted signal", () => {
  it("returns keepalive immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(); // Already aborted

    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { wait } = createChannelTools({
      channelId: "ch-pre-abort",
      abortSignal: controller.signal,
      keepaliveTimeoutMs: 5000,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("keepalive");
  });
});

describe("copilotclaw_list_messages — error handling", () => {
  it("throws when IPC request fails", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IPC down"));

    const { listMessages } = createChannelTools({
      channelId: "ch-err",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    await expect(listMessages.handler({}, invocation)).rejects.toThrow("list_messages failed");
  });

  it("returns empty array when IPC returns non-array", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { listMessages } = createChannelTools({
      channelId: "ch-null",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await listMessages.handler({}, invocation) as { messages: unknown[] };
    expect(result.messages).toEqual([]);
  });
});

describe("copilotclaw_list_messages", () => {
  it("fetches messages via IPC with default limit", async () => {
    const mockMessages = [
      { id: "m1", channelId: "ch-abc", sender: "user", message: "hi", createdAt: "2026-01-01T00:00:00Z" },
      { id: "m2", channelId: "ch-abc", sender: "agent", message: "hello", createdAt: "2026-01-01T00:00:01Z" },
    ];
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

    const { listMessages } = createChannelTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await listMessages.handler({}, invocation) as { messages: unknown[] };

    expect(result.messages).toHaveLength(2);
    expect(requestFromGateway).toHaveBeenCalledWith({
      type: "list_messages",
      channelId: "ch-abc",
      limit: 5,
    });
  });

  it("passes custom limit", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { listMessages } = createChannelTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    await listMessages.handler({ limit: 10 }, invocation);

    expect(requestFromGateway).toHaveBeenCalledWith({
      type: "list_messages",
      channelId: "ch-abc",
      limit: 10,
    });
  });

  it("has correct tool name", () => {
    const { listMessages } = createChannelTools({
      channelId: "ch-abc",
    });
    expect(listMessages.name).toBe("copilotclaw_list_messages");
  });
});
