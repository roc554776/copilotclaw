/**
 * E2E tests for session lifecycle via HTTP.
 *
 * Unlike api.test.ts (which uses agentManager: null), this file starts the
 * real server with a mock AgentManager + real SessionOrchestrator +
 * real SessionController so that HTTP POST /messages actually triggers
 * session lifecycle transitions end-to-end.
 *
 * Copilot SDK is never used — all physical session interactions are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentManager } from "../../src/agent-manager.js";
import { SessionController } from "../../src/session-controller.js";
import { SessionOrchestrator } from "../../src/session-orchestrator.js";
import type { ServerHandle } from "../../src/server.js";
import { startServer } from "../../src/server.js";
import { Store } from "../../src/store.js";
import { SseBroadcaster } from "../../src/sse-broadcaster.js";

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeMockAgentManager(): AgentManager {
  return {
    startPhysicalSession: vi.fn(),
    stopPhysicalSession: vi.fn(),
    notifyAgent: vi.fn(),
    disconnectPhysicalSession: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({ sessions: {} }),
    checkCompatibility: vi.fn().mockResolvedValue("compatible"),
    getQuota: vi.fn().mockResolvedValue(null),
    getModels: vi.fn().mockResolvedValue(null),
    getSessionMessages: vi.fn().mockResolvedValue(null),
    setStreamMessageHandler: vi.fn(),
    setConfigToSend: vi.fn(),
    connectStream: vi.fn(),
    onStreamConnected: vi.fn(),
    onStreamDisconnected: vi.fn(),
    spawnAgent: vi.fn(),
  } as unknown as AgentManager;
}

// ── Test rig ──────────────────────────────────────────────────────────────────

interface E2ERig {
  handle: ServerHandle;
  baseUrl: string;
  channelId: string;
  agentManager: AgentManager;
  controller: SessionController;
  orchestrator: SessionOrchestrator;
  store: Store;
}

async function makeE2ERig(): Promise<E2ERig> {
  const store = new Store(); // in-memory SQLite
  const orchestrator = new SessionOrchestrator(); // in-memory (no persistPath)
  const agentManager = makeMockAgentManager();
  const sseBroadcaster = new SseBroadcaster();

  const controller = new SessionController({
    orchestrator,
    store,
    agentManager,
    resolveModelForChannel: async () => "gpt-4.1-mock",
  });
  controller.setSseBroadcast((event) => sseBroadcaster.broadcast(event));

  const handle = await startServer({
    port: 0,
    store,
    agentManager,
    sseBroadcaster,
    sessionOrchestrator: orchestrator,
    sessionController: controller,
    channelProviders: [], // no built-in chat provider needed
  });

  const baseUrl = `http://localhost:${handle.port}`;
  const channels = (await (await fetch(`${baseUrl}/api/channels`)).json()) as Array<{ id: string }>;
  const channelId = channels[0]!.id;

  return { handle, baseUrl, channelId, agentManager, controller, orchestrator, store };
}

// ── Spy helpers ───────────────────────────────────────────────────────────────

function spies(agentManager: AgentManager) {
  const am = agentManager as unknown as {
    startPhysicalSession: ReturnType<typeof vi.fn>;
    stopPhysicalSession: ReturnType<typeof vi.fn>;
    notifyAgent: ReturnType<typeof vi.fn>;
  };
  return am;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Session lifecycle E2E — HTTP triggers startPhysicalSession", () => {
  let rig: E2ERig;

  beforeEach(async () => {
    rig = await makeE2ERig();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rig.handle.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario: POST message → session starting via HTTP
  // ──────────────────────────────────────────────────────────────────────────

  it("POST message responds 201 and triggers startPhysicalSession", async () => {
    const { baseUrl, channelId, agentManager, orchestrator } = rig;
    const am = spies(agentManager);

    const res = await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "Hello" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; channelId: string; sender: string; message: string };
    expect(body.sender).toBe("user");
    expect(body.message).toBe("Hello");

    // agentManager.startPhysicalSession must have been called
    expect(am.startPhysicalSession).toHaveBeenCalledOnce();

    // Session must be in "starting" state
    const sessionId = orchestrator.getSessionIdForChannel(channelId);
    expect(sessionId).toBeDefined();
    expect(orchestrator.getSessionStatuses()[sessionId!]?.status).toBe("starting");
  });

  it("GET /api/status reflects session in starting state after POST message", async () => {
    const { baseUrl, channelId } = rig;

    await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "kick off session" }),
    });

    const statusRes = await fetch(`${baseUrl}/api/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      agent?: { sessions?: Record<string, { status: string }> };
    };

    // Sessions are merged into agent.sessions by the server
    const sessions = status.agent?.sessions ?? {};
    const sessionStatuses = Object.values(sessions).map((s) => s.status);
    expect(sessionStatuses).toContain("starting");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario: session lifecycle full cycle via HTTP
  // ──────────────────────────────────────────────────────────────────────────

  it("full lifecycle: POST → starting → started → second message notifies agent → ended → idle", async () => {
    const { baseUrl, channelId, agentManager, controller, orchestrator, store } = rig;
    const am = spies(agentManager);

    // POST first message — triggers session start
    const res1 = await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "first" }),
    });
    expect(res1.status).toBe(201);
    expect(am.startPhysicalSession).toHaveBeenCalledOnce();

    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");

    // Simulate agent ACK: physical session started
    controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");

    // Drain the first message (simulates agent draining via copilotclaw_wait)
    store.drainPending(channelId);

    // POST second message — session is now active (waiting), so it should notifyAgent
    am.notifyAgent.mockClear();
    const res2 = await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "second" }),
    });
    expect(res2.status).toBe(201);
    // notifyAgent is called for the second message (active session path via MessageDelivered)
    expect(am.notifyAgent).toHaveBeenCalledOnce();

    // Simulate session end (idle reason)
    controller.onPhysicalSessionEnded(sessionId, "idle", 60_000);
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("idle");

    // Status endpoint must reflect idle
    const statusRes = await fetch(`${baseUrl}/api/status`);
    const status = (await statusRes.json()) as {
      agent?: { sessions?: Record<string, { status: string }> };
    };
    const sessions = status.agent?.sessions ?? {};
    const found = Object.values(sessions).find((s) => s.status === "idle");
    expect(found).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario: second POST while session is already starting goes to pending queue
  // ──────────────────────────────────────────────────────────────────────────

  it("second POST while session is starting enqueues message (pending queue grows)", async () => {
    const { baseUrl, channelId, orchestrator, store } = rig;

    // First message — starts session
    await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "first" }),
    });

    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");

    // Second message — session still starting, notifyAgent called (MessageDelivered path)
    const res2 = await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "second" }),
    });
    expect(res2.status).toBe(201);

    // Both messages are in the pending queue
    const oldest = store.peekOldestPending(channelId);
    expect(oldest).toBeDefined();
    expect(oldest!.message).toBe("first");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario: channel_status_change is broadcast when session transitions
  // ──────────────────────────────────────────────────────────────────────────

  it("channel_status_change is broadcast via SseBroadcaster when session transitions to waiting", async () => {
    const { baseUrl, channelId, controller, orchestrator, handle } = rig;

    // Spy on the SseBroadcaster to capture broadcasts
    const broadcastSpy = vi.spyOn(handle.sseBroadcaster, "broadcast");

    // POST a message to start the session
    await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "trigger" }),
    });

    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;

    // Simulate physical session started → triggers channel_status_change broadcast
    controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");

    // At least one channel_status_change event should have been broadcast
    const statusChangeCalls = broadcastSpy.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "channel_status_change",
    );
    expect(statusChangeCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario: startPhysicalSession not called for agent-sender messages
  // ──────────────────────────────────────────────────────────────────────────

  it("POST agent message does NOT trigger startPhysicalSession", async () => {
    const { baseUrl, channelId, agentManager } = rig;
    const am = spies(agentManager);

    const res = await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "agent", message: "agent reply" }),
    });

    expect(res.status).toBe(201);
    expect(am.startPhysicalSession).not.toHaveBeenCalled();
  });
});
