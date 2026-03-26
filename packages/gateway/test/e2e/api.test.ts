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

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/channels", () => {
  it("returns the default channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels`);
    expect(res.status).toBe(200);
    const channels = await res.json() as Array<{ id: string }>;
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe(defaultChannelId);
  });
});

describe("POST /api/channels", () => {
  it("creates a new channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels`, { method: "POST" });
    expect(res.status).toBe(201);
    const ch = await res.json() as { id: string; createdAt: string };
    expect(ch.id).toBeTruthy();
    expect(ch.id).not.toBe(defaultChannelId);
  });
});

describe("POST /api/channels/:channelId/messages (user message)", () => {
  it("creates a user message in the channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "test message" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; channelId: string; sender: string; message: string };
    expect(body.id).toBeTruthy();
    expect(body.channelId).toBe(defaultChannelId);
    expect(body.sender).toBe("user");
    expect(body.message).toBe("test message");
  });

  it("returns 400 when message is missing", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/nonexistent/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "hello" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/channels/:channelId/messages (agent message)", () => {
  it("creates an agent message", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const res = await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "agent", message: "hello from agent" }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json() as { sender: string; message: string };
    expect(msg.sender).toBe("agent");
    expect(msg.message).toBe("hello from agent");
    await freshHandle.close();
  });
});

describe("POST /api/channels/:channelId/messages/pending", () => {
  it("returns 204 when no pending messages", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;
    const res = await fetch(`${url}/api/channels/${chId}/messages/pending`, { method: "POST" });
    expect(res.status).toBe(204);
    await freshHandle.close();
  });

  it("drains all pending user messages at once", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "first" }),
    });
    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "second" }),
    });

    const res = await fetch(`${url}/api/channels/${chId}/messages/pending`, { method: "POST" });
    expect(res.status).toBe(200);
    const msgs = await res.json() as Array<{ sender: string; message: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.message).toBe("first");
    expect(msgs[1]!.message).toBe("second");

    // Queue is now empty
    const res2 = await fetch(`${url}/api/channels/${chId}/messages/pending`, { method: "POST" });
    expect(res2.status).toBe(204);

    await freshHandle.close();
  });
});

describe("GET /api/channels/:channelId/messages", () => {
  it("returns empty array when no messages", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;
    const res = await fetch(`${url}/api/channels/${chId}/messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    await freshHandle.close();
  });

  it("returns messages with sender info", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "hello" }),
    });

    const res = await fetch(`${url}/api/channels/${chId}/messages`);
    const msgs = await res.json() as Array<{ sender: string; message: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender).toBe("user");
    expect(msgs[0]!.message).toBe("hello");
    await freshHandle.close();
  });

  it("respects the limit query parameter", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    for (let i = 1; i <= 4; i++) {
      await fetch(`${url}/api/channels/${chId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "user", message: `msg-${i}` }),
      });
    }

    const res = await fetch(`${url}/api/channels/${chId}/messages?limit=2`);
    const msgs = await res.json() as Array<{ message: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.message).toBe("msg-4");
    expect(msgs[1]!.message).toBe("msg-3");
    await freshHandle.close();
  });

  it("returns 404 for non-existent channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/nonexistent/messages`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/stop", () => {
  it("returns stopping status and triggers onStop callback", async () => {
    let stopped = false;
    const stopHandle = await startServer({
      port: 0,
      store: new Store(),
      onStop: () => { stopped = true; },
      agentManager: null,
    });
    const res = await fetch(`http://localhost:${stopHandle.port}/api/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "stopping" });
    expect(stopped).toBe(true);
    await stopHandle.close();
  });
});

describe("GET /", () => {
  it("returns HTML dashboard", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("copilotclaw");
  });
});

describe("GET /api/status", () => {
  it("returns gateway status with version, null agent, and unavailable compatibility", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { gateway: { status: string; version: string }; agent: null; agentCompatibility: string };
    expect(body.gateway.status).toBe("running");
    expect(body.gateway.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.agent).toBeNull();
    expect(body.agentCompatibility).toBe("unavailable");
  });
});

describe("GET /api/logs", () => {
  it("returns an array of log entries", async () => {
    const res = await fetch(`${baseUrl}/api/logs`);
    expect(res.status).toBe(200);
    const logs = await res.json() as Array<{ timestamp: string; source: string; level: string; message: string }>;
    expect(Array.isArray(logs)).toBe(true);
  });

  it("respects limit parameter", async () => {
    const res = await fetch(`${baseUrl}/api/logs?limit=1`);
    expect(res.status).toBe(200);
    const logs = await res.json() as unknown[];
    expect(logs.length).toBeLessThanOrEqual(1);
  });
});

describe("GET / (dashboard status bar)", () => {
  it("shows status bar in dashboard HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("status-bar");
    expect(html).toContain("gateway: running");
  });
});

describe("GET /api/quota", () => {
  it("returns 503 when no agent manager", async () => {
    const res = await fetch(`${baseUrl}/api/quota`);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/models", () => {
  it("returns 503 when no agent manager", async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/status (config section)", () => {
  it("includes config in status response", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json() as { config?: { model: unknown; zeroPremium: unknown; debugMockCopilotUnsafeTools: unknown } };
    expect(body.config).toBeDefined();
    expect(body.config!.zeroPremium).toBe(false);
    expect(body.config!.debugMockCopilotUnsafeTools).toBe(false);
  });
});

describe("GET /api/sessions/:sessionId/messages", () => {
  it("returns 404 when no agent manager", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/messages`);
    expect(res.status).toBe(404);
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
