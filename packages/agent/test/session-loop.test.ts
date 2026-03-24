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
      queueMicrotask(() => { mock.callbacks?.onIdle(); });
      return "msg-id";
    },
    async disconnect() {},
  };
  return mock;
}

describe("runSessionLoop", () => {
  it("sends initial prompt and continue prompt on each idle", async () => {
    const session = createMockSession();
    const result = await runSessionLoop({
      session,
      initialPrompt: "init",
      continuePrompt: "continue",
      maxTurns: 3,
    });

    expect(session.sendCalls[0]?.prompt).toBe("init");
    expect(session.sendCalls[1]?.prompt).toBe("continue");
    expect(session.sendCalls[1]?.mode).toBe("enqueue");
    expect(session.sendCalls[2]?.prompt).toBe("continue");
    expect(session.sendCalls[3]?.prompt).toBe("continue");
    // 4th idle exceeds maxTurns=3, stops
    expect(result.turnCount).toBe(4);
  });

  it("stops at maxTurns", async () => {
    const session = createMockSession();
    const result = await runSessionLoop({
      session,
      initialPrompt: "init",
      continuePrompt: "continue",
      maxTurns: 1,
    });

    // turn 1: idle after init -> send continue
    // turn 2: idle after continue -> exceeds maxTurns=1
    expect(result.turnCount).toBe(2);
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
      continuePrompt: "continue",
      maxTurns: 1,
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
        continuePrompt: "continue",
        maxTurns: 10,
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
      continuePrompt: "continue",
      maxTurns: 10,
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
      continuePrompt: "continue",
      maxTurns: 0,
      log: (msg) => { logs.push(msg); },
    });

    expect(logs.some((l) => l.includes("disconnect error"))).toBe(true);
  });
});
