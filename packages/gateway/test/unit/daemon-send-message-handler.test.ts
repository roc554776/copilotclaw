/**
 * Tests for handleSendMessageToolCall — the extracted daemon.ts handler for the
 * copilotclaw_send_message tool call.
 *
 * The copilotclaw_send_message tool is only callable from the channel-operator (never
 * from subagents). These tests verify that the handler always assigns channel-operator
 * senderMeta and stores the message correctly.
 *
 * Drift-prevention pattern: tests import the real named export from daemon.ts, so any
 * changes to the handler's senderMeta logic will break these tests immediately.
 */
import { describe, expect, it } from "vitest";
import { handleSendMessageToolCall } from "../../src/daemon.js";
import type { SendMessageToolCallDeps } from "../../src/daemon.js";
import { Store } from "../../src/store.js";

const defaultChannelOperatorMeta = { agentName: "channel-operator", agentDisplayName: "Channel Operator" };

function makeDeps(store: Store, overrides?: Partial<SendMessageToolCallDeps>): SendMessageToolCallDeps {
  return {
    store,
    channelOperatorMeta: defaultChannelOperatorMeta,
    ...overrides,
  };
}

describe("handleSendMessageToolCall", () => {
  it("stores the message with channel-operator senderMeta", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const result = handleSendMessageToolCall("session-1", channelId, "Hello world", makeDeps(store));

    expect(result.senderMeta).toEqual({
      agentId: "channel-operator",
      agentDisplayName: "Channel Operator",
      agentRole: "channel-operator",
    });

    const msgs = store.listMessages(channelId, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender).toBe("agent");
    expect(msgs[0]!.message).toBe("Hello world");
    expect(msgs[0]!.senderMeta).toEqual({
      agentId: "channel-operator",
      agentDisplayName: "Channel Operator",
      agentRole: "channel-operator",
    });
  });

  it("always uses channel-operator role regardless of sessionId (send_message is not subagent-callable)", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    // Even with a different sessionId, the role should always be channel-operator
    const result = handleSendMessageToolCall("any-session-id", channelId, "Test message", makeDeps(store));

    expect(result.senderMeta.agentRole).toBe("channel-operator");
  });

  it("uses the channelOperatorMeta provided in deps for agentId and agentDisplayName", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    const customMeta = { agentName: "my-operator", agentDisplayName: "My Custom Operator" };
    const result = handleSendMessageToolCall("session-1", channelId, "Hi", {
      ...makeDeps(store),
      channelOperatorMeta: customMeta,
    });

    expect(result.senderMeta.agentId).toBe("my-operator");
    expect(result.senderMeta.agentDisplayName).toBe("My Custom Operator");
    expect(result.senderMeta.agentRole).toBe("channel-operator");
  });

  it("broadcasts to SSE when sseBroadcast is provided", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const broadcasts: Array<Record<string, unknown>> = [];

    handleSendMessageToolCall("session-1", channelId, "Broadcast test", {
      ...makeDeps(store),
      sseBroadcast: (e) => broadcasts.push(e),
    });

    expect(broadcasts).toHaveLength(1);
    const ev = broadcasts[0] as Record<string, unknown>;
    expect(ev["type"]).toBe("new_message");
    expect(ev["channelId"]).toBe(channelId);
    const data = ev["data"] as Record<string, unknown>;
    expect(data["sender"]).toBe("agent");
    expect(data["message"]).toBe("Broadcast test");
    expect((data["senderMeta"] as Record<string, unknown>)["agentRole"]).toBe("channel-operator");
  });

  it("does not throw when sseBroadcast is not provided", () => {
    const store = new Store();
    const channelId = store.createChannel().id;

    expect(() =>
      handleSendMessageToolCall("session-1", channelId, "No broadcast", makeDeps(store)),
    ).not.toThrow();
  });
});
