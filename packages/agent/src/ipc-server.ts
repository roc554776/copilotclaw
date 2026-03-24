import { type Server, createConnection, createServer, type Socket } from "node:net";
import { unlinkSync } from "node:fs";

export type AgentStatus = "starting" | "waiting" | "processing";

export interface AgentIpcState {
  status: AgentStatus;
  startedAt: string;
  restartedAt?: string;
}

export interface AgentIpcServerHandle {
  server: Server;
  socketPath: string;
  state: AgentIpcState;
  close: () => Promise<void>;
}

export type RestartHandler = () => void;

function handleConnection(socket: Socket, state: AgentIpcState, onStop: () => void, onRestart: RestartHandler): void {
  let buffer = "";

  socket.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const req = JSON.parse(line) as { method: string };
        switch (req.method) {
          case "status":
            socket.write(JSON.stringify({
              status: state.status,
              startedAt: state.startedAt,
              restartedAt: state.restartedAt,
            }) + "\n");
            break;
          case "stop":
            socket.write(JSON.stringify({ ok: true }) + "\n");
            socket.end();
            onStop();
            break;
          case "restart":
            socket.write(JSON.stringify({ ok: true }) + "\n");
            socket.end();
            onRestart();
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

export function listenIpc(
  socketPath: string,
  onStop: () => void,
  onRestart: RestartHandler,
): Promise<ListenResult> {
  return new Promise((resolve) => {
    const state: AgentIpcState = {
      status: "starting",
      startedAt: new Date().toISOString(),
    };

    const server = createServer((socket) => {
      handleConnection(socket, state, onStop, onRestart);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try to connect to verify it's alive
        const probe = createConnection(socketPath, () => {
          // Connected — existing agent is alive
          probe.end();
          resolve({ kind: "already-running" });
        });
        probe.on("error", (probeErr: NodeJS.ErrnoException) => {
          if (probeErr.code === "ECONNREFUSED") {
            // Stale socket — unlink and retry once
            try { unlinkSync(socketPath); } catch {}
            server.listen(socketPath, () => {
              resolve({
                kind: "server",
                handle: {
                  server,
                  socketPath,
                  state,
                  close: () => new Promise<void>((res) => {
                    server.close(() => {
                      try { unlinkSync(socketPath); } catch {}
                      res();
                    });
                  }),
                },
              });
            });
          } else {
            // Unexpected error — treat as already running
            resolve({ kind: "already-running" });
          }
        });
        return;
      }
      throw err;
    });

    server.listen(socketPath, () => {
      resolve({
        kind: "server",
        handle: {
          server,
          socketPath,
          state,
          close: () => new Promise<void>((res) => {
            server.close(() => {
              try { unlinkSync(socketPath); } catch {}
              res();
            });
          }),
        },
      });
    });
  });
}
