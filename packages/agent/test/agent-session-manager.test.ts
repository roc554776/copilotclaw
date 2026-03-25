import { afterEach, describe, expect, it, vi } from "vitest";

// Mock @github/copilot-sdk before importing the module under test.
// CopilotClient is used with `new`, so we use a vi.fn() that is a constructor.
vi.mock("@github/copilot-sdk", () => {
  const approveAll = vi.fn();
  // eslint-disable-next-line prefer-arrow-callback
  const CopilotClient = vi.fn(function () {
    /* constructed per-test via mockImplementation */
  });
  return { CopilotClient, approveAll };
});

import { AgentSessionManager } from "../src/agent-session-manager.js";
import { CopilotClient } from "@github/copilot-sdk";

/** Builds a fake CopilotSession that fires idle or error after send(). */
function makeMockCopilotSession(behavior: "idle" | "error"): object {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
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

  return { on, send, disconnect };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function installClientMock(createSession: ReturnType<typeof vi.fn>): void {
  (CopilotClient as ReturnType<typeof vi.fn>).mockImplementation(function (this: object) {
    (this as Record<string, unknown>)["createSession"] = createSession;
    (this as Record<string, unknown>)["stop"] = vi.fn().mockResolvedValue(undefined);
  });
}

describe("AgentSessionManager — stopped status and channel notification", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("notifies the channel when session ends normally (idle, unaborted)", async () => {
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

    manager.startSession({ boundChannelId: "ch-idle" });

    await wait(50);

    const notifyCalls = (fetchSpy.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => (url as string).includes("/messages"),
    );
    expect(notifyCalls).toHaveLength(1);
    const body = JSON.parse(notifyCalls[0]![1].body as string) as { sender: string; message: string };
    expect(body.sender).toBe("agent");
    expect(body.message).toContain("stopped unexpectedly");
  });

  it("notifies the channel when session throws an error (unaborted)", async () => {
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

    manager.startSession({ boundChannelId: "ch-error" });

    await wait(50);

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
