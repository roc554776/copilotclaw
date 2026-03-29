/**
 * Tests for the daemon's onSessionEvent handler logic.
 *
 * The handler lives inline in daemon.ts main(), so these tests replicate
 * its behavior using the real Store and a mock AgentManager to verify:
 *  - subagent.completed inserts a system message and calls notifyAgent
 *  - nested subagent (parentToolCallId present) does NOT insert system message
 *  - subagent.failed inserts a system message with error info
 */
import { describe, expect, it, vi } from "vitest";
import { Store } from "../../src/store.js";

/** Replicates the daemon's onSessionEvent handler logic for subagent events. */
function handleSessionEvent(
  store: Store,
  notifyAgent: (channelId: string) => void,
  channelId: string | undefined,
  eventType: string,
  data: Record<string, unknown>,
): void {
  if (channelId !== undefined && (eventType === "subagent.completed" || eventType === "subagent.failed")) {
    if (data["parentToolCallId"] === undefined) {
      const agentName = data["agentName"] as string ?? "unknown";
      const status = eventType === "subagent.completed" ? "completed" : "failed";
      const error = typeof data["error"] === "string" ? ` (error: ${data["error"]})` : "";
      const msg = `[SUBAGENT ${status.toUpperCase()}] ${agentName} ${status}${error}`;
      store.addMessage(channelId, "system", msg);
      notifyAgent(channelId);
    }
  }
}

describe("daemon onSessionEvent — subagent completion", () => {
  it("inserts system message and calls notifyAgent on subagent.completed", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "subagent.completed", {
      agentName: "worker",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sender).toBe("system");
    expect(pending[0]!.message).toBe("[SUBAGENT COMPLETED] worker completed");
    expect(notifyAgent).toHaveBeenCalledWith(channelId);
  });

  it("inserts system message with error info on subagent.failed", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "subagent.failed", {
      agentName: "worker",
      error: "timeout exceeded",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sender).toBe("system");
    expect(pending[0]!.message).toBe("[SUBAGENT FAILED] worker failed (error: timeout exceeded)");
    expect(notifyAgent).toHaveBeenCalledWith(channelId);
  });

  it("does NOT insert system message for nested subagent (parentToolCallId present)", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "subagent.completed", {
      agentName: "nested-worker",
      parentToolCallId: "outer-tool-call-123",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(0);
    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it("does NOT insert system message when channelId is undefined", () => {
    const store = new Store();
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, undefined, "subagent.completed", {
      agentName: "worker",
    });

    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it("does NOT react to non-subagent event types", () => {
    const store = new Store();
    const channelId = store.createChannel().id;
    const notifyAgent = vi.fn();

    handleSessionEvent(store, notifyAgent, channelId, "tool.invoked", {
      agentName: "worker",
    });

    const pending = store.drainPending(channelId);
    expect(pending).toHaveLength(0);
    expect(notifyAgent).not.toHaveBeenCalled();
  });
});
