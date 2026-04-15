import { describe, expect, it } from "vitest";
import { resolveAgentSenderMeta } from "../../src/message-sender.js";

describe("resolveAgentSenderMeta", () => {
  const channelOperatorMeta = { agentName: "channel-operator", agentDisplayName: "Channel Operator" };

  it("returns channel-operator role when parentToolCallId is undefined", () => {
    const result = resolveAgentSenderMeta("session-1", undefined, {}, channelOperatorMeta);
    expect(result).toEqual({
      agentId: "channel-operator",
      agentDisplayName: "Channel Operator",
      agentRole: "channel-operator",
    });
  });

  it("returns subagent role when parentToolCallId matches a tracked subagent", () => {
    const orchestrator = {
      getSubagentInfo: (sessionId: string, toolCallId: string) => {
        if (sessionId === "session-1" && toolCallId === "tool-abc") {
          return { agentName: "worker", agentDisplayName: "Worker" };
        }
        return undefined;
      },
    };
    const result = resolveAgentSenderMeta("session-1", "tool-abc", orchestrator, channelOperatorMeta);
    expect(result).toEqual({
      agentId: "worker",
      agentDisplayName: "Worker",
      agentRole: "subagent",
    });
  });

  it("returns unknown-subagent fallback when parentToolCallId does not match", () => {
    const orchestrator = {
      getSubagentInfo: () => undefined,
    };
    const result = resolveAgentSenderMeta("session-1", "tool-unknown", orchestrator, channelOperatorMeta);
    expect(result).toEqual({
      agentId: "unknown-subagent",
      agentDisplayName: "Subagent",
      agentRole: "subagent",
    });
  });

  it("returns channel-operator even when getSubagentInfo is missing from orchestrator", () => {
    const result = resolveAgentSenderMeta("session-1", undefined, {}, channelOperatorMeta);
    expect(result.agentRole).toBe("channel-operator");
  });

  it("returns unknown-subagent fallback when orchestrator has no getSubagentInfo method", () => {
    const result = resolveAgentSenderMeta("session-1", "tool-abc", {}, channelOperatorMeta);
    expect(result).toEqual({
      agentId: "unknown-subagent",
      agentDisplayName: "Subagent",
      agentRole: "subagent",
    });
  });

  it("uses channelOperatorMeta agentName and agentDisplayName for channel-operator", () => {
    const customMeta = { agentName: "my-operator", agentDisplayName: "My Operator" };
    const result = resolveAgentSenderMeta("session-1", undefined, {}, customMeta);
    expect(result.agentId).toBe("my-operator");
    expect(result.agentDisplayName).toBe("My Operator");
  });
});
