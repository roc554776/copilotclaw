import { type Server, createConnection, createServer, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import type { ChannelSessionManager } from "./channel-session-manager.js";

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
  sessionManager: ChannelSessionManager | null,
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
            const channels = sessionManager?.getChannelStatuses() ?? {};
            socket.write(JSON.stringify({
              startedAt: state.startedAt,
              channels,
            }) + "\n");
            break;
          }
          case "channel_status": {
            const channelId = req.params?.["channelId"] as string | undefined;
            if (channelId === undefined) {
              socket.write(JSON.stringify({ error: "missing channelId" }) + "\n");
              break;
            }
            const info = sessionManager?.getChannelStatus(channelId);
            if (info === undefined) {
              socket.write(JSON.stringify({ status: "not_running" }) + "\n");
            } else {
              socket.write(JSON.stringify(info) + "\n");
            }
            break;
          }
          case "stop":
            socket.write(JSON.stringify({ ok: true }) + "\n");
            socket.end();
            onStop();
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
    close: () => new Promise<void>((res) => {
      server.close(() => {
        try { unlinkSync(socketPath); } catch {}
        res();
      });
    }),
  };
}

export function listenIpc(
  socketPath: string,
  onStop: () => void,
  sessionManager?: ChannelSessionManager | null,
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
