/**
 * Unit tests for the IPC subsystem reducers (pure functions):
 * - reduceSendQueue
 * - reduceRpc
 * - reduceConfigPush
 */

import { describe, expect, it } from "vitest";
import { reduceSendQueue, reduceRpc, reduceConfigPush } from "../src/ipc-reducers.js";
import type {
  SendQueueState,
  RpcState,
  ConfigPushState,
  QueuedMessage,
} from "../src/ipc-events.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQueuedMessage(id: string, extra: Record<string, unknown> = {}): QueuedMessage {
  return { _queueId: id, type: "test_event", ...extra };
}

function makeSendQueueState(overrides: Partial<SendQueueState> = {}): SendQueueState {
  return {
    messages: [],
    flushInProgress: false,
    pendingAckIds: [],
    ...overrides,
  };
}

function makeRpcState(overrides: Partial<RpcState> = {}): RpcState {
  return {
    pendingRequests: [],
    connectionStatus: "connected",
    ...overrides,
  };
}

function makeConfigPushState(overrides: Partial<ConfigPushState> = {}): ConfigPushState {
  return {
    lastPushedAt: undefined,
    config: undefined,
    agentConnected: false,
    ...overrides,
  };
}

// ── reduceSendQueue ───────────────────────────────────────────────────────────

describe("reduceSendQueue — MessageEnqueued", () => {
  it("appends message to queue and emits PersistQueue", () => {
    const state = makeSendQueueState();
    const msg = makeQueuedMessage("q-1");
    const { newState, commands } = reduceSendQueue(state, { type: "MessageEnqueued", message: msg });
    expect(newState.messages).toHaveLength(1);
    expect(newState.messages[0]._queueId).toBe("q-1");
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("PersistQueue");
  });
});

