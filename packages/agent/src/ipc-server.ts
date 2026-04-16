import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type Server, createConnection, createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PhysicalSessionManager } from "./physical-session-manager.js";
import { reduceSendQueue, reduceRpc } from "./ipc-reducers.js";
import type { SendQueueState, RpcState, RpcEvent, SendQueueEvent, QueuedMessage } from "./ipc-events.js";

let queueIdCounter = 0;
function nextQueueId(): string {
  return `q${++queueIdCounter}`;
}

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
  setSessionManager: (mgr: PhysicalSessionManager) => void;
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

// RPC reducer world state (v0.82.0) — tracks pending request metadata
let rpcState: RpcState = { pendingRequests: [], connectionStatus: "connected" };

function dispatchRpcEvent(event: RpcEvent): void {
  const { newState, commands } = reduceRpc(rpcState, event);
  rpcState = newState;
  for (const cmd of commands) {
    if (cmd.type === "RejectRequest") {
      const pending = pendingRequests.get(cmd.requestId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending.reject(new Error(cmd.error));
        pendingRequests.delete(cmd.requestId);
      }
    }
    // ReplayPendingRequests: pending requests are tracked in rpcState for observability
  }
}

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

// --- Send queue: buffer messages when gateway stream is disconnected ---
// Messages are persisted to disk so they survive agent process restarts.
// On stream (re)connect, the queue is flushed before new messages are sent.
//
// ACK protocol (v0.79.0, reducer-managed v0.82.0):
// - Each buffered message is assigned a _queueId at enqueue time.
// - flushSendQueue() sends all queued messages and registers their IDs in pendingAckIds.
//   The disk file is NOT cleared on flush — it is only cleared once all ACKs are received.
// - When gateway receives a message, it sends message_acknowledged { queueId } back.
// - acknowledgeMessage(queueId) removes the ID from pendingAckIds.
//   When pendingAckIds becomes empty, the disk file is cleared.
// - This ensures no messages are lost even if the agent crashes between flush and ACK.
//
// v0.82.0: state mutations now go through reduceSendQueue (pure function).

export let maxQueueSize = 10_000; // default; overridden by gateway config via setMaxQueueSize()

// SendQueue reducer state (replaces direct mutable variables)
let sendQueueState: SendQueueState = {
  messages: [],
  flushInProgress: false,
  pendingAckIds: [],
};

// Convenience accessors for backward-compatible code
/** @internal use sendQueueState.messages directly in new code */
function getSendQueue(): Array<Record<string, unknown>> {
  return sendQueueState.messages as Array<Record<string, unknown>>;
}

/** Expose the current SendQueue world state (for testing / observability). */
export function getSendQueueState(): SendQueueState {
  return sendQueueState;
}

let sendQueuePath: string | null = null; // set by initSendQueue()

/** Dispatch a SendQueueEvent through the reducer and apply effects. */
function dispatchSendQueueEvent(event: SendQueueEvent): void {
  const { newState, commands } = reduceSendQueue(sendQueueState, event);
  sendQueueState = newState;
  // Execute commands
  for (const cmd of commands) {
    if (cmd.type === "PersistQueue") {
      persistQueue();
    } else if (cmd.type === "ClearDisk") {
      if (sendQueuePath !== null) {
        try { writeFileSync(sendQueuePath, "", "utf-8"); } catch { /* non-fatal */ }
      }
    }
  }
}

/** Set the max queue size from gateway config. */
export function setMaxQueueSize(size: number): void {
  maxQueueSize = size;
}

/** Initialize the persistent send queue. Call once after config is received.
 *  Loads any buffered messages from a previous agent run. */
export function initSendQueue(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  sendQueuePath = join(dataDir, "send-queue.jsonl");
  // Restore from disk
  if (existsSync(sendQueuePath)) {
    try {
      const raw = readFileSync(sendQueuePath, "utf-8");
      let loaded: Array<Record<string, unknown>> = [];
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          loaded.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // skip malformed line
        }
      }
      // Enforce size limit after loading
      if (loaded.length > maxQueueSize) {
        loaded = loaded.slice(loaded.length - maxQueueSize);
      }
      // Restore state via reducer event — startup restoration from persisted disk state.
      // pendingAckIds is intentionally cleared by the Initialized handler: disk-restored
      // messages use _queueId-based ACK tracking re-established on the next stream flush.
      dispatchSendQueueEvent({ type: "Initialized", messages: loaded as QueuedMessage[] });
    } catch {
      // file read error — start with empty queue
    }
  }
}

/** Persist the entire queue to disk (atomic write). */
function persistQueue(): void {
  if (sendQueuePath === null) return;
  try {
    const q = sendQueueState.messages;
    const content = q.map((m) => JSON.stringify(m)).join("\n") + (q.length > 0 ? "\n" : "");
    writeFileSync(sendQueuePath, content, "utf-8");
  } catch {
    // disk error — non-fatal, queue is still in memory
  }
}


/** Flush all queued messages to the stream. Called on stream connect.
 *  Routes through the SendQueue reducer (v0.82.0).
 *  Registers flushed message IDs in pendingAckIds — disk is NOT cleared here.
 *  Disk is cleared once all ACKs are received via acknowledgeMessage().
 *  If all flushed messages lack _queueId (e.g. old-format messages from a pre-ACK agent),
 *  the disk is cleared immediately since there is nothing to ACK. */
