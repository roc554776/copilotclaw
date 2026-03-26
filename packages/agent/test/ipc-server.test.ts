import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenIpc } from "../src/ipc-server.js";

function randomSocketPath(): string {
  return join(tmpdir(), `copilotclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function sendIpcRequest(socketPath: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      socket.write(JSON.stringify({ method, params }) + "\n");
    });
    let buffer = "";
    socket.on("data", (data: Buffer) => {
      buffer += data.toString();
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe("IPC server", () => {
  it("starts and responds to status with version, bootId, startedAt, and empty sessions", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    expect(result.kind).toBe("server");
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const status = await sendIpcRequest(path, "status");
    expect(status["version"]).toBeTruthy();
    expect(status["bootId"]).toBeTruthy();
    expect(typeof status["bootId"]).toBe("string");
    expect(status["startedAt"]).toBeTruthy();
    expect(status["sessions"]).toEqual({});
  });

  it("handles stop request", async () => {
    const path = randomSocketPath();
    const onStop = vi.fn();
    const result = await listenIpc(path, onStop);
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "stop");
    expect(res["ok"]).toBe(true);
    expect(onStop).toHaveBeenCalled();
  });

  it("responds to session_status for non-existent session", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "session_status", { sessionId: "nonexistent" });
    expect(res["status"]).toBe("not_running");
  });

  it("returns error for session_status without sessionId", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "session_status");
    expect(res["error"]).toBe("missing sessionId");
  });

  it("responds to quota with error when no session manager", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "quota");
    expect(res["error"]).toBeTruthy();
  });

  it("responds to models with error when no session manager", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "models");
    expect(res["error"]).toBeTruthy();
  });

  it("responds to session_messages with error when no session manager", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "session_messages", { sessionId: "nonexistent" });
    expect(res["error"]).toBeTruthy();
  });

  it("responds to session_messages with error when sessionId is missing", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "session_messages");
    expect(res["error"]).toBe("missing sessionId");
  });

  it("detects already-running instance", async () => {
    const path = randomSocketPath();
    const result1 = await listenIpc(path, () => {});
    if (result1.kind !== "server") return;
    cleanup = () => result1.handle.close();

    const result2 = await listenIpc(path, () => {});
    expect(result2.kind).toBe("already-running");
  });

  it("recovers from stale socket", async () => {
    const path = randomSocketPath();
    const result1 = await listenIpc(path, () => {});
    if (result1.kind !== "server") return;
    result1.handle.server.close();

    const result2 = await listenIpc(path, () => {});
    expect(result2.kind).toBe("server");
    if (result2.kind === "server") {
      cleanup = () => result2.handle.close();
    }
  });
});
