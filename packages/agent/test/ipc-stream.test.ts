import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenIpc, streamEvents, sendToGateway, requestFromGateway, hasStream, setStreamSocket, getStreamSocket } from "../src/ipc-server.js";

const SOCKET_BASE = join(import.meta.dirname, "..", "..", "..", "tmp", "test-state", "agent", "ipc-stream-sockets");
mkdirSync(SOCKET_BASE, { recursive: true });

describe("IPC stream — bidirectional messaging", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(SOCKET_BASE, "ipc-stream-test-"));
    socketPath = join(tmpDir, "test.sock");
  });

  afterEach(async () => {
    // Clean up any stream socket
    setStreamSocket(null);
    streamEvents.removeAllListeners();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("establishes stream connection and receives push messages", async () => {
    const result = await listenIpc(socketPath, () => {}, null);
    if (result.kind !== "server") throw new Error("expected server");

    // Connect as gateway with stream handshake
    const { createConnection } = await import("node:net");
    const client = createConnection(socketPath);

    const connected = new Promise<void>((resolve) => {
      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) {
          const response = JSON.parse(buffer.split("\n")[0]!) as { ok: boolean };
          expect(response.ok).toBe(true);
          resolve();
        }
      });
    });

    client.on("connect", () => {
      client.write(JSON.stringify({ method: "stream" }) + "\n");
    });

    await connected;

    // Stream should be connected
    expect(hasStream()).toBe(true);

    // Send a push message from "gateway" to agent
    const configReceived = new Promise<Record<string, unknown>>((resolve) => {
      streamEvents.once("config", (msg: Record<string, unknown>) => {
        resolve(msg);
      });
    });

    client.write(JSON.stringify({ type: "config", config: { model: "test-model" } }) + "\n");

    const configMsg = await configReceived;
    expect(configMsg["config"]).toEqual({ model: "test-model" });

    client.destroy();
    await result.handle.close();
  });

  it("sends fire-and-forget messages to gateway", async () => {
    const result = await listenIpc(socketPath, () => {}, null);
    if (result.kind !== "server") throw new Error("expected server");

    const { createConnection } = await import("node:net");
    const client = createConnection(socketPath);

    const connected = new Promise<void>((resolve) => {
      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) {
          resolve();
        }
      });
    });

    client.on("connect", () => {
      client.write(JSON.stringify({ method: "stream" }) + "\n");
    });

    await connected;

    // Agent sends a message to gateway
    const messageReceived = new Promise<Record<string, unknown>>((resolve) => {
      let buffer = "";
      // Skip the first line (handshake response)
      client.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          resolve(JSON.parse(line) as Record<string, unknown>);
        }
      });
    });

    sendToGateway({ type: "channel_message", sessionId: "sess-test", sender: "agent", message: "hello" });

    const received = await messageReceived;
    expect(received["type"]).toBe("channel_message");
    expect(received["sessionId"]).toBe("sess-test");
    expect(received["message"]).toBe("hello");

    client.destroy();
    await result.handle.close();
  });

  it("handles request-response correlation", async () => {
    const result = await listenIpc(socketPath, () => {}, null);
    if (result.kind !== "server") throw new Error("expected server");

    const { createConnection } = await import("node:net");
    const client = createConnection(socketPath);

    const connected = new Promise<void>((resolve) => {
      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) {
          resolve();
          buffer = "";
        }
      });
    });

    client.on("connect", () => {
      client.write(JSON.stringify({ method: "stream" }) + "\n");
    });

    await connected;

    // Set up handler on gateway side to respond to requests
    let gatewayBuffer = "";
    client.on("data", (data) => {
      gatewayBuffer += data.toString();
      const lines = gatewayBuffer.split("\n");
      gatewayBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg["type"] === "drain_pending" && typeof msg["id"] === "string") {
          // Respond with mock data
          client.write(JSON.stringify({
            type: "response",
            id: msg["id"],
            data: [{ id: "msg-1", message: "test message" }],
          }) + "\n");
        }
      }
    });

    // Agent makes a request
    const response = await requestFromGateway({ type: "drain_pending", sessionId: "sess-test" });
    expect(response).toEqual([{ id: "msg-1", message: "test message" }]);

    client.destroy();
    await result.handle.close();
  });

  it("cleans up on stream disconnect", async () => {
    const result = await listenIpc(socketPath, () => {}, null);
    if (result.kind !== "server") throw new Error("expected server");

    const { createConnection } = await import("node:net");
    const client = createConnection(socketPath);

    const connected = new Promise<void>((resolve) => {
      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) resolve();
      });
    });

    client.on("connect", () => {
      client.write(JSON.stringify({ method: "stream" }) + "\n");
    });

    await connected;
    expect(hasStream()).toBe(true);

    // Disconnect
    client.destroy();

    // Wait for cleanup
    await new Promise((r) => { setTimeout(r, 50); });
    expect(hasStream()).toBe(false);

    await result.handle.close();
  });
});
