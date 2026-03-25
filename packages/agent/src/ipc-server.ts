import { type Server, createConnection, createServer, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionManager } from "./agent-session-manager.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(readFileSync(join(thisDir, "..", "package.json"), "utf-8")) as { version: string };
const AGENT_VERSION = pkgJson.version;

export interface AgentIpcState {
  startedAt: string;
}

export interface AgentIpcServerHandle {
  server: Server;
  socketPath: string;
  state: AgentIpcState;
  close: () => Promise<void>;
}

interface IpcRequest {
  method: string;
  params?: Record<string, unknown>;
}

function handleConnection(
  socket: Socket,
  state: AgentIpcState,
  sessionManager: AgentSessionManager | null,
  onStop: () => void,
): void {
  let buffer = "";

  socket.on("error", () => { /* suppress client disconnect errors */ });

  socket.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const req = JSON.parse(line) as IpcRequest;
        switch (req.method) {
          case "status": {
            const sessions = sessionManager?.getSessionStatuses() ?? {};
            socket.write(JSON.stringify({
              version: AGENT_VERSION,
              startedAt: state.startedAt,
              sessions,
            }) + "\n");
            break;
          }
          case "session_status": {
            const sessionId = req.params?.["sessionId"] as string | undefined;
            if (sessionId === undefined) {
              socket.write(JSON.stringify({ error: "missing sessionId" }) + "\n");
              break;
            }
            const info = sessionManager?.getSessionStatus(sessionId);
            if (info === undefined) {
              socket.write(JSON.stringify({ status: "not_running" }) + "\n");
            } else {
              socket.write(JSON.stringify(info) + "\n");
            }
            break;
          }
          case "stop":
            socket.write(JSON.stringify({ ok: true }) + "\n", () => {
              socket.destroy();
              onStop();
            });
            break;
          default:
            socket.write(JSON.stringify({ error: "unknown method" }) + "\n");
        }
      } catch {
        socket.write(JSON.stringify({ error: "invalid json" }) + "\n");
      }
    }
  });
}

export type ListenResult =
  | { kind: "server"; handle: AgentIpcServerHandle }
  | { kind: "already-running" };

function createHandle(server: Server, socketPath: string, state: AgentIpcState): AgentIpcServerHandle {
  return {
    server,
    socketPath,
    state,
    close: () => {
      const closePromise = new Promise<void>((res) => {
        server.close(() => {
          try { unlinkSync(socketPath); } catch {}
          res();
        });
      });
      const timeout = new Promise<void>((res) => {
        const t = setTimeout(() => {
          try { unlinkSync(socketPath); } catch {}
          res();
        }, 3000);
        t.unref();
      });
      return Promise.race([closePromise, timeout]);
    },
  };
}

export function listenIpc(
  socketPath: string,
  onStop: () => void,
  sessionManager?: AgentSessionManager | null,
): Promise<ListenResult> {
  const mgr = sessionManager ?? null;
  const state: AgentIpcState = {
    startedAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      handleConnection(socket, state, mgr, onStop);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const probe = createConnection(socketPath, () => {
          probe.end();
          server.close();
          resolve({ kind: "already-running" });
        });
        probe.on("error", (probeErr: NodeJS.ErrnoException) => {
          if (probeErr.code === "ECONNREFUSED") {
            // Stale socket — close original server, unlink and create a fresh one
            server.close();
            try { unlinkSync(socketPath); } catch {}
            const freshServer = createServer((socket) => {
              handleConnection(socket, state, mgr, onStop);
            });
            freshServer.on("error", (retryErr) => { reject(retryErr); });
            freshServer.listen(socketPath, () => {
              resolve({ kind: "server", handle: createHandle(freshServer, socketPath, state) });
            });
          } else {
            resolve({ kind: "already-running" });
          }
        });
        return;
      }
      reject(err);
    });

    server.listen(socketPath, () => {
      resolve({ kind: "server", handle: createHandle(server, socketPath, state) });
    });
  });
}
