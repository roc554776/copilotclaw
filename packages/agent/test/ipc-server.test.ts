import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenIpc } from "../src/ipc-server.js";

function randomSocketPath(): string {
  return join(tmpdir(), `copilotclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function sendIpcRequest(socketPath: string, method: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      socket.write(JSON.stringify({ method }) + "\n");
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
  it("starts and responds to status", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {}, () => {});
    expect(result.kind).toBe("server");
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const status = await sendIpcRequest(path, "status");
    expect(status["status"]).toBe("starting");
    expect(status["startedAt"]).toBeTruthy();
  });

  it("reflects status changes", async () => {
    const path = randomSocketPath();
    const result = await listenIpc(path, () => {}, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    result.handle.state.status = "waiting";
    const status = await sendIpcRequest(path, "status");
    expect(status["status"]).toBe("waiting");

    result.handle.state.status = "processing";
    const status2 = await sendIpcRequest(path, "status");
    expect(status2["status"]).toBe("processing");
  });

  it("handles stop request", async () => {
    const path = randomSocketPath();
    const onStop = vi.fn();
    const result = await listenIpc(path, onStop, () => {});
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "stop");
    expect(res["ok"]).toBe(true);
    expect(onStop).toHaveBeenCalled();
  });

  it("handles restart request", async () => {
    const path = randomSocketPath();
    const onRestart = vi.fn();
    const result = await listenIpc(path, () => {}, onRestart);
    if (result.kind !== "server") return;
    cleanup = () => result.handle.close();

    const res = await sendIpcRequest(path, "restart");
    expect(res["ok"]).toBe(true);
    expect(onRestart).toHaveBeenCalled();
  });

  it("detects already-running instance", async () => {
    const path = randomSocketPath();
    const result1 = await listenIpc(path, () => {}, () => {});
    if (result1.kind !== "server") return;
    cleanup = () => result1.handle.close();

    const result2 = await listenIpc(path, () => {}, () => {});
    expect(result2.kind).toBe("already-running");
  });

  it("recovers from stale socket", async () => {
    const path = randomSocketPath();
    // Create and immediately close to leave a stale socket
    const result1 = await listenIpc(path, () => {}, () => {});
    if (result1.kind !== "server") return;
    // Close server but leave socket file (simulate crash)
    result1.handle.server.close();
    // Don't unlink — that's what "stale" means

    const result2 = await listenIpc(path, () => {}, () => {});
    expect(result2.kind).toBe("server");
    if (result2.kind === "server") {
      cleanup = () => result2.handle.close();
    }
  });
});
