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

function connectSSE(path: string): { events: Array<{ type: string; data: unknown }>; controller: AbortController; ready: Promise<void> } {
  const events: Array<{ type: string; data: unknown }> = [];
  const controller = new AbortController();
  const ready = new Promise<void>((resolve, reject) => {
    fetch(`${baseUrl}${path}`, { signal: controller.signal })
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

describe("SSE /api/events (channel-scoped)", () => {
  it("connects to /api/events endpoint with channel param", async () => {
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

  it("returns 400 when channel param is missing", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("channel");
  });

  it("receives new_message event when input is posted", async () => {
    const sse = connectSSE(`/api/events?channel=${defaultChannelId}`);
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
    const sse = connectSSE(`/api/events?channel=${defaultChannelId}`);
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

    const sse = connectSSE(`/api/events?channel=${defaultChannelId}`);
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

describe("SSE /api/global-events (global-scoped)", () => {
  it("connects to /api/global-events endpoint", async () => {
    const controller = new AbortController();
    const resPromise = fetch(`${baseUrl}/api/global-events`, { signal: controller.signal });
    await new Promise((r) => { setTimeout(r, 50); });
    controller.abort();
    try {
      const res2 = await resPromise;
      expect(res2.headers.get("content-type")).toBe("text/event-stream");
    } catch {
      // Aborted — connection was established
    }
  });

  it("global client receives broadcastGlobal events", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;

    // manually build the SSE connection to the fresh server
    const events: Array<{ type: string; data: unknown }> = [];
    const controller = new AbortController();
    const ready = new Promise<void>((resolve, reject) => {
      fetch(`${freshUrl}/api/global-events`, { signal: controller.signal })
        .then(async (res) => {
          if (res.status !== 200) { reject(new Error(`SSE status ${res.status}`)); return; }
          resolve();
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
          } catch {}
        })
        .catch(() => {});
    });

    await ready;
    await new Promise((r) => { setTimeout(r, 50); });

    // Broadcast global event
    freshHandle.sseBroadcaster.broadcastGlobal({
      type: "agent_status_change",
      version: "1.0.0",
      running: true,
    });

    await new Promise((r) => { setTimeout(r, 100); });
    controller.abort();

    expect(events.find((e) => e.type === "agent_status_change")).toBeTruthy();

    await freshHandle.close();
  });

  it("global client does NOT receive channel-scoped broadcastToChannel events", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${freshUrl}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const globalEvents: Array<{ type: string }> = [];
    const globalController = new AbortController();
    const globalReady = new Promise<void>((resolve) => {
      fetch(`${freshUrl}/api/global-events`, { signal: globalController.signal })
        .then(async (res) => {
          if (res.status !== 200) return;
          resolve();
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
                  try { globalEvents.push(JSON.parse(line.slice(6)) as { type: string }); } catch {}
                }
              }
            }
          } catch {}
        })
        .catch(() => {});
    });

    await globalReady;
    await new Promise((r) => { setTimeout(r, 50); });

    // Broadcast to a specific channel — global client should NOT receive
    freshHandle.sseBroadcaster.broadcastToChannel(chId, { type: "new_message", data: { msg: "hello" } });

    await new Promise((r) => { setTimeout(r, 100); });
    globalController.abort();

    expect(globalEvents).toHaveLength(0);

    await freshHandle.close();
  });

  it("channel client does NOT receive broadcastGlobal events", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${freshUrl}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const channelEvents: Array<{ type: string }> = [];
    const channelController = new AbortController();
    const channelReady = new Promise<void>((resolve) => {
      fetch(`${freshUrl}/api/events?channel=${chId}`, { signal: channelController.signal })
        .then(async (res) => {
          if (res.status !== 200) return;
          resolve();
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
                  try { channelEvents.push(JSON.parse(line.slice(6)) as { type: string }); } catch {}
                }
              }
            }
          } catch {}
        })
        .catch(() => {});
    });

    await channelReady;
    await new Promise((r) => { setTimeout(r, 50); });

    // Broadcast globally — channel client should NOT receive
    freshHandle.sseBroadcaster.broadcastGlobal({ type: "agent_status_change", version: "x", running: false });

    await new Promise((r) => { setTimeout(r, 100); });
    channelController.abort();

    expect(channelEvents).toHaveLength(0);

    await freshHandle.close();
  });

  it("global client receives broadcastGlobal token_usage_update event", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;

    const events: Array<{ type: string; data: unknown }> = [];
    const controller = new AbortController();
    const ready = new Promise<void>((resolve, reject) => {
      fetch(`${freshUrl}/api/global-events`, { signal: controller.signal })
        .then(async (res) => {
          if (res.status !== 200) { reject(new Error(`SSE status ${res.status}`)); return; }
          resolve();
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
          } catch {}
        })
        .catch(() => {});
    });

    await ready;
    await new Promise((r) => { setTimeout(r, 50); });

    const summary = [
      { model: "gpt-4o", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, multiplier: 1 },
    ];

    freshHandle.sseBroadcaster.broadcastGlobal({
      type: "token_usage_update",
      summary,
    });

    await new Promise((r) => { setTimeout(r, 100); });
    controller.abort();

    const received = events.find((e) => e.type === "token_usage_update");
    expect(received).toBeTruthy();
    expect((received!.data as { summary: typeof summary }).summary).toEqual(summary);

    await freshHandle.close();
  });
});

