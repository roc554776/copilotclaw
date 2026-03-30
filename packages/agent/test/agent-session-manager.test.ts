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

  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
    return () => {};
  });

  const emit = (event: string, ...args: unknown[]) => {
    for (const cb of listeners.get(event) ?? []) cb(...args);
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
  channelOperator: {
    name: "channel-operator",
    displayName: "Channel Operator",
    description: "The primary agent. WARNING: NEVER NEVER NEVER dispatch as subagent — catastrophic failure.",
    prompt: "CRITICAL — DEADLOCK PREVENTION\nYou MUST call copilotclaw_wait whenever you have nothing to do.",
    infer: false,
  },
  worker: {
    name: "worker",
    displayName: "Worker",
    description: "The ONLY agent to dispatch as a subagent.",
    prompt: "",
    infer: true,
  },
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
};

let testSessionCounter = 0;
function nextSessionId(): string {
  return `test-session-${++testSessionCounter}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitForPhysicalSession(manager: AgentSessionManager, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = manager.getSessionStatuses();
    const session = Object.values(statuses)[0];
    if (session?.physicalSession !== undefined) return;
    await wait(5);
  }
  throw new Error(`waitForPhysicalSession: physicalSession did not appear within ${timeoutMs}ms`);
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
    await waitForPhysicalSession(manager);

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
    await waitForPhysicalSession(manager);

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
    await waitForPhysicalSession(manager);

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

  it("accumulates inputTokens and outputTokens from assistant.usage events", async () => {
    const mockSession = makeMockCopilotSession("idle");
    // Override send to NOT auto-emit idle — we control events manually, then emit idle to end
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));


    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-usage" });
    await waitForPhysicalSession(manager);

    // Emit assistant.usage events
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 100, outputTokens: 50 } });
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 200, outputTokens: 75 } });

    const statuses = manager.getSessionStatuses();
    const session = Object.values(statuses)[0];
    expect(session?.physicalSession?.totalInputTokens).toBe(300);
    expect(session?.physicalSession?.totalOutputTokens).toBe(125);

    // End session cleanly
    mockSession.emit("session.idle");
    await wait(30);
  });

  it("caches quotaSnapshots from assistant.usage events", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));


    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-quota" });
    await waitForPhysicalSession(manager);

    const snapshot = { premium_interactions: { usedRequests: 5, entitlementRequests: 100, remainingPercentage: 0.95 } };
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 10, quotaSnapshots: snapshot } });

    const statuses = manager.getSessionStatuses();
    const session = Object.values(statuses)[0];
    expect(session?.physicalSession?.latestQuotaSnapshots).toEqual(snapshot);

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("does not update latestQuotaSnapshots when event has no quotaSnapshots", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));


    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-noquota" });
    await waitForPhysicalSession(manager);

    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 10 } });

    const statuses = manager.getSessionStatuses();
    const session = Object.values(statuses)[0];
    expect(session?.physicalSession?.latestQuotaSnapshots).toBeUndefined();

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("sends token totals in physical_session_ended on suspend (gateway handles accumulation)", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-cumul" });
    await waitForPhysicalSession(manager);

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
      totalInputTokens: 300,
      totalOutputTokens: 125,
    });
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
    await waitForPhysicalSession(manager);

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
    await waitForPhysicalSession(manager);

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

describe("AgentSessionManager — suspend clears physical session (history is gateway's responsibility)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears physicalSession on suspend and sends physical_session_ended", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-hist" });
    await waitForPhysicalSession(manager);

    // Emit some usage
    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 100, outputTokens: 50 } });

    // End session → suspended
    mockSession.emit("session.idle");
    await wait(30);

    const statuses = manager.getSessionStatuses();
    const session = Object.values(statuses)[0];
    expect(session?.status).toBe("suspended");
    expect(session?.physicalSession).toBeUndefined();

    // Agent sends physical_session_ended for gateway to handle history/accumulation
    const ipcSendSpy = sendToGateway as ReturnType<typeof vi.fn>;
    const endedCalls = ipcSendSpy.mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg.type === "physical_session_ended",
    );
    expect(endedCalls).toHaveLength(1);
    expect(endedCalls[0]![0]).toMatchObject({
      reason: "idle",
      totalInputTokens: 100,
      totalOutputTokens: 50,
    });
  });

  it("reports running sessions via getRunningSessionsSummary", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sid = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-running" });
    await waitForPhysicalSession(manager);

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
    await waitForPhysicalSession(manager);

    // The createSession call should use the gateway-resolved model
    expect(createSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4.1-mini" }),
    );

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — currentState tracking via onStatusChange", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sets physicalSession.currentState to tool:copilotclaw_wait when copilotclaw_wait handler runs", async () => {
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

    // Return empty array so wait enters polling (keepalive path)
    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const manager = new AgentSessionManager({ prompts: TEST_PROMPTS });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-state" });
    await waitForPhysicalSession(manager);

    // Before calling wait handler, currentState should be "idle"
    let statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.physicalSession?.currentState).toBe("idle");

    // Find the copilotclaw_wait tool handler from the tools in capturedConfig
    const tools = capturedConfig!["tools"] as Array<{ name: string; handler: () => Promise<unknown> }>;
    const waitTool = tools.find((t) => t.name === "copilotclaw_wait");
    expect(waitTool).toBeDefined();

    // Call the wait handler. It will call onStatusChange("waiting") synchronously,
    // then block in pollNextInputs. We abort it quickly via the session's abort controller.
    const waitPromise = waitTool!.handler();

    // Give the handler a chance to call onStatusChange("waiting")
    await wait(10);

    // currentState should now be "tool:copilotclaw_wait"
    statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.physicalSession?.currentState).toBe("tool:copilotclaw_wait");

    // Stop the session to unblock the wait handler
    manager.stopSession(sessionId);
    await waitPromise.catch(() => {});
  });

  it("overrides idle after tool.execution_complete when wait handler re-enters", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    let mockSessionEmit: (event: string, ...args: unknown[]) => void;

    const createSessionMock = vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
      capturedConfig = config;
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

      mockSessionEmit = (event: string, ...args: unknown[]) => {
        for (const cb of listeners.get(event) ?? []) cb(...args);
      };

      return {
        sessionId: "sdk-override-test",
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
    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-override" });
    await waitForPhysicalSession(manager);

    // Simulate SDK tool.execution_complete resetting currentState to idle
    mockSessionEmit!("tool.execution_complete");
    let statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.physicalSession?.currentState).toBe("idle");

    // Now call the wait handler — onStatusChange("waiting") should override idle
    const tools = capturedConfig!["tools"] as Array<{ name: string; handler: () => Promise<unknown> }>;
    const waitTool = tools.find((t) => t.name === "copilotclaw_wait")!;
    const waitPromise = waitTool.handler();
    await wait(10);

    // currentState should be overridden back to tool:copilotclaw_wait
    statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.physicalSession?.currentState).toBe("tool:copilotclaw_wait");

    manager.stopSession(sessionId);
    await waitPromise.catch(() => {});
  });
});

describe("AgentSessionManager — postToolUse log includes session ID", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("postToolUse debug log contains session ID in format [sessionId]", async () => {
    const debugLogs: string[] = [];
    let capturedConfig: Record<string, unknown> | undefined;

    const createSessionMock = vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
      capturedConfig = config;
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      return {
        sessionId: "sdk-log-test",
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

    (requestFromGateway as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const manager = new AgentSessionManager({
      prompts: TEST_PROMPTS,
      debugLogLevel: "debug",
      log: (msg: string) => { debugLogs.push(msg); },
    });

    const sessionId = manager.startSession({ sessionId: nextSessionId(), boundChannelId: "ch-log" });
    await waitForPhysicalSession(manager);

    // Extract the onPostToolUse hook from the captured config
    expect(capturedConfig).toBeDefined();
    const hooks = capturedConfig!["hooks"] as { onPostToolUse: (input: { toolName: string }) => Promise<unknown> };
    expect(hooks?.onPostToolUse).toBeDefined();

    // Call the hook directly
    await hooks.onPostToolUse({ toolName: "grep" });

    // The debug log should contain the session ID
    const postToolUseLogs = debugLogs.filter((l) => l.includes("postToolUse"));
    expect(postToolUseLogs.length).toBeGreaterThanOrEqual(1);
    expect(postToolUseLogs[0]).toContain(`[${sessionId}]`);
    expect(postToolUseLogs[0]).toContain("tool=grep");
  });
});