export function flushSendQueue(): void {
  if (streamSocket === null || streamSocket.destroyed) return;
  const q = getSendQueue();
  if (q.length === 0) return;

  const batchIds: string[] = [];
  for (const msg of q) {
    const queueId = msg["_queueId"];
    if (typeof queueId === "string") {
      batchIds.push(queueId);
    }
  }

  // Send all messages over the socket
  for (const msg of q) {
    streamSocket.write(JSON.stringify(msg) + "\n");
  }

  if (batchIds.length > 0) {
    dispatchSendQueueEvent({ type: "FlushStarted", batchIds });
  } else {
    // No ACK IDs — old-format messages (pre-ACK) sent. Clear state and disk via reducer.
    dispatchSendQueueEvent({ type: "LegacyFlushCompleted" });
  }
}

/** Send a fire-and-forget message to the gateway via the stream.
 *  If stream is disconnected, buffer in the send queue for later delivery.
 *  Buffered messages are assigned a _queueId for ACK tracking. */
export function sendToGateway(msg: Record<string, unknown>): void {
  if (streamSocket === null || streamSocket.destroyed) {
    // Stream not connected — buffer for later delivery via reducer
    const buffered = { ...msg, _queueId: nextQueueId() };
    // Enforce size limit before enqueuing
    if (sendQueueState.messages.length >= maxQueueSize) {
      // Queue full — evict oldest and add new via reducer (eviction policy).
      dispatchSendQueueEvent({ type: "QueueOverflowed", message: buffered as QueuedMessage });
    } else {
      // Reducer issues PersistQueue command which calls persistQueue() for full rewrite.
      dispatchSendQueueEvent({ type: "MessageEnqueued", message: buffered as QueuedMessage });
    }
    return;
  }
  streamSocket.write(JSON.stringify(msg) + "\n");
}

/** Acknowledge receipt of a queued message.
 *  Routes through the SendQueue reducer (v0.82.0).
 *  When all pending ACKs are cleared, the disk file is truncated. */
export function acknowledgeMessage(queueId: string): void {
  dispatchSendQueueEvent({ type: "MessageAcknowledged", messageId: queueId });
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
      dispatchRpcEvent({ type: "RequestTimedOut", requestId: id });
      reject(new Error("IPC stream request timed out"));
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    pendingRequests.set(id, { resolve, reject, timer });
    // Register in RPC reducer world state
    dispatchRpcEvent({
      type: "RequestSent",
      requestId: id,
      method: String(msg["type"] ?? "unknown"),
      payload: msg,
      sentAt: new Date().toISOString(),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
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
      dispatchRpcEvent({ type: "ResponseReceived", requestId: msg["id"], data: msg["data"] });
      if (msg["error"] !== undefined) {
        pending.reject(new Error(String(msg["error"])));
      } else {
        pending.resolve(msg["data"]);
      }
    }
    return;
  }

  // ACK for a buffered message: gateway has persisted the message, safe to clear disk.
  if (type === "message_acknowledged" && typeof msg["queueId"] === "string") {
    acknowledgeMessage(msg["queueId"]);
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
  sessionManagerRef: { current: PhysicalSessionManager | null },
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
          // Notify reducers of connection restore
          dispatchSendQueueEvent({ type: "ConnectionRestored" });
          dispatchRpcEvent({ type: "ConnectionRestored" });
          streamEvents.emit("stream_connected");

          // When stream disconnects, clean up
          const cleanup = () => {
            if (streamSocket === socket) {
              streamSocket = null;
              // Notify reducers of connection loss
              dispatchSendQueueEvent({ type: "ConnectionLost" });
              // RPC reducer handles reject commands for all pending requests
              dispatchRpcEvent({ type: "ConnectionLost" });
            }
          };
          socket.on("close", cleanup);
          socket.on("error", cleanup);

          continue;
        }

        switch (req.method) {
          case "status": {
            const sessions = sessionManagerRef.current?.getPhysicalSessionStatuses() ?? {};
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
            const info = sessionManagerRef.current?.getPhysicalSessionStatus(sessionId);
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
            if (sessionManagerRef.current !== null) {
              sessionManagerRef.current.getQuota().then((quota) => {
                socket.write(JSON.stringify(quota ?? { error: "no active session" }) + "\n");
              }).catch(() => {
                socket.write(JSON.stringify({ error: "quota fetch failed" }) + "\n");
              });
            } else {
              socket.write(JSON.stringify({ error: "no session manager" }) + "\n");
            }
            break;
          case "models":
            if (sessionManagerRef.current !== null) {
              sessionManagerRef.current.getModels().then((models) => {
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
            if (sessionManagerRef.current !== null) {
              sessionManagerRef.current.getPhysicalSessionMessages(sid).then((messages) => {
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

function createHandle(server: Server, socketPath: string, state: AgentIpcState, sessionManagerRef: { current: PhysicalSessionManager | null }): AgentIpcServerHandle {
  return {
    server,
    socketPath,
    state,
    setSessionManager: (mgr: PhysicalSessionManager) => { sessionManagerRef.current = mgr; },
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
  sessionManager?: PhysicalSessionManager | null,
): Promise<ListenResult> {
  const sessionManagerRef = { current: sessionManager ?? null };
  const state: AgentIpcState = {
    bootId: randomUUID(),
    startedAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      handleConnection(socket, state, sessionManagerRef, onStop);
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
              handleConnection(socket, state, sessionManagerRef, onStop);
            });
            freshServer.on("error", (retryErr) => { reject(retryErr); });
            freshServer.listen(socketPath, () => {
              resolve({ kind: "server", handle: createHandle(freshServer, socketPath, state, sessionManagerRef) });
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
      resolve({ kind: "server", handle: createHandle(server, socketPath, state, sessionManagerRef) });
    });
  });
}
