import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the IPC server module before importing channel tools
vi.mock("../../src/ipc-server.js", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    requestFromGateway: vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
      // Default mock: tool_call RPCs return tool-specific defaults.
      // Tests override this mock per-test as needed.
      if (msg.type === "tool_call") {
        if (msg.toolName === "copilotclaw_send_message") return { status: "sent" };
        if (msg.toolName === "copilotclaw_list_messages") return { messages: [] };
        // copilotclaw_wait: return null → agent falls through to keepalive
        if (msg.toolName === "copilotclaw_wait") return null;
      }
      // drain_pending, peek_pending etc: return null (no messages)
      return null;
    }),
    streamEvents: new EventEmitter(),
    hasStream: vi.fn().mockReturnValue(true),
    getStreamSocket: vi.fn().mockReturnValue(null),
    setStreamSocket: vi.fn(),
  };
});

import { createChannelTools, type ChannelToolDeps } from "../../src/tools/channel.js";
import { requestFromGateway, streamEvents } from "../../src/ipc-server.js";

const DEFAULT_TOOL_DEFS = [
  {
    name: "copilotclaw_send_message",
    description: "Send a message",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "copilotclaw_list_messages",
    description: "List messages",
    parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
  },
];

/** Helper: create channel tools and extract by name for test convenience. */
function makeTools(deps: Partial<ChannelToolDeps> & { channelId: string }) {
  const { tools } = createChannelTools({
    keepaliveTimeoutMs: 25 * 60 * 1000,
    toolDefinitions: DEFAULT_TOOL_DEFS,
    ...deps,
  });
  const findTool = (name: string) => tools.find((t) => t.name === name);
  return {
    wait: findTool("copilotclaw_wait")!,
    sendMessage: findTool("copilotclaw_send_message"),
    listMessages: findTool("copilotclaw_list_messages"),
    tools,
  };
}

const WAIT_INSTRUCTION = "copilotclaw_wait";
const KEEPALIVE_MARKER = "keepalive cycle";

/** Configure the requestFromGateway mock for wait tool tests.
 *  wait tries gateway RPC first (tool_call → null), then falls through to drain_pending. */
