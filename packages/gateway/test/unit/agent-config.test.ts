import { describe, expect, it } from "vitest";
import { getAgentPromptConfig } from "../../src/agent-config.js";

describe("getAgentPromptConfig — customAgents copilotclawTools", () => {
  it("channel-operator includes copilotclaw_wait, copilotclaw_list_messages, copilotclaw_send_message", () => {
    const config = getAgentPromptConfig();
    const operator = config.customAgents.find((a) => a.name === "channel-operator");
    expect(operator).toBeDefined();
    expect(operator!.copilotclawTools).toContain("copilotclaw_wait");
    expect(operator!.copilotclawTools).toContain("copilotclaw_list_messages");
    expect(operator!.copilotclawTools).toContain("copilotclaw_send_message");
  });

  it("worker includes copilotclaw_list_messages and copilotclaw_send_message but not copilotclaw_wait", () => {
    const config = getAgentPromptConfig();
    const worker = config.customAgents.find((a) => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!.copilotclawTools).toContain("copilotclaw_list_messages");
    expect(worker!.copilotclawTools).toContain("copilotclaw_send_message");
    expect(worker!.copilotclawTools).not.toContain("copilotclaw_wait");
  });

  it("no agent includes copilotclaw_intent (not yet implemented)", () => {
    const config = getAgentPromptConfig();
    for (const agent of config.customAgents) {
      expect(agent.copilotclawTools).not.toContain("copilotclaw_intent");
    }
  });

  it("all customAgents have a copilotclawTools array", () => {
    const config = getAgentPromptConfig();
    for (const agent of config.customAgents) {
      expect(Array.isArray(agent.copilotclawTools)).toBe(true);
    }
  });
});