describe("reduceSendQueue — FlushStarted", () => {
  it("moves matching messages to pendingAckIds and emits FlushBatch", () => {
    const m1 = makeQueuedMessage("q-1");
    const m2 = makeQueuedMessage("q-2");
    const state = makeSendQueueState({ messages: [m1, m2] });
    const { newState, commands } = reduceSendQueue(state, {
      type: "FlushStarted",
      batchIds: ["q-1"],
    });
    expect(newState.messages).toHaveLength(1); // q-2 remains
    expect(newState.messages[0]._queueId).toBe("q-2");
    expect(newState.flushInProgress).toBe(true);
    expect(newState.pendingAckIds).toContain("q-1");
    expect(commands[0].type).toBe("FlushBatch");
  });

  it("no-op when flush already in progress", () => {
    const state = makeSendQueueState({ flushInProgress: true, messages: [makeQueuedMessage("q-1")] });
    const { newState, commands } = reduceSendQueue(state, { type: "FlushStarted", batchIds: ["q-1"] });
    expect(newState.flushInProgress).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("no-op when no matching messages in batch", () => {
    const state = makeSendQueueState({ messages: [makeQueuedMessage("q-1")] });
    const { newState, commands } = reduceSendQueue(state, { type: "FlushStarted", batchIds: ["q-99"] });
    expect(commands).toHaveLength(0);
    expect(newState.flushInProgress).toBe(false);
  });
});

describe("reduceSendQueue — MessageAcknowledged", () => {
  it("removes id from pendingAckIds; emits ClearDisk when all ACKed", () => {
    const state = makeSendQueueState({ pendingAckIds: ["q-1", "q-2"] });
    const result1 = reduceSendQueue(state, { type: "MessageAcknowledged", messageId: "q-1" });
    expect(result1.newState.pendingAckIds).toEqual(["q-2"]);
    expect(result1.commands).toHaveLength(0); // still waiting for q-2

    const result2 = reduceSendQueue(result1.newState, { type: "MessageAcknowledged", messageId: "q-2" });
    expect(result2.newState.pendingAckIds).toHaveLength(0);
    expect(result2.commands[0].type).toBe("ClearDisk");
  });
});

describe("reduceSendQueue — FlushCompleted", () => {
  it("resets flushInProgress to false", () => {
    const state = makeSendQueueState({ flushInProgress: true });
    const { newState } = reduceSendQueue(state, { type: "FlushCompleted" });
    expect(newState.flushInProgress).toBe(false);
  });
});

describe("reduceSendQueue — ConnectionLost", () => {
  it("resets flushInProgress but keeps pendingAckIds for re-delivery", () => {
    const state = makeSendQueueState({ flushInProgress: true, pendingAckIds: ["q-1"] });
    const { newState, commands } = reduceSendQueue(state, { type: "ConnectionLost" });
    expect(newState.flushInProgress).toBe(false);
    expect(newState.pendingAckIds).toEqual(["q-1"]);
    expect(commands).toHaveLength(0);
  });
});

describe("reduceSendQueue — ConnectionRestored", () => {
  it("emits FlushBatch for queued messages", () => {
    const state = makeSendQueueState({ messages: [makeQueuedMessage("q-1")] });
    const { commands } = reduceSendQueue(state, { type: "ConnectionRestored" });
    expect(commands[0].type).toBe("FlushBatch");
  });

  it("no-op when queue is empty and no pending ACKs", () => {
    const state = makeSendQueueState();
    const { commands } = reduceSendQueue(state, { type: "ConnectionRestored" });
    expect(commands).toHaveLength(0);
  });
});

// ── reduceRpc ─────────────────────────────────────────────────────────────────

describe("reduceRpc — RequestSent", () => {
  it("adds request to pendingRequests", () => {
    const state = makeRpcState();
    const { newState } = reduceRpc(state, {
      type: "RequestSent",
      requestId: "req-1",
      method: "ping",
      payload: {},
      sentAt: "2026-01-01T00:00:00.000Z",
      timeoutMs: 5000,
    });
    expect(newState.pendingRequests).toHaveLength(1);
    expect(newState.pendingRequests[0].requestId).toBe("req-1");
  });
});

describe("reduceRpc — ResponseReceived", () => {
  it("removes request from pendingRequests", () => {
    const state = makeRpcState({
      pendingRequests: [{
        requestId: "req-1",
        method: "ping",
        payload: {},
        sentAt: "2026-01-01T00:00:00.000Z",
        timeoutMs: 5000,
      }],
    });
    const { newState, commands } = reduceRpc(state, { type: "ResponseReceived", requestId: "req-1", data: {} });
    expect(newState.pendingRequests).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  it("no-op for unknown requestId", () => {
    const state = makeRpcState();
    const { newState, commands } = reduceRpc(state, { type: "ResponseReceived", requestId: "unknown", data: {} });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});

describe("reduceRpc — RequestTimedOut", () => {
  it("removes request and emits RejectRequest", () => {
    const state = makeRpcState({
      pendingRequests: [{
        requestId: "req-1",
        method: "ping",
        payload: {},
        sentAt: "2026-01-01T00:00:00.000Z",
        timeoutMs: 5000,
      }],
    });
    const { newState, commands } = reduceRpc(state, { type: "RequestTimedOut", requestId: "req-1" });
    expect(newState.pendingRequests).toHaveLength(0);
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("RejectRequest");
    if (commands[0].type === "RejectRequest") {
      expect(commands[0].requestId).toBe("req-1");
    }
  });
});

describe("reduceRpc — ConnectionLost", () => {
  it("rejects all pending requests and sets status to disconnected", () => {
    const state = makeRpcState({
      pendingRequests: [
        { requestId: "req-1", method: "a", payload: {}, sentAt: "t", timeoutMs: 1000 },
        { requestId: "req-2", method: "b", payload: {}, sentAt: "t", timeoutMs: 1000 },
      ],
    });
    const { newState, commands } = reduceRpc(state, { type: "ConnectionLost" });
    expect(newState.pendingRequests).toHaveLength(0);
    expect(newState.connectionStatus).toBe("disconnected");
    expect(commands).toHaveLength(2);
    expect(commands.every((c) => c.type === "RejectRequest")).toBe(true);
  });
});

describe("reduceRpc — ConnectionRestored", () => {
  it("sets status to connected and replays pending requests if any", () => {
    const state = makeRpcState({
      connectionStatus: "disconnected",
      pendingRequests: [{
        requestId: "req-1",
        method: "ping",
        payload: {},
        sentAt: "t",
        timeoutMs: 1000,
      }],
    });
    const { newState, commands } = reduceRpc(state, { type: "ConnectionRestored" });
    expect(newState.connectionStatus).toBe("connected");
    expect(commands[0].type).toBe("ReplayPendingRequests");
  });

  it("no commands when no pending requests on reconnect", () => {
    const state = makeRpcState({ connectionStatus: "disconnected" });
    const { commands } = reduceRpc(state, { type: "ConnectionRestored" });
    expect(commands).toHaveLength(0);
  });
});

// ── reduceConfigPush ──────────────────────────────────────────────────────────

describe("reduceConfigPush — ConfigUpdated", () => {
  it("stores config; no push when agent not connected", () => {
    const state = makeConfigPushState({ agentConnected: false });
    const { newState, commands } = reduceConfigPush(state, {
      type: "ConfigUpdated",
      config: { model: "gpt-4.1" },
    });
    expect(newState.config).toEqual({ model: "gpt-4.1" });
    expect(commands).toHaveLength(0);
  });

  it("stores config and pushes immediately when agent is connected", () => {
    const state = makeConfigPushState({ agentConnected: true });
    const { newState, commands } = reduceConfigPush(state, {
      type: "ConfigUpdated",
      config: { model: "gpt-4.1" },
    });
    expect(newState.config).toEqual({ model: "gpt-4.1" });
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("SendConfigToAgent");
  });
});

describe("reduceConfigPush — AgentConnected", () => {
  it("sets agentConnected=true and pushes config if available", () => {
    const state = makeConfigPushState({ config: { model: "gpt-4.1" }, agentConnected: false });
    const { newState, commands } = reduceConfigPush(state, { type: "AgentConnected" });
    expect(newState.agentConnected).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("SendConfigToAgent");
  });

  it("sets agentConnected=true with no push when config is absent", () => {
    const state = makeConfigPushState();
    const { newState, commands } = reduceConfigPush(state, { type: "AgentConnected" });
    expect(newState.agentConnected).toBe(true);
    expect(commands).toHaveLength(0);
  });
});

describe("reduceConfigPush — AgentDisconnected", () => {
  it("sets agentConnected=false", () => {
    const state = makeConfigPushState({ agentConnected: true });
    const { newState, commands } = reduceConfigPush(state, { type: "AgentDisconnected" });
    expect(newState.agentConnected).toBe(false);
    expect(commands).toHaveLength(0);
  });
});

describe("reduceConfigPush — PushCompleted", () => {
  it("records lastPushedAt timestamp", () => {
    const state = makeConfigPushState();
    const now = Date.now();
    const { newState } = reduceConfigPush(state, { type: "PushCompleted", pushedAt: now });
    expect(newState.lastPushedAt).toBe(now);
  });
});
