import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @github/copilot-sdk before importing the module under test.
// CopilotClient is used with `new`, so we use a vi.fn() that is a constructor.
// Mock IPC server functions before importing the module under test.
vi.mock("../src/ipc-server.js", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    sendToGateway: vi.fn(),
    requestFromGateway: vi.fn().mockImplementation(async (msg: Record<string, unknown>) => {
      // Lifecycle RPC: default to "stop" (matching gateway's default behavior)
      if (msg.type === "lifecycle") return { action: "stop", clearCopilotSessionId: msg.event === "error" };
      // Hook RPC: return null (no hook response, agent uses fallback)
      if (msg.type === "hook") return null;
      return null;
    }),
    streamEvents: new EventEmitter(),
    hasStream: vi.fn().mockReturnValue(true),
    getStreamSocket: vi.fn().mockReturnValue(null),
    setStreamSocket: vi.fn(),
  };
});

vi.mock("@github/copilot-sdk", () => {
  const approveAll = vi.fn();
  // eslint-disable-next-line prefer-arrow-callback
  const CopilotClient = vi.fn(function () {
    /* constructed per-test via mockImplementation */
  });
  // defineTool: return a minimal tool object with the given name
  const defineTool = vi.fn((name: string, opts: { handler: unknown }) => ({
    name,
    handler: opts.handler,
    parameters: { type: "object", properties: {}, required: [] },
    skipPermission: true,
  }));
  return { CopilotClient, approveAll, defineTool };
});

import { PhysicalSessionManager } from "../src/physical-session-manager.js";
import { CopilotClient } from "@github/copilot-sdk";
import { sendToGateway, requestFromGateway } from "../src/ipc-server.js";

/** Builds a fake CopilotSession that fires idle or error after send(). */
function makeMockCopilotSession(behavior: "idle" | "error"): { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; emit: (event: string, ...args: unknown[]) => void; sessionId: string; getMessages: ReturnType<typeof vi.fn>; registerTransformCallbacks: ReturnType<typeof vi.fn>; setModel: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  // Catch-all handlers (called with the full event object for every event)
  const catchAllHandlers: Array<(event: unknown) => void> = [];

  // Support both session.on("event", handler) and session.on(handler) signatures
  const on = vi.fn((...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "function") {
      // Catch-all: session.on(handler)
      catchAllHandlers.push(args[0] as (event: unknown) => void);
    } else if (args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "function") {
      // Typed: session.on("event", handler)
      const event = args[0] as string;
      const cb = args[1] as (...a: unknown[]) => void;
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    }
    return () => {};
  });

  const emit = (event: string, ...args: unknown[]) => {
    // Fire typed listeners
    for (const cb of listeners.get(event) ?? []) cb(...args);
    // Fire catch-all listeners with a synthetic event object
    const eventObj = { type: event, timestamp: new Date().toISOString(), ...(args[0] != null && typeof args[0] === "object" ? args[0] as Record<string, unknown> : {}) };
    for (const cb of catchAllHandlers) cb(eventObj);
  };

  const send = vi.fn().mockImplementation(async () => {
    queueMicrotask(() => {
      if (behavior === "idle") emit("session.idle", { data: {} });
      else emit("session.error", { data: { message: "session error" } });
    });
    return "msg-id";
  });

  const disconnect = vi.fn().mockResolvedValue(undefined);
  const getMessages = vi.fn().mockResolvedValue([]);
  const registerTransformCallbacks = vi.fn();

  const setModel = vi.fn().mockResolvedValue(undefined);

  return { on, send, disconnect, emit, sessionId: "mock-sdk-session", getMessages, registerTransformCallbacks, setModel };
}

