import { afterEach, describe, expect, it, vi } from "vitest";

// Mock @github/copilot-sdk before importing the module under test.
// CopilotClient is used with `new`, so we use a vi.fn() that is a constructor.
// Mock IPC server functions before importing the module under test.
vi.mock("../src/ipc-server.js", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    sendToGateway: vi.fn(),
    requestFromGateway: vi.fn().mockResolvedValue(null),
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

import { AgentSessionManager } from "../src/agent-session-manager.js";
import { CopilotClient } from "@github/copilot-sdk";
import { sendToGateway, requestFromGateway } from "../src/ipc-server.js";

/** Builds a fake CopilotSession that fires idle or error after send(). */
function makeMockCopilotSession(behavior: "idle" | "error"): { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; emit: (event: string, ...args: unknown[]) => void; sessionId: string; getMessages: ReturnType<typeof vi.fn>; registerTransformCallbacks: ReturnType<typeof vi.fn> } {
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
      if (behavior === "idle") emit("session.idle");
      else emit("session.error", { data: { message: "session error" } });
    });
    return "msg-id";
  });

  const disconnect = vi.fn().mockResolvedValue(undefined);
  const getMessages = vi.fn().mockResolvedValue([]);
  const registerTransformCallbacks = vi.fn();

  return { on, send, disconnect, emit, sessionId: "mock-sdk-session", getMessages, registerTransformCallbacks };
}

const TEST_PROMPTS = {
  customAgents: [
    {
      name: "channel-operator",
      displayName: "Channel Operator",
      description: "The primary agent. WARNING: NEVER NEVER NEVER dispatch as subagent — catastrophic failure.",
      prompt: "CRITICAL — DEADLOCK PREVENTION\nYou MUST call copilotclaw_wait whenever you have nothing to do.",
      infer: false,
    },
    {
      name: "worker",
      displayName: "Worker",
      description: "The ONLY agent to dispatch as a subagent.",
      prompt: "",
      infer: true,
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

async function waitForSessionReady(manager: AgentSessionManager, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = manager.getSessionStatuses();
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
    (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
    (this as Record<string, unknown>)["rpc"] = {
      models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
      account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
    };
  });
}

describe("AgentSessionManager — physical session lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("suspends session when physical session ends normally (idle, unaborted)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-idle" });

    await wait(50);

    // Session should be suspended (not deleted)
    const statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("suspended");
  });

  it("suspends session when physical session throws an error (unaborted)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("error")));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-error" });

    await wait(50);

    // Session should be suspended (not deleted)
    const statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("suspended");
  });

  it("explicit stopSession fully removes session", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-explicit-stop" });
    await waitForSessionReady(manager);

    manager.stopSession(sessionId);
    await wait(30);

    // Fully removed — not just suspended
    expect(manager.getSessionStatuses()[sessionId]).toBeUndefined();

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("does not post channel message when session is aborted via stopSession", async () => {
    let resolveCreate!: (session: object) => void;
    const pendingCreate = new Promise<object>((res) => { resolveCreate = res; });
    installClientMock(vi.fn().mockReturnValue(pendingCreate));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-abort" });

    // Abort immediately before createSession resolves
    manager.stopSession(sessionId);

    // Now resolve — the aborted signal will cause runSession to be short-circuited
    resolveCreate(makeMockCopilotSession("idle"));

    await wait(50);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const notifyCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "channel_message",
    );
    expect(notifyCalls).toHaveLength(0);
  });

  it("does not crash when channel-less session errors immediately", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    // No boundChannelId — runSession throws "channel-less sessions not yet supported"
    manager.startSession({ sessionId: nextSessionId() });

    await wait(50);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const notifyCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "channel_message",
    );
    expect(notifyCalls).toHaveLength(0);
  });
});

