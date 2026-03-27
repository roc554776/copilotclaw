import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @github/copilot-sdk before importing the module under test.
// CopilotClient is used with `new`, so we use a vi.fn() that is a constructor.
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

/** Builds a fake CopilotSession that fires idle or error after send(). */
function makeMockCopilotSession(behavior: "idle" | "error"): { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; emit: (event: string, ...args: unknown[]) => void; sessionId: string; getMessages: ReturnType<typeof vi.fn> } {
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

  return { on, send, disconnect, emit, sessionId: "mock-sdk-session", getMessages };
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
    (this as Record<string, unknown>)["rpc"] = {
      models: { list: vi.fn().mockResolvedValue({ models: [{ id: "gpt-4.1", billing: { multiplier: 1 } }] }) },
      account: { getQuota: vi.fn().mockResolvedValue({ quotaSnapshots: {} }) },
    };
  });
}

describe("AgentSessionManager — stopped status and channel notification", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("suspends session and notifies channel when physical session ends normally (idle, unaborted)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => null,
      text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-idle" });

    await wait(50);

    // Session should be suspended (not deleted), channel binding preserved
    const statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("suspended");
    expect(manager.hasSessionForChannel("ch-idle")).toBe(true);
    expect(manager.hasActiveSessionForChannel("ch-idle")).toBe(false);

    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages"),
    );
    expect(notifyCalls).toHaveLength(1);
    const body = JSON.parse(notifyCalls[0]![1].body as string) as { sender: string; message: string };
    expect(body.sender).toBe("agent");
    expect(body.message).toContain("stopped unexpectedly");
  });

  it("suspends session and notifies channel when physical session throws an error (unaborted)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("error")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => null,
      text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-error" });

    await wait(50);

    // Session should be suspended (not deleted)
    const statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]?.status).toBe("suspended");
    expect(manager.hasSessionForChannel("ch-error")).toBe(true);

    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages"),
    );
    expect(notifyCalls).toHaveLength(1);
    const body = JSON.parse(notifyCalls[0]![1].body as string) as { sender: string; message: string };
    expect(body.message).toContain("stopped unexpectedly");
  });

  it("does not notify the channel when session is aborted via stopSession", async () => {
    let resolveCreate!: (session: object) => void;
    const pendingCreate = new Promise<object>((res) => { resolveCreate = res; });
    installClientMock(vi.fn().mockReturnValue(pendingCreate));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({}),
      text: async () => "{}",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-abort" });

    // Abort immediately before createSession resolves
    manager.stopSession(sessionId);

    // Now resolve — the aborted signal will cause runSession to be short-circuited
    resolveCreate(makeMockCopilotSession("idle"));

    await wait(50);

    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages"),
    );
    expect(notifyCalls).toHaveLength(0);
  });

  it("checkStaleAndHandle returns ok for sessions not in processing state", async () => {
    installClientMock(vi.fn().mockImplementation(async () => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      return {
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
        }),
        send: vi.fn().mockResolvedValue("msg-id"),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
    }));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      staleTimeoutMs: 1,
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-stale" });
    await wait(30);

    // Session is in "waiting" state, not "processing" — stale check should return "ok"
    const result = await manager.checkStaleAndHandle(sessionId, "some-pending-id");
    expect(result).toBe("ok");
  });

  it("does not notify when there is no bound channel (channel-less session errors immediately)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    // No boundChannelId — runSession throws "channel-less sessions not yet supported"
    manager.startSession();

    await wait(50);

    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages"),
    );
    expect(notifyCalls).toHaveLength(0);
  });
});