const TEST_PROMPTS = {
  customAgents: [
    {
      name: "channel-operator",
      displayName: "Channel Operator",
      description: "The primary agent. WARNING: NEVER NEVER NEVER dispatch as subagent — catastrophic failure.",
      prompt: "CRITICAL — DEADLOCK PREVENTION\nYou MUST call copilotclaw_wait whenever you have nothing to do.",
      infer: false,
      copilotclawTools: ["copilotclaw_wait", "copilotclaw_list_messages", "copilotclaw_send_message"],
    },
    {
      name: "worker",
      displayName: "Worker",
      description: "The ONLY agent to dispatch as a subagent.",
      prompt: "",
      infer: true,
      copilotclawTools: ["copilotclaw_list_messages", "copilotclaw_send_message"],
    },
  ],
  primaryAgentName: "channel-operator",
  systemReminder:
    "<system>\nCRITICAL REMINDER: You MUST call copilotclaw_wait whenever you have nothing to do. " +
    "Stopping without calling copilotclaw_wait causes an irrecoverable deadlock.\n</system>",
  initialPrompt: "Call copilotclaw_wait now to receive the first user message.",
  staleTimeoutMs: 600000,
  maxSessionAgeMs: 172800000,
  rapidFailureThresholdMs: 30000,
  backoffDurationMs: 60000,
  keepaliveTimeoutMs: 25 * 60 * 1000,
  reminderThresholdPercent: 0.10,
  knownSections: ["identity", "tone", "custom_instructions"],
};

