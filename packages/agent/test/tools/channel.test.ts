import { describe, expect, it } from "vitest";
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
    it("polls channel-scoped /inputs/next until 200 and returns combined messages", async () => {
      const { fetchFn, calls } = createMockFetch([
        { status: 204, body: null },
        { status: 200, body: [
          { id: "input-1", message: "hello" },
          { id: "input-2", message: "how are you" },
        ] },
      ]);

      const { receiveFirstInput } = createChannelTools({
        gatewayBaseUrl: "http://localhost:9999",
        channelId: "ch-abc",
        pollIntervalMs: 1,
        fetch: fetchFn as typeof globalThis.fetch,
      });

      const invocation = { sessionId: "s", toolCallId: "t", toolName: receiveFirstInput.name, arguments: {} };
      const result = await receiveFirstInput.handler({}, invocation) as { userMessage: string };

      expect(calls[0]?.url).toBe("http://localhost:9999/api/channels/ch-abc/inputs/next");
      expect(result.userMessage).toContain("hello");
      expect(result.userMessage).toContain("how are you");
      expect(result.userMessage).toContain(REPLY_TOOL_INSTRUCTION);
    });
  });

  describe("copilotclaw_reply_and_receive_input", () => {
    it("posts reply to channel then polls for next inputs", async () => {
      const { fetchFn, calls } = createMockFetch([
        // receiveFirstInput polls
        { status: 200, body: [{ id: "input-1", message: "first" }] },
        // replyAndReceiveInput posts reply
        { status: 200, body: {} },
        // then polls next inputs
        { status: 200, body: [{ id: "input-2", message: "second" }] },
      ]);

      const { receiveFirstInput, replyAndReceiveInput } = createChannelTools({
        gatewayBaseUrl: "http://localhost:9999",
        channelId: "ch-abc",
        pollIntervalMs: 1,
        fetch: fetchFn as typeof globalThis.fetch,
      });

      const invocation = { sessionId: "s", toolCallId: "t", toolName: "", arguments: {} };
      await receiveFirstInput.handler({}, invocation);

      const result = await replyAndReceiveInput.handler(
        { message: "reply-1" },
        invocation,
      ) as { userMessage: string };

      const replyCall = calls.find((c) => c.url.includes("/replies"));
      expect(replyCall).toBeTruthy();
      expect(replyCall!.url).toContain("/api/channels/ch-abc/replies");
      const replyBody = JSON.parse(replyCall!.init?.body as string) as { inputId: string; message: string };
      expect(replyBody.inputId).toBe("input-1");
      expect(replyBody.message).toBe("reply-1");

      expect(result.userMessage).toContain("second");
      expect(result.userMessage).toContain(REPLY_TOOL_INSTRUCTION);
    });

    it("has correct tool name and required parameters", () => {
      const { replyAndReceiveInput } = createChannelTools({
        gatewayBaseUrl: "http://localhost:9999",
        channelId: "ch-abc",
      });
      expect(replyAndReceiveInput.name).toBe("copilotclaw_reply_and_receive_input");
      const params = replyAndReceiveInput.parameters as Record<string, unknown>;
      expect(params).toMatchObject({ type: "object", required: ["message"] });
    });
  });
});