describe("AgentSessionManager — session max age", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("suspends session on max age (preserving channel binding and copilotSessionId)", async () => {
    installClientMock(vi.fn().mockImplementation(async () => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      return {
        sessionId: "sdk-session-old",
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
        }),
        send: vi.fn().mockResolvedValue("msg-id"),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
    }));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      maxSessionAgeMs: 1,
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-age" });
    await wait(20);

    const statuses = manager.getSessionStatuses();
    const sessionId = Object.keys(statuses)[0]!;
    const stopped = manager.checkSessionMaxAge(sessionId);
    expect(stopped).toBe(true);

    // Session should be suspended, not deleted
    const afterStatuses = manager.getSessionStatuses();
    expect(afterStatuses[sessionId]?.status).toBe("suspended");

    // Channel binding should be preserved
    expect(manager.hasSessionForChannel("ch-age")).toBe(true);

    // But it should not be "active"
    expect(manager.hasActiveSessionForChannel("ch-age")).toBe(false);

    await wait(20);
  });

  it("does not stop session that is within max age", async () => {
    installClientMock(vi.fn().mockImplementation(async () => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      return {
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
        }),
        send: vi.fn().mockResolvedValue("msg-id"),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
    }));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      maxSessionAgeMs: 999999999,
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-young" });
    await wait(20);

    const stopped = manager.checkSessionMaxAge(sessionId);
    expect(stopped).toBe(false);
    // Session still exists
    const statuses = manager.getSessionStatuses();
    expect(statuses[sessionId]).toBeDefined();
  });
});