function mockDrainReturns(messages: unknown[]): void {
  (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(async (msg: Record<string, unknown>) => {
    if (msg.type === "tool_call") {
      if (msg.toolName === "copilotclaw_send_message") return { status: "sent" };
      if (msg.toolName === "copilotclaw_list_messages") return { messages: [] };
      return null; // copilotclaw_wait: fall through to agent keepalive
    }
    if (msg.type === "drain_pending") return messages;
    return null;
  });
}

function mockDrainEmpty(): void { mockDrainReturns([]); }

function mockGatewayDown(): void {
  (requestFromGateway as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IPC error"));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default mock after clearAllMocks resets the implementation
  (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(async (msg: Record<string, unknown>) => {
    if (msg.type === "tool_call") {
      if (msg.toolName === "copilotclaw_send_message") return { status: "sent" };
      if (msg.toolName === "copilotclaw_list_messages") return { messages: [] };
      if (msg.toolName === "copilotclaw_wait") return null;
    }
    return null;
  });
});

describe("channel tools — abort signal", () => {
  it("aborts polling when abort signal fires", async () => {
    const controller = new AbortController();
    // wait: gateway RPC returns null → fallback; drain_pending returns empty
    mockDrainEmpty();

    const { wait } = makeTools({
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
    mockGatewayDown();

    const { wait } = makeTools({
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
  it("sends message via gateway RPC and returns result", async () => {
    const { sendMessage } = makeTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await sendMessage!.handler({ message: "hello" }, invocation) as { status: string };

    expect(result.status).toBe("sent");
    expect(requestFromGateway).toHaveBeenCalledWith({
      type: "tool_call",
      toolName: "copilotclaw_send_message",
      channelId: "ch-abc",
      args: { message: "hello" },
    });
  });

  it("returns graceful error on gateway disconnect", async () => {
    mockGatewayDown();

    const { sendMessage } = makeTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendMessage!.handler({ message: "hello" }, invocation) as { error: string };

    expect(result.error).toContain("Gateway is not connected");
    errSpy.mockRestore();
  });

  it("has correct tool name", () => {
    const { sendMessage } = makeTools({
      channelId: "ch-abc",
    });
    expect(sendMessage!.name).toBe("copilotclaw_send_message");
  });
});

describe("copilotclaw_wait", () => {
  it("drains immediately when messages available", async () => {
    mockDrainReturns([
      { id: "input-1", message: "hello" },
      { id: "input-2", message: "how are you" },
    ]);

    const { wait } = makeTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(result.userMessage).toContain("hello");
    expect(result.userMessage).toContain("how are you");
    expect(result.userMessage).toContain(WAIT_INSTRUCTION);
  });

  it("returns keepalive instruction on timeout (no messages, no notify)", async () => {
    mockDrainEmpty();

    const { wait } = makeTools({
      channelId: "ch-abc",
      keepaliveTimeoutMs: 20,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(result.userMessage).toContain(KEEPALIVE_MARKER);
    expect(result.userMessage).toContain(WAIT_INSTRUCTION);
  });

  it("drains after agent_notify push", async () => {
    let drainCallCount = 0;
    (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(async (msg: Record<string, unknown>) => {
      if (msg.type === "tool_call") {
        if (msg.toolName === "copilotclaw_send_message") return { status: "sent" };
        if (msg.toolName === "copilotclaw_list_messages") return { messages: [] };
        return null; // copilotclaw_wait: fall through to agent keepalive
      }
      if (msg.type === "drain_pending") {
        drainCallCount++;
        if (drainCallCount === 1) return []; // First drain: empty
        return [{ id: "input-1", message: "arrived via notify" }]; // Second drain after notify
      }
      return null;
    });

    const { wait } = makeTools({
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
    mockDrainReturns([
      { id: "sys-1", sender: "system", message: "[SUBAGENT COMPLETED] worker completed" },
    ]);

    const { wait } = makeTools({ channelId: "ch-sys", keepaliveTimeoutMs: 100 });
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("[SYSTEM EVENT]");
    expect(result.userMessage).toContain("SUBAGENT COMPLETED");
  });

  it("combines user and system messages together", async () => {
    mockDrainReturns([
      { id: "u-1", sender: "user", message: "hello" },
      { id: "sys-1", sender: "system", message: "[SUBAGENT COMPLETED] worker completed" },
    ]);

    const { wait } = makeTools({ channelId: "ch-mixed", keepaliveTimeoutMs: 100 });
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("hello");
    expect(result.userMessage).toContain("[SYSTEM EVENT]");
  });

  it("formats cron messages with [CRON TASK] prefix", async () => {
    mockDrainReturns([
      { id: "c-1", sender: "cron", message: "[cron:daily] report task" },
    ]);

    const { wait } = makeTools({ channelId: "ch-cron-fmt", keepaliveTimeoutMs: 100 });
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("[CRON TASK]");
    expect(result.userMessage).toContain("report task");
  });
});

describe("copilotclaw_wait — swallowed message detection", () => {
  it("returns swallowed-message reminder when wait called twice without send_message", async () => {
    mockDrainReturns([
      { id: "input-1", sender: "user", message: "hello" },
    ]);

    const logErrorSpy = vi.fn();
    const { wait } = makeTools({
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

  it("does NOT trigger swallowed-message after send_message is called (dynamic tool clears flag)", async () => {
    // The dynamic send_message tool wraps its gateway handler to clear
    // pendingReplyExpected, so the swallowed-message guard is not falsely
    // triggered when the agent correctly replied via send_message.
    let drainCallCount = 0;
    (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(async (msg: Record<string, unknown>) => {
      if (msg.type === "tool_call") {
        if (msg.toolName === "copilotclaw_send_message") return { status: "sent" };
        if (msg.toolName === "copilotclaw_list_messages") return { messages: [] };
        return null; // copilotclaw_wait: fall through
      }
      if (msg.type === "drain_pending") {
        drainCallCount++;
        if (drainCallCount === 1) return [{ id: "input-1", sender: "user", message: "hello" }];
        return [];
      }
      return null;
    });

    const logErrorSpy = vi.fn();
    const { sendMessage, wait } = makeTools({
      channelId: "ch-no-swallow",
      keepaliveTimeoutMs: 20,
      logError: logErrorSpy,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };

    // First wait: returns user message, sets pendingReplyExpected = true
    await wait.handler({}, invocation);

    // Call send_message — clears pendingReplyExpected (dynamic tool wrapper)
    await sendMessage!.handler({ message: "reply" }, invocation);

    // Second wait: swallowed-message guard should NOT fire
    const result2 = await wait.handler({}, invocation) as { userMessage: string };
    expect(result2.userMessage).not.toContain("CRITICAL");
    expect(logErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining("swallowed message"));
  });
});

describe("copilotclaw_wait — onStatusChange callback", () => {
  it("fires waiting on poll start, processing when messages arrive", async () => {
    mockDrainReturns([
      { id: "input-1", sender: "user", message: "hi" },
    ]);

    const statusChanges: string[] = [];
    const { wait } = makeTools({
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
    mockDrainEmpty();

    const statusChanges: string[] = [];
    const { wait } = makeTools({
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
    (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(async (msg: Record<string, unknown>) => {
      if (msg.type === "tool_call") return null; // copilotclaw_wait: fall through
      if (msg.type === "drain_pending") return { unexpected: true }; // non-array
      return null;
    });

    const { wait } = makeTools({
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

    mockDrainEmpty();

    const { wait } = makeTools({
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
  it("returns graceful error when gateway is down", async () => {
    mockGatewayDown();

    const { listMessages } = makeTools({
      channelId: "ch-err",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await listMessages!.handler({}, invocation) as { error: string };
    expect(result.error).toContain("Gateway is not connected");
    errSpy.mockRestore();
  });

  it("returns gateway result when RPC returns null", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { listMessages } = makeTools({
      channelId: "ch-null",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await listMessages!.handler({}, invocation) as { status: string };
    // When requestFromGateway returns null, createGatewayToolHandler returns { status: "ok" }
    expect(result.status).toBe("ok");
  });
});

describe("copilotclaw_list_messages", () => {
  it("dispatches to gateway via RPC and returns result", async () => {
    const mockMessages = {
      messages: [
        { id: "m1", channelId: "ch-abc", sender: "user", message: "hi", createdAt: "2026-01-01T00:00:00Z" },
        { id: "m2", channelId: "ch-abc", sender: "agent", message: "hello", createdAt: "2026-01-01T00:00:01Z" },
      ],
    };
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

    const { listMessages } = makeTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await listMessages!.handler({}, invocation) as { messages: unknown[] };

    expect(result.messages).toHaveLength(2);
    expect(requestFromGateway).toHaveBeenCalledWith({
      type: "tool_call",
      toolName: "copilotclaw_list_messages",
      channelId: "ch-abc",
      args: {},
    });
  });

  it("passes arguments to gateway RPC", async () => {
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [] });

    const { listMessages } = makeTools({
      channelId: "ch-abc",
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    await listMessages!.handler({ limit: 10 }, invocation);

    expect(requestFromGateway).toHaveBeenCalledWith({
      type: "tool_call",
      toolName: "copilotclaw_list_messages",
      channelId: "ch-abc",
      args: { limit: 10 },
    });
  });

  it("has correct tool name", () => {
    const { listMessages } = makeTools({
      channelId: "ch-abc",
    });
    expect(listMessages!.name).toBe("copilotclaw_list_messages");
  });
});
