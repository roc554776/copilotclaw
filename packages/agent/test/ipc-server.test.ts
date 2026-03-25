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
  it("starts and responds to status with startedAt and empty channels", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    expect(result.kind).toBe("server");
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const status = await sendIpcRequest(path, "status");
    expect(status["startedAt"]).toBeTruthy();
    expect(status["channels"]).toEqual({});
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

  it("responds to channel_status for non-existent channel", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "channel_status", { channelId: "nonexistent" });
    expect(res["status"]).toBe("not_running");
  });

  it("returns error for channel_status without channelId", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "channel_status");
    expect(res["error"]).toBe("missing channelId");
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