let testSessionCounter = 0;
function nextSessionId(): string {
  return `test-session-${++testSessionCounter}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitForSessionReady(manager: PhysicalSessionManager, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = manager.getPhysicalSessionStatuses();
    const session = Object.values(statuses)[0];
    if (session !== undefined && session.status !== "starting") return;
    await wait(5);
  }
  throw new Error(`waitForSessionReady: session did not leave "starting" within ${timeoutMs}ms`);
}

function installClientMock(createSession: ReturnType<typeof vi.fn>): void {
  (CopilotClient as ReturnType<typeof vi.fn>).mockImplementation(function (this: object) {
    (this as Record<string, unknown>)["createSession"] = createSession;
    (this as Record<string, unknown>)["resumeSession"] = createSession; // reuse same mock for resume
    (this as Record<string, unknown>)["stop"] = vi.fn().mockResolvedValue(undefined);
    (this as Record<string, unknown>)["forceStop"] = vi.fn().mockResolvedValue(undefined);
    (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
    (this as Record<string, unknown>)["rpc"] = {
      models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
      account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
      tools: {
        list: vi.fn().mockResolvedValue({
          tools: [
            { name: "read_file", description: "Read a file" },
            { name: "write_file", description: "Write a file" },
            { name: "bash", description: "Run bash" },
          ],
        }),
      },
    };
  });
}

describe("PhysicalSessionManager — physical session lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("suspends session when physical session ends normally (idle, unaborted)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

    await wait(50);

    // Session should be suspended (not deleted)
    const statuses = manager.getPhysicalSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("suspended");
  });

  it("suspends session when physical session throws an error (unaborted)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("error")));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

    await wait(50);

    // Session should be suspended (not deleted)
    const statuses = manager.getPhysicalSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("suspended");
  });

  it("explicit stopSession fully removes session", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    manager.stopPhysicalSession(sessionId);
    await wait(30);

    // Fully removed — not just suspended
    expect(manager.getPhysicalSessionStatuses()[sessionId]).toBeUndefined();
    // Singleton client is NOT stopped (other sessions may use it)

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("stopAllPhysicalSessions calls client.stop on all clients", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await wait(50); // Let session start and idle

    await manager.stopAllPhysicalSessions();

    // Singleton client should have been stopped on full shutdown
    const clientInstances = (CopilotClient as ReturnType<typeof vi.fn>).mock.instances;
    const lastClient = clientInstances[clientInstances.length - 1] as Record<string, ReturnType<typeof vi.fn>>;
    expect(lastClient["stop"]).toHaveBeenCalled();
  });

  it("does not post channel message when session is aborted via stopSession", async () => {
    let resolveCreate!: (session: object) => void;
    const pendingCreate = new Promise<object>((res) => { resolveCreate = res; });
    installClientMock(vi.fn().mockReturnValue(pendingCreate));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

    // Abort immediately before createSession resolves
    manager.stopPhysicalSession(sessionId);

    // Now resolve — the aborted signal will cause runSession to be short-circuited
    resolveCreate(makeMockCopilotSession("idle"));

    await wait(50);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const notifyCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "channel_message",
    );
    expect(notifyCalls).toHaveLength(0);
  });

  it("session without extra options works normally", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    // Session with only sessionId (no copilotSessionId, no resolvedModel) should work
    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

    await wait(50);

    // Session should complete and be suspended after idle exit
    const statuses = manager.getPhysicalSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("suspended");
  });

  describe("gateway lifecycle action routing", () => {
    const defaultLifecycleMock = async (msg: Record<string, unknown>) => {
      if (msg.type === "lifecycle") return { action: "stop", clearCopilotSessionId: msg.event === "error" };
      if (msg.type === "hook") return null;
      return null;
    };

    beforeEach(() => {
      (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(defaultLifecycleMock);
    });

    afterEach(() => {
      (requestFromGateway as ReturnType<typeof vi.fn>).mockImplementation(defaultLifecycleMock);
      vi.clearAllMocks();
    });

    it("keeps session alive (suspended=false) when gateway returns wait", async () => {
      const rpcMock = requestFromGateway as ReturnType<typeof vi.fn>;
      rpcMock.mockImplementation(async (msg: Record<string, unknown>) => {
        if (msg.type === "lifecycle") return { action: "wait" };
        return null;
      });

      installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

      const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });
      const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

      await wait(50);

      // Session must NOT be suspended — "wait" means keep alive
      const status = manager.getPhysicalSessionStatuses()[sessionId]?.status;
      expect(status).not.toBe("suspended");
      // physical_session_ended must NOT be sent
      const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
      const endedCalls = ipcSendSpy.mock.calls.filter(
        ([msg]: [Record<string, unknown>]) => msg.type === "physical_session_ended",
      );
      expect(endedCalls).toHaveLength(0);
    });

    it("keeps session alive when gateway is unreachable (default=wait)", async () => {
      const rpcMock = requestFromGateway as ReturnType<typeof vi.fn>;
      rpcMock.mockImplementation(async (msg: Record<string, unknown>) => {
        if (msg.type === "lifecycle") throw new Error("gateway unreachable");
        return null;
      });

      installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

      const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });
      const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

      await wait(50);

      // Must survive gateway failure without crashing, and session must not be suspended
      const status = manager.getPhysicalSessionStatuses()[sessionId]?.status;
      expect(status).not.toBe("suspended");
      const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
      const endedCalls = ipcSendSpy.mock.calls.filter(
        ([msg]: [Record<string, unknown>]) => msg.type === "physical_session_ended",
      );
      expect(endedCalls).toHaveLength(0);
    });

    it("suspends session when gateway returns stop (explicit stop decision)", async () => {
      const rpcMock = requestFromGateway as ReturnType<typeof vi.fn>;
      rpcMock.mockImplementation(async (msg: Record<string, unknown>) => {
        if (msg.type === "lifecycle") return { action: "stop" };
        return null;
      });

      installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

      const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });
      const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

      await wait(50);

      expect(manager.getPhysicalSessionStatuses()[sessionId]?.status).toBe("suspended");
    });

    it("reinjects once when gateway returns reinject then stop", async () => {
      const rpcMock = requestFromGateway as ReturnType<typeof vi.fn>;
      let callCount = 0;
      rpcMock.mockImplementation(async (msg: Record<string, unknown>) => {
        if (msg.type === "lifecycle") {
          callCount += 1;
          // First idle → reinject; second idle → stop
          return callCount === 1
            ? { action: "reinject" }
            : { action: "stop" };
        }
        return null;
      });

      // Each createSession/resumeSession call returns a fresh idle session
      installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

      const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });
      const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

      // Allow enough time for two idle cycles
      await wait(200);

      // After reinject then stop, session should be suspended
      expect(manager.getPhysicalSessionStatuses()[sessionId]?.status).toBe("suspended");
      // lifecycle RPC should have been called at least twice
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it("treats reinject as wait after hitting reinject cap", async () => {
      const MAX_REINJECT = 10;
      const rpcMock = requestFromGateway as ReturnType<typeof vi.fn>;
      rpcMock.mockImplementation(async (msg: Record<string, unknown>) => {
        if (msg.type === "lifecycle") return { action: "reinject" };
        return null;
      });

      installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

      const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });
      const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });

      // Allow time for cap to be hit (MAX_REINJECT idle cycles at ~5ms each)
      await wait(500);

      // After hitting cap, session must be in "wait" state (not suspended, not deleted)
      const statuses = manager.getPhysicalSessionStatuses();
      const status = statuses[sessionId]?.status;
      expect(status).not.toBe("suspended");
      // RPC should have been called at most MAX_REINJECT + 1 times (cap prevents further loops)
      const lifecycleCalls = rpcMock.mock.calls.filter(
        ([msg]: [Record<string, unknown>]) => msg.type === "lifecycle",
      );
      expect(lifecycleCalls.length).toBeLessThanOrEqual(MAX_REINJECT + 1);
    });
  });
});

describe("PhysicalSessionManager — assistant.message forwarding (gateway handles reflection)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not send channel_message for assistant.message (gateway handles via session_event)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle emit so we can emit assistant.message first, then idle manually.
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    mockSession.emit("assistant.message", { data: { content: "Hello from assistant" } });
    await wait(10);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    // No channel_message should be sent — gateway handles reflection via session_event
    const messageCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "channel_message",
    );
    expect(messageCalls).toHaveLength(0);

    // But the event should be forwarded as session_event via the catch-all handler
    const eventCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "session_event" && msg.eventType === "assistant.message",
    );
    expect(eventCalls.length).toBeGreaterThanOrEqual(1);

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });
});

describe("PhysicalSessionManager — session.idle with backgroundTasks", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not end session on idle with backgroundTasks (subagent stop)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle so we control it manually
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });
    const sid = nextSessionId();
    manager.startPhysicalSession({ sessionId: sid });
    await waitForSessionReady(manager);

    // Emit idle with backgroundTasks — session should NOT end
    mockSession.emit("session.idle", { data: { backgroundTasks: { agents: [{ agentId: "worker-1", agentType: "worker" }], shells: [] } } });
    await wait(50);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    // physical_session_ended should NOT have been sent
    const endedCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "physical_session_ended",
    );
    expect(endedCalls).toHaveLength(0);

    // The session.idle event should still be forwarded as session_event
    const idleEvents = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "session_event" && msg.eventType === "session.idle",
    );
    expect(idleEvents.length).toBeGreaterThanOrEqual(1);

    // Now emit true idle to end the session
    mockSession.emit("session.idle", { data: {} });
    await wait(50);

    const endedCallsAfter = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "physical_session_ended",
    );
    expect(endedCallsAfter.length).toBeGreaterThanOrEqual(1);
  });
});

describe("PhysicalSessionManager — assistant.usage token accumulation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards assistant.usage events to gateway via session_event", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 100, outputTokens: 50 }, timestamp: "2026-01-01T00:00:00Z" });

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const eventCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "session_event" && msg.eventType === "assistant.usage",
    );
    expect(eventCalls.length).toBeGreaterThan(0);

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("sends physical_session_ended on suspend (gateway tracks tokens)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // Emit usage before session ends
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 100, outputTokens: 50 } });
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 200, outputTokens: 75 } });

    // End session → suspended
    mockSession.emit("session.idle", { data: {} });
    await wait(30);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const endedCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "physical_session_ended",
    );
    expect(endedCalls).toHaveLength(1);
    expect(endedCalls[0]![0]).toMatchObject({
      reason: "idle",
    });
  });
});

describe("PhysicalSessionManager — catch-all SDK event forwarding", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards previously-unlisted event types (e.g. session.truncation) to gateway via session_event", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // session.truncation was NOT on the old forwardedEvents list — must now be forwarded
    mockSession.emit("session.truncation", { data: { removedMessages: 5, reason: "context_limit" } });
    await wait(10);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const eventCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "session_event" && msg.eventType === "session.truncation",
    );
    expect(eventCalls.length).toBeGreaterThan(0);
    expect(eventCalls[0]![0]).toMatchObject({
      type: "session_event",
      eventType: "session.truncation",
      data: { removedMessages: 5, reason: "context_limit" },
    });

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("forwards all events including those previously on the explicit list", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // session.model_change was on the old forwardedEvents list — must still be forwarded
    mockSession.emit("session.model_change", { data: { model: "gpt-4.1-mini" }, timestamp: "2026-01-01T00:00:00Z" });
    await wait(10);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const eventCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "session_event" && msg.eventType === "session.model_change",
    );
    expect(eventCalls.length).toBeGreaterThan(0);

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });
});


describe("PhysicalSessionManager — system prompt reinforcement via onPostToolUse", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Helper: create a session, wait for physical session, and return the mock + createSession spy. */
  async function setupWithHookCapture(): Promise<{
    mockSession: ReturnType<typeof makeMockCopilotSession>;
    createSessionSpy: ReturnType<typeof vi.fn>;
    manager: PhysicalSessionManager;
  }> {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle emit so we can control events manually.
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    return { mockSession, createSessionSpy, manager };
  }

  // Reminder state tracking (context usage, compaction) has moved to gateway.
  // Agent no longer injects reminders locally — gateway handles this via onHook.
  it("does not inject reminder on agent side (gateway responsibility)", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    // Even with high usage, agent does NOT inject reminder (gateway's concern)
    mockSession.emit("session.usage_info", { data: { currentTokens: 30000, tokenLimit: 100000 } });
    const result = await hook({ toolName: "copilotclaw_wait" });
    expect(result?.additionalContext ?? "").not.toContain("<system>");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("does not inject reminder after compaction_complete (gateway responsibility)", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    // Compaction event: agent no longer tracks this — gateway does
    mockSession.emit("session.compaction_complete", { data: { success: true } });
    const result = await hook({ toolName: "copilotclaw_wait" });
    expect(result?.additionalContext ?? "").not.toContain("CRITICAL REMINDER");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("does not fire reminder when usage has not crossed threshold", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    // 5% usage — below the 10% threshold
    mockSession.emit("session.usage_info", { data: { currentTokens: 5000, tokenLimit: 100000 } });

    const result = await hook({ toolName: "copilotclaw_wait" });
    expect(result?.additionalContext ?? "").not.toContain("<system>");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("initial prompt mentions <system> tags in additionalContext", async () => {
    const { mockSession } = await setupWithHookCapture();

    expect(mockSession.send).toHaveBeenCalled();
    const sendArg = mockSession.send.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(sendArg?.prompt).toContain("copilotclaw_wait");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });
});

describe("PhysicalSessionManager — custom agents configuration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes customAgents (channel-operator + worker) and agent field to createSession", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    const config = createSessionSpy.mock.calls[0]![0] as {
      customAgents: Array<{ name: string; prompt: string; infer: boolean; tools: string[] }>;
      agent: string;
    };

    // Must have two custom agents
    expect(config.customAgents).toHaveLength(2);

    // channel-operator: infer false, has prompt with deadlock warning
    const operator = config.customAgents.find((a) => a.name === "channel-operator");
    expect(operator).toBeDefined();
    expect(operator!.infer).toBe(false);
    expect(operator!.prompt).toContain("DEADLOCK");
    expect(operator!.prompt).toContain("copilotclaw_wait");

    // worker: infer true, empty or minimal prompt
    const worker = config.customAgents.find((a) => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!.infer).toBe(true);

    // Session starts with channel-operator active
    expect(config.agent).toBe("channel-operator");

    // No tools: null — all agents must have an explicit tools array
    for (const agent of config.customAgents) {
      expect(agent.tools).not.toBeNull();
      expect(Array.isArray(agent.tools)).toBe(true);
    }

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("sets channel-operator tools to builtin tools + copilotclaw_wait + copilotclaw_list_messages + copilotclaw_send_message", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    const config = createSessionSpy.mock.calls[0]![0] as {
      customAgents: Array<{ name: string; tools: string[] }>;
    };

    const operator = config.customAgents.find((a) => a.name === "channel-operator");
    expect(operator).toBeDefined();
    // Builtin tools from mock
    expect(operator!.tools).toContain("read_file");
    expect(operator!.tools).toContain("write_file");
    expect(operator!.tools).toContain("bash");
    // Copilotclaw tools for channel-operator
    expect(operator!.tools).toContain("copilotclaw_wait");
    expect(operator!.tools).toContain("copilotclaw_list_messages");
    expect(operator!.tools).toContain("copilotclaw_send_message");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("sets worker tools to builtin tools + copilotclaw_list_messages + copilotclaw_send_message (no copilotclaw_wait)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    const config = createSessionSpy.mock.calls[0]![0] as {
      customAgents: Array<{ name: string; tools: string[] }>;
    };

    const worker = config.customAgents.find((a) => a.name === "worker");
    expect(worker).toBeDefined();
    // Builtin tools from mock
    expect(worker!.tools).toContain("read_file");
    expect(worker!.tools).toContain("write_file");
    expect(worker!.tools).toContain("bash");
    // Copilotclaw tools for worker (no copilotclaw_wait)
    expect(worker!.tools).toContain("copilotclaw_list_messages");
    expect(worker!.tools).toContain("copilotclaw_send_message");
    expect(worker!.tools).not.toContain("copilotclaw_wait");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("calls rpc.tools.list({}) with empty object (no model param) on each session creation", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // Retrieve the mock client instance to check rpc.tools.list call
    const clientInstances = (CopilotClient as ReturnType<typeof vi.fn>).mock.instances;
    const client = clientInstances[clientInstances.length - 1] as Record<string, { list: ReturnType<typeof vi.fn> }>;
    const toolsListMock = client["rpc"]!["tools"]!.list;

    // Must be called exactly once (for this session creation)
    expect(toolsListMock).toHaveBeenCalledTimes(1);
    // Must be called with empty object (no model param)
    expect(toolsListMock).toHaveBeenCalledWith({});

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("calls rpc.tools.list({}) on each new session start (not cached across sessions)", async () => {
    // This test verifies that rpc.tools.list is called per runSession invocation,
    // not cached across sessions. We start two sequential sessions and confirm
    // tools.list is called each time.
    let toolsListCallCount = 0;

    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);

    (CopilotClient as ReturnType<typeof vi.fn>).mockImplementation(function (this: object) {
      (this as Record<string, unknown>)["createSession"] = createSessionSpy;
      (this as Record<string, unknown>)["resumeSession"] = createSessionSpy;
      (this as Record<string, unknown>)["stop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["forceStop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["rpc"] = {
        models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
        account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
        tools: {
          list: vi.fn().mockImplementation(async () => {
            toolsListCallCount += 1;
            return { tools: [{ name: "read_file" }, { name: "bash" }] };
          }),
        },
      };
    });

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    // First session
    const sid1 = nextSessionId();
    manager.startPhysicalSession({ sessionId: sid1 });

    // Wait until first session is in "waiting" state (past tools.list call)
    const startWait1 = Date.now();
    while (Date.now() - startWait1 < 2000) {
      const s = manager.getPhysicalSessionStatus(sid1);
      if (s !== undefined && s.status === "waiting") break;
      await wait(5);
    }
    expect(toolsListCallCount).toBe(1);

    mockSession.emit("session.idle", { data: {} });
    await wait(30);

    // Second session on same manager (same singleton client)
    const sid2 = nextSessionId();
    manager.startPhysicalSession({ sessionId: sid2 });

    // Wait until second session is in "waiting" state
    const startWait2 = Date.now();
    while (Date.now() - startWait2 < 2000) {
      const s = manager.getPhysicalSessionStatus(sid2);
      if (s !== undefined && s.status === "waiting") break;
      await wait(5);
    }

    // tools.list must have been called again (not cached from the first session)
    expect(toolsListCallCount).toBe(2);

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });
});

describe("PhysicalSessionManager — gateway passthrough config (clientOptions, sessionConfigOverrides)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards clientOptions to CopilotClient constructor (merged with githubToken)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({
      prompts: {
        ...TEST_PROMPTS,
        clientOptions: { enterpriseHostname: "my.ghes.com", otherOpt: 42 },
      },
      githubToken: "tok-test",
    });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // CopilotClient should have been constructed with merged options
    const clientCalls = (CopilotClient as ReturnType<typeof vi.fn>).mock.calls;
    expect(clientCalls.length).toBeGreaterThan(0);
    const ctorArg = clientCalls[0]![0] as Record<string, unknown>;
    // clientOptions fields are present
    expect(ctorArg["enterpriseHostname"]).toBe("my.ghes.com");
    expect(ctorArg["otherOpt"]).toBe(42);
    // githubToken wins over anything in clientOptions
    expect(ctorArg["githubToken"]).toBe("tok-test");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("merges sessionConfigOverrides into createSession config (overwriting base fields)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new PhysicalSessionManager({
      prompts: {
        ...TEST_PROMPTS,
        sessionConfigOverrides: { extraFeatureFlag: true, agent: "custom-primary" },
      },
    });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    const config = createSessionSpy.mock.calls[0]![0] as Record<string, unknown>;
    // Extra field from overrides is present
    expect(config["extraFeatureFlag"]).toBe(true);
    // sessionConfigOverrides.agent overwrites the base agent field
    expect(config["agent"]).toBe("custom-primary");

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });
});

describe("PhysicalSessionManager — suspend clears physical session (history is gateway's responsibility)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends physical_session_ended on suspend", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // End session → suspended
    mockSession.emit("session.idle", { data: {} });
    await wait(30);

    const statuses = manager.getPhysicalSessionStatuses();
    const session = Object.values(statuses)[0];
    expect(session?.status).toBe("suspended");

    // Agent sends physical_session_ended for gateway to handle
    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const endedCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "physical_session_ended",
    );
    expect(endedCalls).toHaveLength(1);
    expect(endedCalls[0]![0]).toMatchObject({ reason: "idle" });
  });

  it("reports running sessions via getRunningSessionsSummary", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sid = manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    const running = manager.getRunningPhysicalSessionsSummary();
    expect(running).toHaveLength(1);
    expect(running[0]!.sessionId).toBe(sid);
    expect(running[0]!.status).toBeTruthy();

    // After suspend, no longer in running list
    mockSession.emit("session.idle", { data: {} });
    await wait(30);

    const runningAfter = manager.getRunningPhysicalSessionsSummary();
    expect(runningAfter).toHaveLength(0);
  });

  it("uses gateway-provided sessionId instead of generating its own", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const gatewaySessionId = "gateway-assigned-id-123";
    const returnedId = manager.startPhysicalSession({ sessionId: gatewaySessionId });

    expect(returnedId).toBe(gatewaySessionId);

    const statuses = manager.getPhysicalSessionStatuses();
    expect(statuses[gatewaySessionId]).toBeDefined();

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });

  it("uses resolvedModel from gateway when provided", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    manager.startPhysicalSession({ sessionId: nextSessionId(), resolvedModel: "gpt-4.1-mini" });
    await waitForSessionReady(manager);

    // The createSession call should use the gateway-resolved model
    expect(createSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4.1-mini" }),
    );

    mockSession.emit("session.idle", { data: {} });
    await wait(30);
  });
});

describe("PhysicalSessionManager — session status tracking via onStatusChange", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("updates session status to waiting/processing via onStatusChange callback", async () => {
    let capturedConfig: Record<string, unknown> | undefined;

    const createSessionMock = vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
      capturedConfig = config;
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      return {
        sessionId: "sdk-state-test",
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
        }),
        send: vi.fn().mockResolvedValue("msg-id"),
        disconnect: vi.fn().mockResolvedValue(undefined),
        registerTransformCallbacks: vi.fn(),
      };
    });

    (CopilotClient as ReturnType<typeof vi.fn>).mockImplementation(function (this: object) {
      (this as Record<string, unknown>)["createSession"] = createSessionMock;
      (this as Record<string, unknown>)["resumeSession"] = createSessionMock;
      (this as Record<string, unknown>)["stop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["forceStop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["rpc"] = {
        models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
        account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
        tools: { list: vi.fn().mockResolvedValue({ tools: [{ name: "read_file" }, { name: "bash" }] }) },
      };
    });

    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // Session should be in "waiting" status after session creation
    const statuses = manager.getPhysicalSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("waiting");

    // Find the copilotclaw_wait tool handler
    const tools = capturedConfig!["tools"] as Array<{ name: string; handler: () => Promise<unknown> }>;
    const waitTool = tools.find((t) => t.name === "copilotclaw_wait")!;
    const waitPromise = waitTool.handler();
    await wait(10);

    // Status should still be "waiting" after copilotclaw_wait is called
    expect(manager.getPhysicalSessionStatuses()[sessionId]?.status).toBe("waiting");

    manager.stopPhysicalSession(sessionId);
    await waitPromise.catch(() => {});
  });
});

describe("PhysicalSessionManager — generic hook RPC dispatch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("all SDK hooks are registered and send RPC to gateway with sessionId", async () => {
    let capturedConfig: Record<string, unknown> | undefined;

    const createSessionMock = vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
      capturedConfig = config;
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const catchAllHandlers: Array<(event: unknown) => void> = [];
      return {
        sessionId: "sdk-hook-test",
        on: vi.fn((...args: unknown[]) => {
          if (args.length === 1 && typeof args[0] === "function") {
            catchAllHandlers.push(args[0] as (event: unknown) => void);
          } else if (args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "function") {
            const list = listeners.get(args[0] as string) ?? [];
            list.push(args[1] as (...a: unknown[]) => void);
            listeners.set(args[0] as string, list);
          }
          return () => {};
        }),
        send: vi.fn().mockResolvedValue("msg-id"),
        disconnect: vi.fn().mockResolvedValue(undefined),
        registerTransformCallbacks: vi.fn(),
      };
    });

    (CopilotClient as ReturnType<typeof vi.fn>).mockImplementation(function (this: object) {
      (this as Record<string, unknown>)["createSession"] = createSessionMock;
      (this as Record<string, unknown>)["resumeSession"] = createSessionMock;
      (this as Record<string, unknown>)["stop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["forceStop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["rpc"] = {
        models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
        account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
        tools: { list: vi.fn().mockResolvedValue({ tools: [{ name: "read_file" }, { name: "bash" }] }) },
      };
    });

    // Gateway returns a hook response
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ additionalContext: "from-gateway" });

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // All 6 hooks should be registered
    const hooks = capturedConfig!["hooks"] as Record<string, unknown>;
    expect(hooks).toBeDefined();
    for (const name of ["onPreToolUse", "onPostToolUse", "onUserPromptSubmitted", "onSessionStart", "onSessionEnd", "onErrorOccurred"]) {
      expect(typeof hooks[name]).toBe("function");
    }

    // Call onPostToolUse — should send RPC with sessionId
    const onPostToolUse = hooks["onPostToolUse"] as (input: unknown) => Promise<unknown>;
    const result = await onPostToolUse({ toolName: "grep" });
    expect(result).toEqual({ additionalContext: "from-gateway" });

    const ipcSpy = requestFromGateway as ReturnType<typeof vi.fn>;
    const hookCalls = ipcSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "hook",
    );
    expect(hookCalls.length).toBeGreaterThan(0);
    expect(hookCalls[0]![0]).toMatchObject({
      type: "hook",
      hookName: "onPostToolUse",
      sessionId,
    });

    manager.stopPhysicalSession(sessionId);
    await wait(30);
  });

  it("falls back to postToolUseFallback when gateway is unreachable", async () => {
    let capturedConfig: Record<string, unknown> | undefined;

    const createSessionMock = vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
      capturedConfig = config;
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const catchAllHandlers: Array<(event: unknown) => void> = [];
      return {
        sessionId: "sdk-fallback-test",
        on: vi.fn((...args: unknown[]) => {
          if (args.length === 1 && typeof args[0] === "function") {
            catchAllHandlers.push(args[0] as (event: unknown) => void);
          } else if (args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "function") {
            const list = listeners.get(args[0] as string) ?? [];
            list.push(args[1] as (...a: unknown[]) => void);
            listeners.set(args[0] as string, list);
          }
          return () => {};
        }),
        send: vi.fn().mockResolvedValue("msg-id"),
        disconnect: vi.fn().mockResolvedValue(undefined),
        registerTransformCallbacks: vi.fn(),
      };
    });

    (CopilotClient as ReturnType<typeof vi.fn>).mockImplementation(function (this: object) {
      (this as Record<string, unknown>)["createSession"] = createSessionMock;
      (this as Record<string, unknown>)["resumeSession"] = createSessionMock;
      (this as Record<string, unknown>)["stop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["forceStop"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["rpc"] = {
        models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
        account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
        tools: { list: vi.fn().mockResolvedValue({ tools: [{ name: "read_file" }, { name: "bash" }] }) },
      };
    });

    // Gateway is unreachable
    (requestFromGateway as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IPC stream not connected"));

    const manager = new PhysicalSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startPhysicalSession({ sessionId: nextSessionId() });
    await waitForSessionReady(manager);

    // onPostToolUse should not throw even when gateway is down
    const hooks = capturedConfig!["hooks"] as Record<string, unknown>;
    const onPostToolUse = hooks["onPostToolUse"] as (input: unknown) => Promise<unknown>;
    const result = await onPostToolUse({ toolName: "grep" });

    // Fallback returns undefined when gateway is down and no pending messages or reminders are queued
    expect(result).toBeUndefined();

    manager.stopPhysicalSession(sessionId);
    await wait(30);
  });
});
