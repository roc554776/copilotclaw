import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ServerHandle, startServer } from "../../src/server.js";
import { Store } from "../../src/store.js";
import { SessionEventStore } from "../../src/session-event-store.js";

let handle: ServerHandle;
let baseUrl: string;
let defaultChannelId: string;
let tmpDir: string;
let sessionEventStore: SessionEventStore;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-e2e-"));
  sessionEventStore = new SessionEventStore(tmpDir);
  handle = await startServer({ port: 0, store: new Store(), agentManager: null, sessionEventStore });
  baseUrl = `http://localhost:${handle.port}`;
  const channels = await (await fetch(`${baseUrl}/api/channels`)).json() as Array<{ id: string }>;
  defaultChannelId = channels[0]!.id;
});

afterAll(async () => {
  await handle.close();
  sessionEventStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
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

  it("returns 400 when sender is missing", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "no sender" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("sender");
  });

  it("returns 400 when sender is invalid", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "invalid", message: "bad sender" }),
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

describe("POST /api/channels/:channelId/messages (system message)", () => {
  it("accepts system sender and stores the message", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const res = await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "system", message: "[SUBAGENT COMPLETED] worker completed" }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json() as { sender: string; message: string };
    expect(msg.sender).toBe("system");
    expect(msg.message).toBe("[SUBAGENT COMPLETED] worker completed");
    await freshHandle.close();
  });

  it("system sender stores message but does not start session", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const res = await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "system", message: "[SUBAGENT COMPLETED] worker completed" }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json() as { sender: string };
    expect(msg.sender).toBe("system");

    await freshHandle.close();
  });
});

