import { describe, expect, it, vi, beforeEach } from "vitest";
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

const REPLY_TOOL_INSTRUCTION = "copilotclaw_reply_and_receive_input";

describe("channel tools", () => {
  describe("copilotclaw_receive_first_input", () => {
    it("polls /api/inputs/next until 200 and returns user message with reply instruction", async () => {
      const { fetchFn, calls } = createMockFetch([
        { status: 204, body: null },
        { status: 200, body: { id: "input-1", message: "hello agent" } },
      ]);

      const { receiveFirstInput } = createChannelTools({
        gatewayBaseUrl: "http://localhost:9999",
        pollIntervalMs: 1,
        fetch: fetchFn as typeof globalThis.fetch,
      });

      const invocation = { sessionId: "s", toolCallId: "t", toolName: receiveFirstInput.name, arguments: {} };
      const result = await receiveFirstInput.handler({}, invocation) as { userMessage: string };

      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toBe("http://localhost:9999/api/inputs/next");
      expect(result.userMessage).toContain("hello agent");
      expect(result.userMessage).toContain(REPLY_TOOL_INSTRUCTION);
    });

    it("has correct tool name and description", () => {
      const { receiveFirstInput } = createChannelTools({
        gatewayBaseUrl: "http://localhost:9999",
      });
      expect(receiveFirstInput.name).toBe("copilotclaw_receive_first_input");
      expect(receiveFirstInput.description).toBeTruthy();
    });
  });

  describe("copilotclaw_reply_and_receive_input", () => {
    it("posts reply then polls for next input", async () => {
      const { fetchFn, calls } = createMockFetch([
        // First: receiveFirstInput polls
        { status: 200, body: { id: "input-1", message: "first" } },
        // Then: replyAndReceiveInput posts reply
        { status: 200, body: { id: "input-1", message: "first", reply: { message: "reply-1" } } },
        // Then: polls next input
        { status: 200, body: { id: "input-2", message: "second" } },
      ]);

      const { receiveFirstInput, replyAndReceiveInput } = createChannelTools({
        gatewayBaseUrl: "http://localhost:9999",
        pollIntervalMs: 1,
        fetch: fetchFn as typeof globalThis.fetch,
      });

      const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };

      // First call to set currentInputId
      await receiveFirstInput.handler({}, invocation);

      // Now reply and receive next
      const result = await replyAndReceiveInput.handler(
        { message: "reply-1" },
        invocation,
      ) as { userMessage: string };

      // Verify POST /api/replies was called
      const replyCall = calls.find((c) => c.url.includes("/api/replies"));
      expect(replyCall).toBeTruthy();
      const replyBody = JSON.parse(replyCall!.init?.body as string) as { inputId: string; message: string };
      expect(replyBody.inputId).toBe("input-1");
      expect(replyBody.message).toBe("reply-1");

      // Verify result contains next user message
      expect(result.userMessage).toContain("second");
      expect(result.userMessage).toContain(REPLY_TOOL_INSTRUCTION);
    });

    it("has correct tool name and required parameters", () => {
      const { replyAndReceiveInput } = createChannelTools({
        gatewayBaseUrl: "http://localhost:9999",
      });
      expect(replyAndReceiveInput.name).toBe("copilotclaw_reply_and_receive_input");
      const params = replyAndReceiveInput.parameters as Record<string, unknown>;
      expect(params).toMatchObject({
        type: "object",
        required: ["message"],
      });
    });
  });
});
