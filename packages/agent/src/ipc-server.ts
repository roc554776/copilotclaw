import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
  bootId: string;
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

// --- IPC Stream infrastructure ---

/** Message types pushed from gateway to agent via the stream. */
export interface IpcStreamMessage {
  type: string;
  [key: string]: unknown;
}

/** Event emitter for IPC stream push messages from gateway. */
export const streamEvents = new EventEmitter();

let streamSocket: Socket | null = null;
const pendingRequests = new Map<string, {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/** Set the active stream socket (called internally when a stream connection is established). */
export function setStreamSocket(socket: Socket | null): void {
  streamSocket = socket;
}

/** Get the current stream socket (for testing / debugging). */
export function getStreamSocket(): Socket | null {
  return streamSocket;
}

/** Check if a stream connection is currently active. */
export function hasStream(): boolean {
  return streamSocket !== null && !streamSocket.destroyed;
}

/** Send a fire-and-forget message to the gateway via the stream. */
export function sendToGateway(msg: Record<string, unknown>): void {
  if (streamSocket === null || streamSocket.destroyed) {
    // Stream not connected — drop silently (non-fatal)
    return;
  }
  streamSocket.write(JSON.stringify(msg) + "\n");
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Send a request-response message to the gateway via the stream.
 *  Generates a UUID id, sends the message, and waits for a response with matching id. */
export function requestFromGateway(msg: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (streamSocket === null || streamSocket.destroyed) {
      reject(new Error("IPC stream not connected"));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("IPC stream request timed out"));
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    pendingRequests.set(id, { resolve, reject, timer });
    streamSocket.write(JSON.stringify({ ...msg, id }) + "\n");
  });
}

/** Handle incoming messages on the stream socket (from gateway). */
function handleStreamMessage(msg: Record<string, unknown>): void {
  const type = msg["type"] as string | undefined;

  // Response to a pending request
  if (type === "response" && typeof msg["id"] === "string") {
    const pending = pendingRequests.get(msg["id"]);
    if (pending !== undefined) {
      pendingRequests.delete(msg["id"]);
      clearTimeout(pending.timer);
      if (msg["error"] !== undefined) {
        pending.reject(new Error(String(msg["error"])));
      } else {
        pending.resolve(msg["data"]);
      }
    }
    return;
  }

  // Push message from gateway — emit as event
  if (type !== undefined) {
    streamEvents.emit(type, msg);
    streamEvents.emit("message", msg);
  }
}

function handleConnection(
  socket: Socket,
  state: AgentIpcState,
  sessionManager: AgentSessionManager | null,
  onStop: () => void,
): void {
  let buffer = "";
  let isStream = false;

  socket.on("error", () => { /* suppress client disconnect errors */ });

  socket.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        // If this connection is already a stream, handle as stream messages
        if (isStream) {
          const msg = JSON.parse(line) as Record<string, unknown>;
          handleStreamMessage(msg);
          continue;
        }

        const req = JSON.parse(line) as IpcRequest;

        // Detect stream request — upgrade this connection to a bidirectional stream
        if (req.method === "stream") {
          isStream = true;
          // Close previous stream if any
          if (streamSocket !== null && !streamSocket.destroyed) {
            streamSocket.destroy();
          }
          streamSocket = socket;
          socket.write(JSON.stringify({ ok: true }) + "\n");

          // When stream disconnects, clean up
          const cleanup = () => {
            if (streamSocket === socket) {
              streamSocket = null;
              // Reject all pending requests
              for (const [id, pending] of pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error("IPC stream disconnected"));
                pendingRequests.delete(id);
              }
            }
          };
          socket.on("close", cleanup);
          socket.on("error", cleanup);

          continue;
        }

        switch (req.method) {
          case "status": {
            const sessions = sessionManager?.getSessionStatuses() ?? {};
            socket.write(JSON.stringify({
              version: AGENT_VERSION,
              bootId: state.bootId,
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
          case "quota":
            if (sessionManager !== null) {
              sessionManager.getQuota().then((quota) => {
                socket.write(JSON.stringify(quota ?? { error: "no active session" }) + "\n");
              }).catch(() => {
                socket.write(JSON.stringify({ error: "quota fetch failed" }) + "\n");
              });
            } else {
              socket.write(JSON.stringify({ error: "no session manager" }) + "\n");
            }
            break;
          case "models":
            if (sessionManager !== null) {
              sessionManager.getModels().then((models) => {
                socket.write(JSON.stringify(models ?? { error: "no active session" }) + "\n");
              }).catch(() => {
                socket.write(JSON.stringify({ error: "models fetch failed" }) + "\n");
              });
            } else {
              socket.write(JSON.stringify({ error: "no session manager" }) + "\n");
            }
            break;
          case "session_messages": {
            const sid = req.params?.["sessionId"] as string | undefined;
            if (sid === undefined) {
              socket.write(JSON.stringify({ error: "missing sessionId" }) + "\n");
              break;
            }
            if (sessionManager !== null) {
              sessionManager.getSessionMessages(sid).then((messages) => {
                socket.write(JSON.stringify(messages ?? { error: "session not found" }) + "\n");
              }).catch(() => {
                socket.write(JSON.stringify({ error: "messages fetch failed" }) + "\n");
              });
            } else {
              socket.write(JSON.stringify({ error: "no session manager" }) + "\n");
            }
            break;
          }
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
    bootId: randomUUID(),
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