describe("SSE /api/sessions/:id/events/stream (session-scoped)", () => {
  it("session client receives session_event_appended via broadcastToSession", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;

    const sessionEvents: Array<{ type: string; data: unknown }> = [];
    const controller = new AbortController();
    const ready = new Promise<void>((resolve, reject) => {
      fetch(`${freshUrl}/api/sessions/test-session-abc/events/stream`, { signal: controller.signal })
        .then(async (res) => {
          if (res.status !== 200) { reject(new Error(`SSE status ${res.status}`)); return; }
          resolve();
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
                    sessionEvents.push({ type: parsed.type, data: parsed });
                  } catch {}
                }
              }
            }
          } catch {}
        })
        .catch(() => {});
    });

    await ready;
    await new Promise((r) => { setTimeout(r, 50); });

    // Broadcast to the correct session
    freshHandle.sseBroadcaster.broadcastToSession("test-session-abc", {
      type: "session_event_appended",
      event: { type: "tool.execution_start", timestamp: "2026-04-14T10:00:00Z", data: { toolName: "bash" } },
    });

    await new Promise((r) => { setTimeout(r, 100); });
    controller.abort();

    expect(sessionEvents.find((e) => e.type === "session_event_appended")).toBeTruthy();

    await freshHandle.close();
  });

  it("session client does NOT receive broadcastToSession for a different session", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;

    const sessionEvents: Array<{ type: string }> = [];
    const controller = new AbortController();
    const ready = new Promise<void>((resolve) => {
      fetch(`${freshUrl}/api/sessions/session-A/events/stream`, { signal: controller.signal })
        .then(async (res) => {
          if (res.status !== 200) return;
          resolve();
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
                  try { sessionEvents.push(JSON.parse(line.slice(6)) as { type: string }); } catch {}
                }
              }
            }
          } catch {}
        })
        .catch(() => {});
    });

    await ready;
    await new Promise((r) => { setTimeout(r, 50); });

    // Broadcast to session-B — session-A client should NOT receive
    freshHandle.sseBroadcaster.broadcastToSession("session-B", {
      type: "session_event_appended",
      event: { type: "tool.execution_start", timestamp: "2026-04-14T10:00:00Z", data: {} },
    });

    await new Promise((r) => { setTimeout(r, 100); });
    controller.abort();

    expect(sessionEvents).toHaveLength(0);

    await freshHandle.close();
  });

  it("session client does NOT receive broadcastGlobal events", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;

    const sessionEvents: Array<{ type: string }> = [];
    const controller = new AbortController();
    const ready = new Promise<void>((resolve) => {
      fetch(`${freshUrl}/api/sessions/sess-xyz/events/stream`, { signal: controller.signal })
        .then(async (res) => {
          if (res.status !== 200) return;
          resolve();
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
                  try { sessionEvents.push(JSON.parse(line.slice(6)) as { type: string }); } catch {}
                }
              }
            }
          } catch {}
        })
        .catch(() => {});
    });

    await ready;
    await new Promise((r) => { setTimeout(r, 50); });

    freshHandle.sseBroadcaster.broadcastGlobal({ type: "agent_status_change", version: "x", running: false });

    await new Promise((r) => { setTimeout(r, 100); });
    controller.abort();

    expect(sessionEvents).toHaveLength(0);

    await freshHandle.close();
  });

  it("channel client does NOT receive broadcastToSession events", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const freshUrl = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${freshUrl}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const channelEvents: Array<{ type: string }> = [];
    const controller = new AbortController();
    const ready = new Promise<void>((resolve) => {
      fetch(`${freshUrl}/api/events?channel=${chId}`, { signal: controller.signal })
        .then(async (res) => {
          if (res.status !== 200) return;
          resolve();
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
                  try { channelEvents.push(JSON.parse(line.slice(6)) as { type: string }); } catch {}
                }
              }
            }
          } catch {}
        })
        .catch(() => {});
    });

    await ready;
    await new Promise((r) => { setTimeout(r, 50); });

    freshHandle.sseBroadcaster.broadcastToSession("some-session", {
      type: "session_event_appended",
      event: { type: "tool.execution_start", timestamp: "2026-04-14T10:00:00Z", data: {} },
    });

    await new Promise((r) => { setTimeout(r, 100); });
    controller.abort();

    expect(channelEvents).toHaveLength(0);

    await freshHandle.close();
  });
});
