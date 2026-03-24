import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, startServer } from "../../src/server.js";
import { Store } from "../../src/store.js";

let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  handle = await startServer({ port: 0, store: new Store() });
  baseUrl = `http://localhost:${handle.port}`;
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

describe("POST /api/inputs", () => {
  it("creates an input and returns it with id", async () => {
    const res = await fetch(`${baseUrl}/api/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test input" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; message: string };
    expect(body.id).toBeTruthy();
    expect(body.message).toBe("test input");
  });

  it("returns 400 when message is missing", async () => {
    const res = await fetch(`${baseUrl}/api/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/inputs/next", () => {
  it("returns 204 when queue is empty", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store() });
    const res = await fetch(`http://localhost:${freshHandle.port}/api/inputs/next`, {
      method: "POST",
    });
    expect(res.status).toBe(204);
    await freshHandle.close();
  });

  it("dequeues input in FIFO order", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store() });
    const url = `http://localhost:${freshHandle.port}`;

    await fetch(`${url}/api/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first" }),
    });
    await fetch(`${url}/api/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second" }),
    });

    const res1 = await fetch(`${url}/api/inputs/next`, { method: "POST" });
    expect((await res1.json() as { message: string }).message).toBe("first");

    const res2 = await fetch(`${url}/api/inputs/next`, { method: "POST" });
    expect((await res2.json() as { message: string }).message).toBe("second");

    const res3 = await fetch(`${url}/api/inputs/next`, { method: "POST" });
    expect(res3.status).toBe(204);

    await freshHandle.close();
  });
});

describe("POST /api/replies", () => {
  it("attaches a reply to an input", async () => {
    const freshHandle = await startServer({ port: 0, store: new Store() });
    const url = `http://localhost:${freshHandle.port}`;

    const inputRes = await fetch(`${url}/api/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "question" }),
    });
    const { id } = await inputRes.json() as { id: string };

    const replyRes = await fetch(`${url}/api/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputId: id, message: "answer" }),
    });
    expect(replyRes.status).toBe(200);
    const body = await replyRes.json() as { reply: { message: string } };
    expect(body.reply.message).toBe("answer");

    await freshHandle.close();
  });

  it("returns 404 for unknown input id", async () => {
    const res = await fetch(`${baseUrl}/api/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputId: "nonexistent", message: "reply" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when fields are missing", async () => {
    const res = await fetch(`${baseUrl}/api/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputId: "id" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /", () => {
  it("returns HTML dashboard", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("copilotclaw gateway");
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