describe("AgentSessionManager — suspended session revival", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revives a suspended session with the same sessionId and channel binding", async () => {
    const mockSession = makeMockCopilotSession("idle");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-revive" });
    await wait(50); // session idles and suspends

    expect(manager.getSessionStatuses()[sessionId]?.status).toBe("suspended");
    expect(manager.hasSessionForChannel("ch-revive")).toBe(true);

    // Revive by calling startSession again with the same channel
    const mockSession2 = makeMockCopilotSession("idle");
    mockSession2.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession2));

    const revivedId = manager.startSession({ boundChannelId: "ch-revive" });

    // Must return the SAME abstract session ID
    expect(revivedId).toBe(sessionId);

    await waitForPhysicalSession(manager);

    // Session should be active again
    const status = manager.getSessionStatuses()[sessionId]?.status;
    expect(status).not.toBe("suspended");

    mockSession2.emit("session.idle");
    await wait(30);
  });

  it("explicit stopSession fully removes session and channel binding", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-explicit-stop" });
    await waitForPhysicalSession(manager);

    manager.stopSession(sessionId);
    await wait(30);

    // Fully removed — not just suspended
    expect(manager.getSessionStatuses()[sessionId]).toBeUndefined();
    expect(manager.hasSessionForChannel("ch-explicit-stop")).toBe(false);

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — binding persistence", () => {
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-test-"));
    persistPath = join(tmpDir, "agent-bindings.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists suspended session bindings (including copilotSessionId) and restores on new manager", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
      persistPath,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-persist" });
    await wait(50); // session idles → suspended → saved to disk

    // Verify file was written with copilotSessionId
    const raw = readFileSync(persistPath, "utf-8");
    const snapshot = JSON.parse(raw) as { sessions: Array<{ sessionId: string; boundChannelId: string; copilotSessionId?: string }> };
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]!.sessionId).toBe(sessionId);
    expect(snapshot.sessions[0]!.boundChannelId).toBe("ch-persist");
    expect(snapshot.sessions[0]!.copilotSessionId).toBe("mock-sdk-session");

    // Create a new manager from the same persist file — simulates agent restart
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));
    const manager2 = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
      persistPath,
    });

    // Channel binding should be restored
    expect(manager2.hasSessionForChannel("ch-persist")).toBe(true);
    expect(manager2.hasActiveSessionForChannel("ch-persist")).toBe(false);

    // Session should be in suspended state
    const statuses = manager2.getSessionStatuses();
    const restored = Object.values(statuses).find((s) => s.boundChannelId === "ch-persist");
    expect(restored?.status).toBe("suspended");
  });

  it("removes binding from persist file on explicit stopSession", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");
    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
      persistPath,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-persist-stop" });
    await waitForPhysicalSession(manager);

    manager.stopSession(sessionId);
    await wait(30);

    // Persist file should have no sessions
    const raw = readFileSync(persistPath, "utf-8");
    const snapshot = JSON.parse(raw) as { sessions: unknown[] };
    expect(snapshot.sessions).toHaveLength(0);

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — stale deferred resume", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Build a session mock that stays in "processing" state indefinitely (no idle/error events). */
  function makeStuckSession(sdkSessionId: string): object {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      sessionId: sdkSessionId,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
      }),
      send: vi.fn().mockResolvedValue("msg-id"),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("saves copilotSessionId, notifies channel, and returns flushed on stale timeout", async () => {
    installClientMock(vi.fn().mockImplementation(async () => makeStuckSession("sdk-stale-id")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      staleTimeoutMs: 1,
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-stale-defer" });
    await wait(20);

    // Manually transition to processing state (simulate the LLM starting work)
    const entry = (manager as unknown as { sessions: Map<string, { info: { status: string; processingStartedAt: string }; copilotSessionId: string }> }).sessions.get(sessionId);
    if (entry !== undefined) {
      entry.info.status = "processing";
      entry.info.processingStartedAt = new Date(Date.now() - 100).toISOString(); // 100ms ago, well past staleTimeoutMs=1ms
      entry.copilotSessionId = "sdk-stale-id";
    }

    const result = await manager.checkStaleAndHandle(sessionId, "pending-msg-id");

    // Must return "flushed" so the caller flushes stale inputs
    expect(result).toBe("flushed");

    // Session should be suspended (not deleted), channel binding preserved
    const afterStatuses = manager.getSessionStatuses();
    expect(afterStatuses[sessionId]?.status).toBe("suspended");
    expect(manager.hasSessionForChannel("ch-stale-defer")).toBe(true);
    expect(manager.hasActiveSessionForChannel("ch-stale-defer")).toBe(false);

    // Must have notified the channel of the timeout
    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages") && !(url as string).includes("pending"),
    );
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(notifyCalls[0]![1].body as string) as { sender: string; message: string };
    expect(body.sender).toBe("agent");
    expect(body.message).toContain("timed out");
  });

  it("does not suspend session when oldestInputId is undefined (nothing pending - stale check)", async () => {
    installClientMock(vi.fn().mockImplementation(async () => makeStuckSession("sdk-noop-id")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      staleTimeoutMs: 1,
      fetch: fetchSpy,
    });

    const sessionId = manager.startSession({ boundChannelId: "ch-nopending" });
    await wait(20);

    const entry = (manager as unknown as { sessions: Map<string, { info: { status: string; processingStartedAt: string }; copilotSessionId: string }> }).sessions.get(sessionId);
    if (entry !== undefined) {
      entry.info.status = "processing";
      entry.info.processingStartedAt = new Date(Date.now() - 100).toISOString();
      entry.copilotSessionId = "sdk-noop-id";
    }

    // oldestInputId is undefined — agent may be legitimately finishing
    const result = await manager.checkStaleAndHandle(sessionId, undefined);
    expect(result).toBe("ok");
    // Session should NOT be suspended
    expect(manager.hasActiveSessionForChannel("ch-nopending")).toBe(true);
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

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-assistant-msg" });
    await waitForPhysicalSession(manager);

    mockSession.emit("assistant.message", { data: { content: "Hello from assistant" } });
    await wait(10);

    const messageCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url, opts]) => (url as string).includes("/messages") && !(url as string).includes("pending") && opts.method === "POST",
    );
    expect(messageCalls).toHaveLength(1);
    const body = JSON.parse(messageCalls[0]![1].body as string) as { sender: string; message: string };
    expect(body.sender).toBe("agent");
    expect(body.message).toBe("Hello from assistant");

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("does not post empty assistant.message content", async () => {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle emit so we can emit assistant.message first, then idle manually.
    mockSession.send.mockImplementation(async () => "msg-id");

    installClientMock(vi.fn().mockResolvedValue(mockSession));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-empty-msg" });
    await waitForPhysicalSession(manager);

    mockSession.emit("assistant.message", { data: { content: "" } });
    await wait(10);

    const messageCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url, opts]) => (url as string).includes("/messages") && !(url as string).includes("pending") && opts.method === "POST",
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

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-usage" });
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

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-quota" });
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

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-noquota" });
    await waitForPhysicalSession(manager);

    mockSession.emit("assistant.usage", { data: { model: "gpt-4.1", inputTokens: 10 } });

    const statuses = manager.getSessionStatuses();
    const session = Object.values(statuses)[0];
    expect(session?.physicalSession?.latestQuotaSnapshots).toBeUndefined();

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
    fetchSpy: ReturnType<typeof vi.fn>;
    manager: AgentSessionManager;
  }> {
    const mockSession = makeMockCopilotSession("idle");
    // Suppress automatic idle emit so we can control events manually.
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-reminder" });
    await waitForPhysicalSession(manager);

    return { mockSession, createSessionSpy, fetchSpy, manager };
  }

  it("sets needsReminder when context usage crosses 10% threshold", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    // 30% usage (≥ lastReminderPercent 0% + 10% threshold)
    mockSession.emit("session.usage_info", { data: { currentTokens: 30000, tokenLimit: 100000 } });

    // Only copilotclaw_receive_input triggers reminder (parent-exclusive tool)
    const result = await hook({ toolName: "copilotclaw_receive_input" });
    expect(result?.additionalContext).toContain("<system>");
    expect(result?.additionalContext).toContain("copilotclaw_receive_input");

    // Second call at same usage should NOT contain reminder (already fired)
    const result2 = await hook({ toolName: "copilotclaw_receive_input" });
    expect(result2?.additionalContext ?? "").not.toContain("<system>");

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("does not fire for copilotclaw_send_message (shared with subagent)", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    mockSession.emit("session.usage_info", { data: { currentTokens: 50000, tokenLimit: 100000 } });

    // copilotclaw_send_message is shared with subagent worker → early return
    const result = await hook({ toolName: "copilotclaw_send_message" });
    expect(result).toBeUndefined();

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("does not fire for copilotclaw_list_messages (shared with subagent)", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    mockSession.emit("session.usage_info", { data: { currentTokens: 50000, tokenLimit: 100000 } });

    const result = await hook({ toolName: "copilotclaw_list_messages" });
    expect(result).toBeUndefined();

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("does not fire for built-in tools or debug mock tools", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    mockSession.emit("session.usage_info", { data: { currentTokens: 50000, tokenLimit: 100000 } });

    expect(await hook({ toolName: "Read" })).toBeUndefined();
    expect(await hook({ toolName: "Bash" })).toBeUndefined();
    expect(await hook({ toolName: "copilotclaw_debug_mock_read_file" })).toBeUndefined();

    // But copilotclaw_receive_input does fire
    const result = await hook({ toolName: "copilotclaw_receive_input" });
    expect(result?.additionalContext).toContain("<system>");

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("fires reminder immediately after compaction_complete", async () => {
    const { mockSession, createSessionSpy } = await setupWithHookCapture();

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    mockSession.emit("session.compaction_complete", { data: { success: true } });

    const result = await hook({ toolName: "copilotclaw_receive_input" });
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

    const result = await hook({ toolName: "copilotclaw_receive_input" });
    expect(result?.additionalContext ?? "").not.toContain("<system>");

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("initial prompt mentions <system> tags in additionalContext", async () => {
    const { mockSession } = await setupWithHookCapture();

    expect(mockSession.send).toHaveBeenCalled();
    const sendArg = mockSession.send.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(sendArg?.prompt).toContain("copilotclaw_receive_input");

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

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-agents" });
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
    expect(operator!.prompt).toContain("copilotclaw_receive_input");

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

describe("AgentSessionManager — subagent completion notification", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("injects subagent completion info via onPostToolUse additionalContext", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-sub-notify" });
    await waitForPhysicalSession(manager);

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    // Emit subagent.completed event
    mockSession.emit("subagent.completed", {
      data: { toolCallId: "tc-1", agentName: "worker", agentDisplayName: "Worker" },
    });

    // Next onPostToolUse (parent tool) should include subagent peek notification
    const result = await hook({ toolName: "copilotclaw_receive_input" });
    expect(result?.additionalContext).toContain("[SUBAGENT UPDATE]");
    expect(result?.additionalContext).toContain("worker completed");
    // onPostToolUse peeks the queue (does not drain) — receiveInput is the sole drain point.
    // So the second call still sees the same completion info.
    const result2 = await hook({ toolName: "copilotclaw_receive_input" });
    expect(result2?.additionalContext).toContain("[SUBAGENT UPDATE]");

    mockSession.emit("session.idle");
    await wait(30);
  });

  it("injects subagent.failed info with error message", async () => {
    const mockSession = makeMockCopilotSession("idle");
    mockSession.send.mockImplementation(async () => "msg-id");

    const createSessionSpy = vi.fn().mockResolvedValue(mockSession);
    installClientMock(createSessionSpy);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-sub-fail" });
    await waitForPhysicalSession(manager);

    const config = createSessionSpy.mock.calls[0]![0] as { hooks: { onPostToolUse: (input: { toolName: string }) => Promise<{ additionalContext?: string } | undefined> } };
    const hook = config.hooks.onPostToolUse;

    mockSession.emit("subagent.failed", {
      data: { toolCallId: "tc-2", agentName: "worker", agentDisplayName: "Worker", error: "timeout" },
    });

    const result = await hook({ toolName: "copilotclaw_receive_input" });
    expect(result?.additionalContext).toContain("[SUBAGENT UPDATE]");
    expect(result?.additionalContext).toContain("worker failed");
    expect(result?.additionalContext).toContain("timeout");

    mockSession.emit("session.idle");
    await wait(30);
  });
});

describe("AgentSessionManager — session failure backoff", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enters backoff when session fails rapidly (< 30s)", async () => {
    // createSession rejects immediately — rapid failure
    installClientMock(vi.fn().mockRejectedValue(new Error("auth failed")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-backoff" });
    await wait(50);

    // Channel should be in backoff
    expect(manager.isChannelInBackoff("ch-backoff")).toBe(true);
  });

  it("does not backoff for channels without prior failure", () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    expect(manager.isChannelInBackoff("ch-no-failure")).toBe(false);
  });

  it("backoff expires after the backoff duration", async () => {
    installClientMock(vi.fn().mockRejectedValue(new Error("auth failed")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-backoff-expiry" });
    await wait(50);

    expect(manager.isChannelInBackoff("ch-backoff-expiry")).toBe(true);

    // Fast-forward past the backoff duration
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000); // 61 seconds later
    expect(manager.isChannelInBackoff("ch-backoff-expiry")).toBe(false);
    vi.useRealTimers();
  });
});

describe("AgentSessionManager — error detail in channel notification", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes error reason in stopped notification when session throws", async () => {
    installClientMock(vi.fn().mockRejectedValue(new Error("model resolution failed")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-error-detail" });
    await wait(50);

    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages"),
    );
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(notifyCalls[0]![1].body as string) as { message: string };
    expect(body.message).toContain("stopped unexpectedly");
    expect(body.message).toContain("model resolution failed");
  });

  it("omits error detail when session ends normally (idle)", async () => {
    installClientMock(vi.fn().mockResolvedValue(makeMockCopilotSession("idle")));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: async () => null, text: async () => "null",
    } as Response);

    const manager = new AgentSessionManager({
      gatewayBaseUrl: "http://localhost:9999",
      fetch: fetchSpy,
    });

    manager.startSession({ boundChannelId: "ch-idle-no-detail" });
    await wait(50);

    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages"),
    );
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(notifyCalls[0]![1].body as string) as { message: string };
    expect(body.message).toContain("stopped unexpectedly.");
    // No ": reason" appended for idle exit — message ends with "unexpectedly."
    expect(body.message).not.toContain("unexpectedly:");
  });
});
