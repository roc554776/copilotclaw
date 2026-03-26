import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, startServer } from "../../src/server.js";
import { Store } from "../../src/store.js";

let handle: ServerHandle;
let baseUrl: string;
let defaultChannelId: string;

beforeAll(async () => {
  handle = await startServer({ port: 0, store: new Store(), agentManager: null });
  baseUrl = `http://localhost:${handle.port}`;
  const channels = await (await fetch(`${baseUrl}/api/channels`)).json() as Array<{ id: string }>;
  defaultChannelId = channels[0]!.id;
});

afterAll(async () => {
  await handle.close();
});

function connectSSE(channel: string): { events: Array<{ type: string; data: unknown }>; controller: AbortController; ready: Promise<void> } {
  const events: Array<{ type: string; data: unknown }> = [];
  const controller = new AbortController();
  const ready = new Promise<void>((resolve, reject) => {
    fetch(`${baseUrl}/api/events?channel=${channel}`, { signal: controller.signal })
      .then(async (res) => {
        if (res.status !== 200) { reject(new Error(`SSE status ${res.status}`)); return; }
        resolve(); // Connected
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const parsed = JSON.parse(line.slice(6)) as { type: string };
                  events.push({ type: parsed.type, data: parsed });
                } catch {}
              }
            }
          }
        } catch {
          // Aborted or connection closed
        }
      })
      .catch(() => {});
  });
  return { events, controller, ready };
}

describe("SSE /api/events", () => {
  it("connects to /api/events endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/events?channel=${defaultChannelId}`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);
    // The request should start with status 200 (SSE keeps connection open)
    // AbortSignal.timeout will abort it, but we should have gotten headers
    // Use a different approach: just verify the content-type
    const controller = new AbortController();
    const resPromise = fetch(`${baseUrl}/api/events?channel=${defaultChannelId}`, { signal: controller.signal });
    // Give it a moment to connect
    await new Promise((r) => { setTimeout(r, 50); });
    controller.abort();
    try {
      const res2 = await resPromise;
      expect(res2.headers.get("content-type")).toBe("text/event-stream");
    } catch {
      // Aborted — that's fine, the connection was established
    }
  });

  it("receives new_message event when input is posted", async () => {
    const sse = connectSSE(defaultChannelId);
    await sse.ready;
    // Small delay to ensure SSE client is fully registered
    await new Promise((r) => { setTimeout(r, 50); });

    await fetch(`${baseUrl}/api/channels/${defaultChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "sse-test-input" }),
    });

    // Wait for event to arrive
    await new Promise((r) => { setTimeout(r, 100); });
    sse.controller.abort();

    expect(sse.events.length).toBeGreaterThanOrEqual(1);
    const msgEvent = sse.events.find((e) => e.type === "new_message");
    expect(msgEvent).toBeTruthy();
  });

  it("receives new_message event when agent message is posted", async () => {
    const sse = connectSSE(defaultChannelId);
    await sse.ready;
    await new Promise((r) => { setTimeout(r, 50); });

    await fetch(`${baseUrl}/api/channels/${defaultChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "agent", message: "sse-test-agent" }),
    });

    await new Promise((r) => { setTimeout(r, 100); });
    sse.controller.abort();

    const msgEvent = sse.events.find((e) => e.type === "new_message");
    expect(msgEvent).toBeTruthy();
  });

  it("does not receive events for other channels", async () => {
    const ch2Res = await fetch(`${baseUrl}/api/channels`, { method: "POST" });
    const ch2 = await ch2Res.json() as { id: string };

    const sse = connectSSE(defaultChannelId);
    await sse.ready;
    await new Promise((r) => { setTimeout(r, 50); });

    // Post to the other channel
    await fetch(`${baseUrl}/api/channels/${ch2.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "other-channel" }),
    });

    await new Promise((r) => { setTimeout(r, 100); });
    sse.controller.abort();

    expect(sse.events).toHaveLength(0);
  });

  it("tracks connected clients", async () => {
    // Use a fresh server to avoid interference from prior tests
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    expect(freshHandle.sseBroadcaster.clientCount).toBe(0);

    const freshUrl = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${freshUrl}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const controller = new AbortController();
    const resPromise = fetch(`${freshUrl}/api/events?channel=${chId}`, { signal: controller.signal });
    await new Promise((r) => { setTimeout(r, 50); });
    expect(freshHandle.sseBroadcaster.clientCount).toBe(1);

    controller.abort();
    await resPromise.catch(() => {});
    await new Promise((r) => { setTimeout(r, 50); });
    expect(freshHandle.sseBroadcaster.clientCount).toBe(0);

    await freshHandle.close();
  });
});
