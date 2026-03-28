import { describe, expect, it, vi } from "vitest";
import { createChannelTools } from "../../src/tools/channel.js";

function createMockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const resp = responses[callIndex] ?? { status: 204, body: null };
    callIndex++;
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as Response;
  };

  return { fetchFn, calls };
}

const WAIT_INSTRUCTION = "copilotclaw_wait";
const KEEPALIVE_MARKER = "keepalive cycle";

describe("channel tools — abort signal", () => {
  it("aborts polling when abort signal fires", async () => {
    const controller = new AbortController();
    let fetchCallCount = 0;

    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return { status: 204, ok: true, json: async () => null, text: async () => "null" } as Response;
    };

    const { wait } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
      pollIntervalMs: 10,
      fetch: fetchFn as typeof globalThis.fetch,
      abortSignal: controller.signal,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };

    setTimeout(() => { controller.abort(); }, 50);

    // wait NEVER throws — even on abort, it returns keepalive response
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("copilotclaw_wait");

    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
  });

  it("never throws on fetch network error — returns keepalive response", async () => {
    const fetchFn = async () => {
      throw new Error("network unreachable");
    };

    const { wait } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-err",
      pollIntervalMs: 10,
      fetch: fetchFn as typeof globalThis.fetch,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must NOT throw — returns keepalive instead
    const result = await wait.handler({}, invocation) as { userMessage: string };
    expect(result.userMessage).toContain("copilotclaw_wait");

    // Error was logged to system log
    const logged = errSpy.mock.calls.some(
      (c) => String(c[0]).includes("wait internal error"),
    );
    expect(logged).toBe(true);

    errSpy.mockRestore();
  });
});

describe("copilotclaw_send_message", () => {
  it("posts message to channel and returns immediately", async () => {
    const { fetchFn, calls } = createMockFetch([
      { status: 201, body: { id: "msg-1", sender: "agent", message: "hello" } },
    ]);

    const { sendMessage } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
      fetch: fetchFn as typeof globalThis.fetch,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await sendMessage.handler({ message: "hello" }, invocation) as { status: string };

    expect(result.status).toBe("sent");
    expect(calls[0]?.url).toBe("http://localhost:9999/api/channels/ch-abc/messages");
    const body = JSON.parse(calls[0]!.init?.body as string) as { sender: string; message: string };
    expect(body.sender).toBe("agent");
    expect(body.message).toBe("hello");
  });

  it("has correct tool name", () => {
    const { sendMessage } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
    });
    expect(sendMessage.name).toBe("copilotclaw_send_message");
  });
});

describe("copilotclaw_wait", () => {
  it("polls until 200 and returns combined messages", async () => {
    const { fetchFn, calls } = createMockFetch([
      { status: 204, body: null },
      { status: 200, body: [
        { id: "input-1", message: "hello" },
        { id: "input-2", message: "how are you" },
      ] },
    ]);

    const { wait } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
      pollIntervalMs: 1,
      fetch: fetchFn as typeof globalThis.fetch,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(calls[0]?.url).toBe("http://localhost:9999/api/channels/ch-abc/messages/pending");
    expect(result.userMessage).toContain("hello");
    expect(result.userMessage).toContain("how are you");
    expect(result.userMessage).toContain(WAIT_INSTRUCTION);
  });

  it("returns keepalive instruction on timeout", async () => {
    const { fetchFn } = createMockFetch(
      Array.from({ length: 100 }, () => ({ status: 204, body: null })),
    );

    const { wait } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
      pollIntervalMs: 1,
      keepaliveTimeoutMs: 20,
      fetch: fetchFn as typeof globalThis.fetch,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(result.userMessage).toContain(KEEPALIVE_MARKER);
    expect(result.userMessage).toContain(WAIT_INSTRUCTION);
  });

  it("does not trigger keepalive when input arrives within timeout", async () => {
    const { fetchFn } = createMockFetch([
      { status: 204, body: null },
      { status: 200, body: [{ id: "input-1", message: "arrived in time" }] },
    ]);

    const { wait } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
      pollIntervalMs: 1,
      keepaliveTimeoutMs: 5000,
      fetch: fetchFn as typeof globalThis.fetch,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await wait.handler({}, invocation) as { userMessage: string };

    expect(result.userMessage).toContain("arrived in time");
    expect(result.userMessage).not.toContain(KEEPALIVE_MARKER);
  });
});

describe("copilotclaw_list_messages", () => {
  it("fetches messages from gateway with default limit", async () => {
    const mockMessages = [
      { id: "m1", channelId: "ch-abc", sender: "user", message: "hi", createdAt: "2026-01-01T00:00:00Z" },
      { id: "m2", channelId: "ch-abc", sender: "agent", message: "hello", createdAt: "2026-01-01T00:00:01Z" },
    ];
    const { fetchFn, calls } = createMockFetch([
      { status: 200, body: mockMessages },
    ]);

    const { listMessages } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
      fetch: fetchFn as typeof globalThis.fetch,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    const result = await listMessages.handler({}, invocation) as { messages: unknown[] };

    expect(calls[0]?.url).toBe("http://localhost:9999/api/channels/ch-abc/messages?limit=5");
    expect(result.messages).toHaveLength(2);
  });

  it("passes custom limit", async () => {
    const { fetchFn, calls } = createMockFetch([
      { status: 200, body: [] },
    ]);

    const { listMessages } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
      fetch: fetchFn as typeof globalThis.fetch,
    });

    const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
    await listMessages.handler({ limit: 10 }, invocation);

    expect(calls[0]?.url).toBe("http://localhost:9999/api/channels/ch-abc/messages?limit=10");
  });

  it("has correct tool name", () => {
    const { listMessages } = createChannelTools({
      gatewayBaseUrl: "http://localhost:9999",
      channelId: "ch-abc",
    });
    expect(listMessages.name).toBe("copilotclaw_list_messages");
  });
});
