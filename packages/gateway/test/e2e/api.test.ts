import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, startServer } from "../../src/server.js";
import { Store } from "../../src/store.js";

let handle: ServerHandle;
let baseUrl: string;
let defaultChannelId: string;

beforeAll(async () => {
  handle = await startServer({ port: 0, store: new Store(), agentManager: null });
  baseUrl = `http://localhost:${handle.port}`;
  // Get the default channel created on startup
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

describe("POST /api/channels/:channelId/inputs", () => {
  it("creates an input in the channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test input" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; channelId: string; message: string };
    expect(body.id).toBeTruthy();
    expect(body.channelId).toBe(defaultChannelId);
    expect(body.message).toBe("test input");
  });

  it("returns 400 when message is missing", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/nonexistent/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/channels/:channelId/inputs/next", () => {
  it("returns 204 when queue is empty", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const channels = await (await fetch(`http://localhost:${freshHandle.port}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;
    const res = await fetch(`http://localhost:${freshHandle.port}/api/channels/${chId}/inputs/next`, { method: "POST" });
    expect(res.status).toBe(204);
    await freshHandle.close();
  });

  it("drains all queued inputs at once", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    await fetch(`${url}/api/channels/${chId}/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first" }),
    });
    await fetch(`${url}/api/channels/${chId}/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second" }),
    });

    const res = await fetch(`${url}/api/channels/${chId}/inputs/next`, { method: "POST" });
    expect(res.status).toBe(200);
    const inputs = await res.json() as Array<{ message: string }>;
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.message).toBe("first");
    expect(inputs[1]!.message).toBe("second");

    // Queue is now empty
    const res2 = await fetch(`${url}/api/channels/${chId}/inputs/next`, { method: "POST" });
    expect(res2.status).toBe(204);

    await freshHandle.close();
  });
});

describe("POST /api/channels/:channelId/replies", () => {
  it("attaches a reply to an input", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const inputRes = await fetch(`${url}/api/channels/${chId}/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "question" }),
    });
    const { id } = await inputRes.json() as { id: string };

    const replyRes = await fetch(`${url}/api/channels/${chId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputId: id, message: "answer" }),
    });
    expect(replyRes.status).toBe(200);
    const body = await replyRes.json() as { reply: { message: string } };
    expect(body.reply.message).toBe("answer");

    await freshHandle.close();
  });

  it("returns 400 when fields are missing", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputId: "id" }),
    });
    expect(res.status).toBe(400);
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
  it("returns gateway status and null agent when no agent manager", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { gateway: { status: string }; agent: null };
    expect(body.gateway.status).toBe("running");
    expect(body.agent).toBeNull();
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

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
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

  it("returns user inputs as messages with sender=user", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    await fetch(`${url}/api/channels/${chId}/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello from user" }),
    });

    const res = await fetch(`${url}/api/channels/${chId}/messages`);
    expect(res.status).toBe(200);
    const msgs = await res.json() as Array<{ sender: string; message: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender).toBe("user");
    expect(msgs[0]!.message).toBe("hello from user");
    await freshHandle.close();
  });

  it("respects the limit query parameter", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    for (let i = 1; i <= 4; i++) {
      await fetch(`${url}/api/channels/${chId}/inputs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `msg-${i}` }),
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

describe("POST /api/channels/:channelId/messages", () => {
  it("adds an agent message and returns 201", async () => {
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
    const msg = await res.json() as { id: string; sender: string; message: string; channelId: string };
    expect(msg.sender).toBe("agent");
    expect(msg.message).toBe("hello from agent");
    expect(msg.channelId).toBe(chId);
    await freshHandle.close();
  });

  it("returns 400 when message field is missing", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "agent" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/nonexistent/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "agent", message: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});