describe("AgentSessionManager — assistant.message to channel timeline", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("posts assistant.message content to the channel timeline", async () => {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle emit so we can emit assistant.message first, then idle manually.
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-assistant-msg" });
    await waitForSessionReady(manager);

    mockSession.emit("assistant.message", { data: { content: "Hello from assistant" } });
    await wait(10);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const messageCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "channel_message",
    );
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]![0].sender).toBe("agent");
    expect(messageCalls[0]![0].message).toBe("Hello from assistant");

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("does not post empty assistant.message content", async () => {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle emit so we can emit assistant.message first, then idle manually.
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-empty-msg" });
    await waitForSessionReady(manager);

    mockSession.emit("assistant.message", { data: { content: "" } });
    await wait(10);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const messageCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "channel_message",
    );
    expect(messageCalls).toHaveLength(0);

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — assistant.usage token accumulation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards assistant.usage events to gateway via session_event", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-usage" });
    await waitForSessionReady(manager);

    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 100, outputTokens: 50 }, timestamp: "2026-01-01T00:00:00Z" });

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const eventCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "session_event" && msg.eventType === "assistant.usage",
    );
    expect(eventCalls.length).toBeGreaterThan(0);

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("sends physical_session_ended on suspend (gateway tracks tokens)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-cumul" });
    await waitForSessionReady(manager);

    // Emit usage before session ends
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 100, outputTokens: 50 } });
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 200, outputTokens: 75 } });

    // End session → suspended
    mockSession.emit("session.idle");
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

describe("AgentSessionManager — catch-all SDK event forwarding", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards previously-unlisted event types (e.g. session.truncation) to gateway via session_event", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-catchall" });
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
      channelId: "ch-catchall",
      data: { removedMessages: 5, reason: "context_limit" },
    });

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("forwards all events including those previously on the explicit list", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-catchall-known" });
    await waitForSessionReady(manager);

    // session.model_change was on the old forwardedEvents list — must still be forwarded
    mockSession.emit("session.model_change", { data: { model: "gpt-4.1-mini" }, timestamp: "2026-01-01T00:00:00Z" });
    await wait(10);

    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const eventCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "session_event" && msg.eventType === "session.model_change",
    );
    expect(eventCalls.length).toBeGreaterThan(0);

    mockSession.emit("session.idle");
    await wait(30);
  });
});


