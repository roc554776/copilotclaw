import { describe, expect, it, vi } from "vitest";
import { type SessionLike, type SessionLoopCallbacks, runSessionLoop } from "../src/session-loop.js";

function createMockSession(): SessionLike & { callbacks: SessionLoopCallbacks | null; sendCalls: Array<{ prompt: string; mode?: string }> } {
  const mock: SessionLike & { callbacks: SessionLoopCallbacks | null; sendCalls: Array<{ prompt: string; mode?: string }> } = {
    callbacks: null,
    sendCalls: [],
    subscribe(callbacks: SessionLoopCallbacks) {
      mock.callbacks = callbacks;
    },
    async send(options) {
      mock.sendCalls.push(options);
      queueMicrotask(() => { mock.callbacks?.onIdle(false); });
      return "msg-id";
    },
    async disconnect() {},
  };
  return mock;
}

describe("runSessionLoop", () => {
  it("sends initial prompt and resolves on idle without sending continuePrompt", async () => {
    const session = createMockSession();
    await runSessionLoop({
      session,
      initialPrompt: "init",
    });

    // Only initial prompt sent — no continuePrompt on idle
    expect(session.sendCalls).toHaveLength(1);
    expect(session.sendCalls[0]?.prompt).toBe("init");
  });

  it("delivers assistant messages via onMessage callback", async () => {
    const session = createMockSession();
    const messages: string[] = [];

    const origSend = session.send.bind(session);
    session.send = async (options) => {
      const result = await origSend(options);
      session.callbacks?.onMessage("response text");
      return result;
    };

    await runSessionLoop({
      session,
      initialPrompt: "init",
      onMessage: (content) => { messages.push(content); },
    });

    expect(messages).toContain("response text");
  });

  it("rejects on session error", async () => {
    const session = createMockSession();
    session.send = async (options) => {
      session.sendCalls.push(options);
      queueMicrotask(() => { session.callbacks?.onError("something broke"); });
      return "msg-id";
    };

    await expect(
      runSessionLoop({
        session,
        initialPrompt: "init",
      }),
    ).rejects.toThrow("something broke");
  });

  it("calls disconnect even after error", async () => {
    const session = createMockSession();
    const disconnectSpy = vi.spyOn(session, "disconnect");

    session.send = async (options) => {
      session.sendCalls.push(options);
      queueMicrotask(() => { session.callbacks?.onError("fail"); });
      return "msg-id";
    };

    await runSessionLoop({
      session,
      initialPrompt: "init",
    }).catch(() => {});

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it("suppresses disconnect errors without re-throwing", async () => {
    const session = createMockSession();
    session.disconnect = async () => { throw new Error("disconnect failed"); };
    const logs: string[] = [];

    await runSessionLoop({
      session,
      initialPrompt: "init",
      log: (msg) => { logs.push(msg); },
    });

    expect(logs.some((l) => l.includes("disconnect error"))).toBe(true);
  });

  it("stops before initial send when shouldStop returns true", async () => {
    const session = createMockSession();
    await runSessionLoop({
      session,
      initialPrompt: "init",
      shouldStop: () => true,
    });

    expect(session.sendCalls).toHaveLength(0);
  });

  it("logs when LLM stops calling tools (idle)", async () => {
    const session = createMockSession();
    const logs: string[] = [];

    await runSessionLoop({
      session,
      initialPrompt: "init",
      log: (msg) => { logs.push(msg); },
    });

    expect(logs.some((l) => l.includes("idle"))).toBe(true);
  });

  it("does not resolve on idle with backgroundTasks (subagent stop)", async () => {
    const session = createMockSession();
    // Override send: fire idle with backgroundTasks first, then true idle
    let idleCount = 0;
    session.send = async (options) => {
      session.sendCalls.push(options);
      queueMicrotask(() => {
        idleCount++;
        if (idleCount === 1) {
          // First idle: subagent stopped (has backgroundTasks)
          session.callbacks?.onIdle(true);
          // Then true idle after a tick
          queueMicrotask(() => { session.callbacks?.onIdle(false); });
        }
      });
      return "msg-id";
    };

    const logs: string[] = [];
    await runSessionLoop({
      session,
      initialPrompt: "init",
      log: (msg) => { logs.push(msg); },
    });

    // Should have logged the backgroundTasks idle (not ending the loop)
    expect(logs.some((l) => l.includes("backgroundTasks"))).toBe(true);
    // And eventually ended on true idle
    expect(logs.some((l) => l.includes("LLM stopped"))).toBe(true);
  });
});
