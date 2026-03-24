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
  it("sends initial prompt and stops when random >= continueProbability", async () => {
    const session = createMockSession();
    const result = await runSessionLoop({
      session,
      initialPrompt: "hello",
      continueProbability: 0.8,
      maxRetries: 20,
      random: () => 1.0,
    });

    expect(session.sendCalls[0]?.prompt).toBe("hello");
    expect(result.helloCount).toBe(1);
  });

  it("blocks stop and sends follow-up with random_number tool prompt", async () => {
    const session = createMockSession();
    let callCount = 0;
    const result = await runSessionLoop({
      session,
      initialPrompt: "start",
      continueProbability: 0.8,
      maxRetries: 20,
      random: () => {
        callCount++;
        return callCount <= 3 ? 0.5 : 0.9;
      },
    });

    expect(result.helloCount).toBe(4);
    expect(session.sendCalls).toHaveLength(4);
    expect(session.sendCalls[1]?.mode).toBe("enqueue");
    expect(session.sendCalls[1]?.prompt).toContain("hello 1");
    expect(session.sendCalls[1]?.prompt).toContain("random_number");
    expect(session.sendCalls[2]?.prompt).toContain("hello 2");
    expect(session.sendCalls[3]?.prompt).toContain("hello 3");
  });

  it("stops at maxRetries even if random always continues", async () => {
    const session = createMockSession();
    const result = await runSessionLoop({
      session,
      initialPrompt: "start",
      continueProbability: 0.8,
      maxRetries: 3,
      random: () => 0,
    });

    expect(result.helloCount).toBe(4);
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
      initialPrompt: "hello",
      continueProbability: 0,
      maxRetries: 20,
      random: () => 1.0,
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
        initialPrompt: "hello",
        continueProbability: 0.8,
        maxRetries: 20,
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
      initialPrompt: "hello",
      continueProbability: 0.8,
      maxRetries: 20,
    }).catch(() => {});

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it("suppresses disconnect errors without re-throwing", async () => {
    const session = createMockSession();
    session.disconnect = async () => { throw new Error("disconnect failed"); };
    const logs: string[] = [];

    await runSessionLoop({
      session,
      initialPrompt: "hello",
      continueProbability: 0,
      maxRetries: 20,
      random: () => 1.0,
      log: (msg) => { logs.push(msg); },
    });

    expect(logs.some((l) => l.includes("disconnect error"))).toBe(true);
  });
});