describe("POST /api/channels/:channelId/messages (cron sender)", () => {
  it("accepts cron sender and stores message", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const res = await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "cron", message: "[cron:test] task" }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json() as { sender: string };
    expect(msg.sender).toBe("cron");

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

describe("GET / (dashboard)", () => {
  it("returns HTML for dashboard (SPA or server-rendered)", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // SPA serves index.html with <div id="root">, legacy serves status-bar inline
    expect(html.includes("root") || html.includes("status-bar")).toBe(true);
  });
});

describe("GET /api/quota", () => {
  it("returns 200 with empty quota when no active session", async () => {
    const res = await fetch(`${baseUrl}/api/quota`);
    expect(res.status).toBe(200);
    const body = await res.json() as { quotaSnapshots?: Record<string, unknown>; githubUsage?: unknown };
    expect(body.quotaSnapshots).toBeDefined();
  });

  it("includes githubUsage field (null when no auth configured)", async () => {
    const res = await fetch(`${baseUrl}/api/quota`);
    expect(res.status).toBe(200);
    const body = await res.json() as { githubUsage?: unknown };
    // Without auth config, githubUsage should be null
    expect(body.githubUsage).toBeNull();
  });
});

describe("GET /api/models", () => {
  it("returns 200 with models array when no active session", async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as { models: unknown[]; githubModels?: unknown };
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("includes githubModels field (null when no auth configured)", async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as { githubModels?: unknown };
    // Without auth config, githubModels should be null
    expect(body.githubModels).toBeNull();
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

describe("PATCH /api/channels/:id (archive/unarchive)", () => {
  it("archives a channel", async () => {
    const create = await fetch(`${baseUrl}/api/channels`, { method: "POST" });
    const ch = await create.json() as { id: string };
    const res = await fetch(`${baseUrl}/api/channels/${ch.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as { id: string; archivedAt: string };
    expect(updated.archivedAt).toBeTruthy();
  });

  it("unarchives a channel", async () => {
    const create = await fetch(`${baseUrl}/api/channels`, { method: "POST" });
    const ch = await create.json() as { id: string };
    await fetch(`${baseUrl}/api/channels/${ch.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    const res = await fetch(`${baseUrl}/api/channels/${ch.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as { id: string; archivedAt: string | null };
    expect(updated.archivedAt).toBeNull();
  });

  it("returns 404 for nonexistent channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/nonexistent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 for empty body (no-op PATCH)", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid body", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/channels?includeArchived", () => {
  it("excludes archived channels by default", async () => {
    const create = await fetch(`${baseUrl}/api/channels`, { method: "POST" });
    const ch = await create.json() as { id: string };
    await fetch(`${baseUrl}/api/channels/${ch.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    const res = await fetch(`${baseUrl}/api/channels`);
    const channels = await res.json() as Array<{ id: string }>;
    expect(channels.find((c) => c.id === ch.id)).toBeUndefined();
  });

  it("includes archived channels when includeArchived=true", async () => {
    const create = await fetch(`${baseUrl}/api/channels`, { method: "POST" });
    const ch = await create.json() as { id: string };
    await fetch(`${baseUrl}/api/channels/${ch.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    const res = await fetch(`${baseUrl}/api/channels?includeArchived=true`);
    const channels = await res.json() as Array<{ id: string }>;
    expect(channels.find((c) => c.id === ch.id)).toBeDefined();
  });
});

describe("GET /api/channels/pending", () => {
  it("returns pending counts for all channels", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    // Add a user message to create pending
    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "pending msg" }),
    });

    const res = await fetch(`${url}/api/channels/pending`);
    expect(res.status).toBe(200);
    const counts = await res.json() as Record<string, number>;
    expect(counts[chId]).toBe(1);

    await freshHandle.close();
  });

  it("returns 0 for channels with no pending messages", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const res = await fetch(`${url}/api/channels/pending`);
    const counts = await res.json() as Record<string, number>;
    expect(counts[chId]).toBe(0);

    await freshHandle.close();
  });
});

describe("GET /api/channels/:channelId/messages/pending/peek", () => {
  it("returns 204 when no pending messages", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const res = await fetch(`${url}/api/channels/${chId}/messages/pending/peek`);
    expect(res.status).toBe(204);

    await freshHandle.close();
  });

  it("returns oldest pending message without removing it", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "oldest" }),
    });
    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "newer" }),
    });

    const res = await fetch(`${url}/api/channels/${chId}/messages/pending/peek`);
    expect(res.status).toBe(200);
    const msg = await res.json() as { message: string };
    expect(msg.message).toBe("oldest");

    // Should still be pending (peek does not remove)
    const res2 = await fetch(`${url}/api/channels/${chId}/messages/pending/peek`);
    expect(res2.status).toBe(200);

    await freshHandle.close();
  });
});

describe("POST /api/channels/:channelId/messages/pending/flush", () => {
  it("flushes all pending messages and returns count", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store(), agentManager: null });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "a" }),
    });
    await fetch(`${url}/api/channels/${chId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "user", message: "b" }),
    });

    const res = await fetch(`${url}/api/channels/${chId}/messages/pending/flush`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { flushed: number };
    expect(body.flushed).toBe(2);

    // Queue should be empty now
    const res2 = await fetch(`${url}/api/channels/${chId}/messages/pending`, { method: "POST" });
    expect(res2.status).toBe(204);

    await freshHandle.close();
  });
});

describe("unknown channel action", () => {
  it("returns 404 for unknown action on valid channel", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown channel action");
  });
});

describe("GET /api/channels/:channelId/messages with before cursor", () => {
  it("returns messages older than cursor", async () => {
    const url = baseUrl;
    const chRes = await fetch(`${url}/api/channels`, { method: "POST" });
    const ch = await chRes.json() as { id: string };
    const chId = ch.id;

    // Add 5 messages
    const msgIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${url}/api/channels/${chId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "user", message: `msg-${i}` }),
      });
      const m = await r.json() as { id: string };
      msgIds.push(m.id);
    }

    // Fetch messages before the 3rd message (index 2)
    const res = await fetch(`${url}/api/channels/${chId}/messages?limit=10&before=${msgIds[2]}`);
    expect(res.status).toBe(200);
    const msgs = await res.json() as Array<{ message: string }>;
    // Should return msg-1 and msg-0 (older than msg-2)
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.message).toBe("msg-1");
    expect(msgs[1]!.message).toBe("msg-0");
  });
});

describe("GET /api/token-usage", () => {
  it("returns 200 with token usage array", async () => {
    const res = await fetch(`${baseUrl}/api/token-usage?hours=5`);
    expect(res.status).toBe(200);
    const data = await res.json() as Array<{ model: string; inputTokens: number; outputTokens: number }>;
    expect(Array.isArray(data)).toBe(true);
  });

  it("accepts from and to params", async () => {
    const res = await fetch(`${baseUrl}/api/token-usage?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z`);
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("GET /api/token-usage/timeseries", () => {
  it("returns 200 with timeseries array", async () => {
    const res = await fetch(`${baseUrl}/api/token-usage/timeseries?hours=1&points=4`);
    expect(res.status).toBe(200);
    const data = await res.json() as Array<{ timestamp: string; models: unknown[]; index: number }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(4);
    expect(data[0]).toHaveProperty("timestamp");
    expect(data[0]).toHaveProperty("models");
    expect(data[0]).toHaveProperty("index");
  });

  it("includes movingAverage when window is specified", async () => {
    const res = await fetch(`${baseUrl}/api/token-usage/timeseries?hours=1&points=4&movingAverageWindow=1800`);
    expect(res.status).toBe(200);
    const data = await res.json() as Array<{ movingAverage?: number }>;
    expect(data[0]).toHaveProperty("movingAverage");
  });
});

describe("PATCH /api/channels/:id (model setting)", () => {
  it("sets channel model", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1" }),
    });
    expect(res.status).toBe(200);
    const ch = await res.json() as { id: string; model: string | null };
    expect(ch.model).toBe("gpt-4.1");
  });

  it("clears channel model with null", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: null }),
    });
    expect(res.status).toBe(200);
    const ch = await res.json() as { id: string; model: string | null };
    expect(ch.model).toBeNull();
  });

  it("returns 400 for non-string/null model", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: 123 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/cron", () => {
  it("returns empty list when no cron functions provided", async () => {
    const res = await fetch(`${baseUrl}/api/cron`);
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });
});