describe("AgentSessionManager — system prompt reinforcement via onPostToolUse", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Helper: create a session, wait for physical session, and return the mock + createSession spy. */
  async function setupWithHookCapture(): Promise<{
    mockSession: ReturnType<typeof makeMockCopilotSession>;
    createSessionSpy: ReturnType<typeof vi.fn>;
    manager: AgentSessionManager;
  }> {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle emit so we can control events manually.
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-reminder" });
    await waitForSessionReady(manager);

    return { mockSession, createSessionSpy, manager };
  }

  it("sets needsReminder when context usage crosses 10% threshold", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    // 30% usage (≥ lastReminderPercent 0% + 10% threshold)
    mockSession.emit("session.usage_info", { data: { currentTokens: 30000, tokenLimit: 100000 } });

    // Any parent tool triggers reminder (hook only fires for parent agent tools)
    const result = await hook({ toolName: "copilotclaw_wait" });
    expect(result?.additionalContext).toContain("<system>");
    expect(result?.additionalContext).toContain("copilotclaw_wait");

    // Second call at same usage should NOT contain reminder (already fired)
    const result2 = await hook({ toolName: "copilotclaw_wait" });
    expect(result2?.additionalContext ?? "").not.toContain("<system>");

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("fires for any parent tool when reminder is needed (no toolName gate)", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    mockSession.emit("session.usage_info", { data: { currentTokens: 50000, tokenLimit: 100000 } });

    // Hook fires for any tool — onPostToolUse only fires for parent agent tools
    const result = await hook({ toolName: "copilotclaw_send_message" });
    expect(result?.additionalContext).toContain("<system>");

    // Second call should NOT contain reminder (already fired at this usage level)
    const result2 = await hook({ toolName: "Read" });
    expect(result2).toBeUndefined();

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("fires reminder immediately after compaction_complete", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    mockSession.emit("session.compaction_complete", { data: { success: true } });

    const result = await hook({ toolName: "copilotclaw_wait" });
    expect(result?.additionalContext).toContain("<system>");
    expect(result?.additionalContext).toContain("CRITICAL REMINDER");

    mockSession.emit("session.idle");
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

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("initial prompt mentions <system> tags in additionalContext", async () => {
    const { mockSession } = await setupWithHookCapture();

    expect(mockSession.send).toHaveBeenCalled();
    const sendArg = mockSession.send.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(sendArg?.prompt).toContain("copilotclaw_wait");

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — custom agents configuration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes customAgents (channel-operator + worker) and agent field to createSession", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);


    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-agents" });
    await waitForSessionReady(manager);

    const config = createSessionSpy.mock.calls[0]![0] as {
      customAgents: Array<{ name: string; prompt: string; infer: boolean }>;
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

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — gateway passthrough config (clientOptions, sessionConfigOverrides)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards clientOptions to CopilotClient constructor (merged with githubToken)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({
      prompts: {
        ...TEST_PROMPTS,
        clientOptions: { enterpriseHostname: "my.ghes.com", otherOpt: 42 },
      },
      githubToken: "tok-test",
    });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-client-opts" });
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

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("merges sessionConfigOverrides into createSession config (overwriting base fields)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new AgentSessionManager({
      prompts: {
        ...TEST_PROMPTS,
        sessionConfigOverrides: { extraFeatureFlag: true, agent: "custom-primary" },
      },
    });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-session-overrides" });
    await waitForSessionReady(manager);

    const config = createSessionSpy.mock.calls[0]![0] as Record<string, unknown>;
    // Extra field from overrides is present
    expect(config["extraFeatureFlag"]).toBe(true);
    // sessionConfigOverrides.agent overwrites the base agent field
    expect(config["agent"]).toBe("custom-primary");

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — suspend clears physical session (history is gateway's responsibility)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends physical_session_ended on suspend", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-hist" });
    await waitForSessionReady(manager);

    // End session → suspended
    mockSession.emit("session.idle");
    await wait(30);

    const statuses = manager.getSessionStatuses();
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

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sid = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-running" });
    await waitForSessionReady(manager);

    const running = manager.getRunningSessionsSummary();
    expect(running).toHaveLength(1);
    expect(running[0]!.sessionId).toBe(sid);
    expect(running[0]!.channelId).toBe("ch-running");

    // After suspend, no longer in running list
    mockSession.emit("session.idle");
    await wait(30);

    const runningAfter = manager.getRunningSessionsSummary();
    expect(runningAfter).toHaveLength(0);
  });

  it("uses gateway-provided sessionId instead of generating its own", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const gatewaySessionId = "gateway-assigned-id-123";
    const returnedId = manager.startSession({ sessionId: gatewaySessionId, boundChannelId: "ch-id" });

    expect(returnedId).toBe(gatewaySessionId);

    const statuses = manager.getSessionStatuses();
    expect(statuses[gatewaySessionId]).toBeDefined();

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("uses resolvedModel from gateway when provided", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-model", resolvedModel: "gpt-4.1-mini" });
    await waitForSessionReady(manager);

    // The createSession call should use the gateway-resolved model
    expect(createSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4.1-mini" }),
    );

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — session status tracking via onStatusChange", () => {
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
      (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["rpc"] = {
        models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
        account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
      };
    });

    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-state" });
    await waitForSessionReady(manager);

    // Session should be in "waiting" status after session creation
    const statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("waiting");

    // Find the copilotclaw_wait tool handler
    const tools = capturedConfig!["tools"] as Array<{ name: string; handler: () => Promise<unknown> }>;
    const waitTool = tools.find((t) => t.name === "copilotclaw_wait")!;
    const waitPromise = waitTool.handler();
    await wait(10);

    // Status should still be "waiting" after copilotclaw_wait is called
    expect(manager.getSessionStatuses()[sessionId]?.status).toBe("waiting");

    manager.stopSession(sessionId);
    await waitPromise.catch(() => {});
  });
});

describe("AgentSessionManager — generic hook RPC dispatch", () => {
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
      (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["rpc"] = {
        models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
        account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
      };
    });

    // Gateway returns a hook response
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ additionalContext: "from-gateway" });

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-hook" });
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
      channelId: "ch-hook",
    });

    manager.stopSession(sessionId);
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
      (this as Record<string, unknown>)["start"] = vi.fn().mockResolvedValue(undefined);
      (this as Record<string, unknown>)["rpc"] = {
        models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
        account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
      };
    });

    // Gateway is unreachable
    (requestFromGateway as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IPC stream not connected"));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-fallback" });
    await waitForSessionReady(manager);

    // onPostToolUse should not throw even when gateway is down
    const hooks = capturedConfig!["hooks"] as Record<string, unknown>;
    const onPostToolUse = hooks["onPostToolUse"] as (input: unknown) => Promise<unknown>;
    const result = await onPostToolUse({ toolName: "grep" });

    // Fallback returns undefined when gateway is down and no pending messages or reminders are queued
    expect(result).toBeUndefined();

    manager.stopSession(sessionId);
    await wait(30);
  });
});