describe("POST /api/cron/reload", () => {
  it("returns 503 when no cron reload handler", async () => {
    const res = await fetch(`${baseUrl}/api/cron/reload`, { method: "POST" });
    expect(res.status).toBe(503);
  });
});

describe("PUT /api/cron", () => {
  it("returns 503 when no saveCronJobs handler", async () => {
    const res = await fetch(`${baseUrl}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(503);
  });

  it("returns 503 for non-array body (no handler)", async () => {
    const res = await fetch(`${baseUrl}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test" }),
    });
    // Without saveCronJobs handler, returns 503 before validation
    expect(res.status).toBe(503);
  });

  it("saves valid cron jobs when handler is provided", async () => {
    const saved: unknown[] = [];
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: (jobs) => { saved.push(jobs); },
    });
    const url = `http://localhost:${freshHandle.port}`;
    const channels = await (await fetch(`${url}/api/channels`)).json() as Array<{ id: string }>;
    const chId = channels[0]!.id;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: "test-job", channelId: chId, intervalMs: 60000, message: "hello" }]),
    });
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    await freshHandle.close();
  });

  it("accepts empty array (delete all jobs)", async () => {
    const saved: unknown[] = [];
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: (jobs) => { saved.push(jobs); },
    });
    const url = `http://localhost:${freshHandle.port}`;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    await freshHandle.close();
  });

  it("rejects non-array body", async () => {
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: () => {},
    });
    const url = `http://localhost:${freshHandle.port}`;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test" }),
    });
    expect(res.status).toBe(400);
    await freshHandle.close();
  });

  it("rejects job with missing fields", async () => {
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: () => {},
    });
    const url = `http://localhost:${freshHandle.port}`;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: "test" }]),
    });
    expect(res.status).toBe(400);
    await freshHandle.close();
  });

  it("rejects job with empty id", async () => {
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: () => {},
    });
    const url = `http://localhost:${freshHandle.port}`;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: "", channelId: "ch1", intervalMs: 60000, message: "hello" }]),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("non-empty");
    await freshHandle.close();
  });

  it("rejects job with intervalMs too small", async () => {
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: () => {},
    });
    const url = `http://localhost:${freshHandle.port}`;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: "test", channelId: "ch1", intervalMs: 100, message: "hello" }]),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("intervalMs");
    await freshHandle.close();
  });

  it("rejects duplicate job IDs", async () => {
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: () => {},
    });
    const url = `http://localhost:${freshHandle.port}`;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { id: "dup", channelId: "ch1", intervalMs: 60000, message: "a" },
        { id: "dup", channelId: "ch1", intervalMs: 60000, message: "b" },
      ]),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("duplicate");
    await freshHandle.close();
  });

  it("rejects non-boolean disabled field", async () => {
    const freshHandle = await startServer({
      port: 0,
      store: new Store(),
      agentManager: null,
      saveCronJobs: () => {},
    });
    const url = `http://localhost:${freshHandle.port}`;

    const res = await fetch(`${url}/api/cron`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: "test", channelId: "ch1", intervalMs: 60000, message: "hello", disabled: "yes" }]),
    });
    expect(res.status).toBe(400);
    await freshHandle.close();
  });
});

describe("POST /api/sessions/:id/end-turn-run", () => {
  it("returns 503 when no agent", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-session/end-turn-run`, { method: "POST" });
    expect(res.status).toBe(503);
  });
});

describe("PUT /api/channels/:id/draft", () => {
  it("saves and retrieves a draft", async () => {
    const putRes = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: "hello draft" }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/draft`);
    expect(getRes.status).toBe(200);
    const data = await getRes.json() as { draft: string | null };
    expect(data.draft).toBe("hello draft");
  });

  it("clears draft with null", async () => {
    await fetch(`${baseUrl}/api/channels/${defaultChannelId}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: null }),
    });
    const getRes = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/draft`);
    const data = await getRes.json() as { draft: string | null };
    expect(data.draft).toBeNull();
  });

  it("returns 400 for invalid draft type", async () => {
    const res = await fetch(`${baseUrl}/api/channels/${defaultChannelId}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: 123 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
