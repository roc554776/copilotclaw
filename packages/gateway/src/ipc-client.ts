import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type Socket, createConnection } from "node:net";

export interface PhysicalSessionSummary {
  sessionId: string;
  model: string;
  startedAt: string;
  currentState: string;
  currentTokens?: number;
  tokenLimit?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  latestQuotaSnapshots?: Record<string, unknown>;
}

export interface SubagentInfo {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
}

export interface AgentSessionStatusResponse {
  status: "starting" | "waiting" | "processing" | "suspended" | "stopped" | "not_running";
  startedAt?: string;
  processingStartedAt?: string;
  boundChannelId?: string;
  physicalSession?: PhysicalSessionSummary;
  subagentSessions?: SubagentInfo[];
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  physicalSessionHistory?: PhysicalSessionSummary[];
}

export interface AgentStatusResponse {
  version?: string;
  bootId?: string;
  startedAt: string;
  sessions: Record<string, AgentSessionStatusResponse>;
}

function sendIpcRequest(socketPath: string, method: string, params?: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      socket.write(JSON.stringify({ method, params }) + "\n");
    });

    let buffer = "";
    socket.on("data", (data: Buffer) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        socket.destroy();
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line) as unknown);
        } catch {
          reject(new Error("invalid JSON response"));
        }
      }
    });

    socket.on("error", (err) => { reject(err); });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC request timed out"));
    }, timeoutMs);

    socket.on("close", () => { clearTimeout(timer); });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function getAgentStatus(socketPath: string): Promise<AgentStatusResponse | null> {
  try {
    const res = await sendIpcRequest(socketPath, "status");
    return res as AgentStatusResponse;
  } catch {
    return null;
  }
}

export async function getAgentQuota(socketPath: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await sendIpcRequest(socketPath, "quota", undefined, 15000);
    if (!isRecord(res) || "error" in res) return null;
    return res;
  } catch {
    return null;
  }
}

export async function getAgentModels(socketPath: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await sendIpcRequest(socketPath, "models", undefined, 15000);
    if (!isRecord(res) || "error" in res) return null;
    return res;
  } catch {
    return null;
  }
}

export async function getAgentSessionMessages(socketPath: string, sessionId: string): Promise<unknown[] | null> {
  try {
    const res = await sendIpcRequest(socketPath, "session_messages", { sessionId }, 15000);
    if (Array.isArray(res)) return res;
    return null;
  } catch {
    return null;
  }
}

export async function stopAgent(socketPath: string): Promise<boolean> {
  try {
    await sendIpcRequest(socketPath, "stop");
    return true;
  } catch {
    return false;
  }
}

// --- IPC Stream ---

const RECONNECT_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;

export type IpcStreamMessageHandler = (msg: Record<string, unknown>) => void;

/**
 * Persistent bidirectional IPC stream connection to the agent.
 *
 * Opens a connection to the agent's Unix domain socket with `{"method": "stream"}`,
 * then exchanges newline-delimited JSON messages bidirectionally.
 *
 * Reconnects automatically on disconnect.
 */
export class IpcStream extends EventEmitter {
  private readonly socketPath: string;
  private socket: Socket | null = null;
  private buffer = "";
  private connected = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingRequests = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  /** Start the stream connection (non-blocking). */
  connect(): void {
    if (this.closed) return;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.closed) return;
    if (this.socket !== null) return;

    const socket = createConnection(this.socketPath, () => {
      // Send stream handshake
      socket.write(JSON.stringify({ method: "stream" }) + "\n");
    });

    socket.on("error", (err) => {
      if (!this.closed) {
        console.error(`[gateway] IPC stream error: ${err.message}`);
      }
    });

    socket.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;

          // Handle handshake response
          if (!this.connected && msg["ok"] === true) {
            this.connected = true;
            this.emit("connected");
            continue;
          }

          // Handle response to a pending request
          if (msg["type"] === "response" && typeof msg["id"] === "string") {
            const pending = this.pendingRequests.get(msg["id"]);
            if (pending !== undefined) {
              this.pendingRequests.delete(msg["id"]);
              clearTimeout(pending.timer);
              if (msg["error"] !== undefined) {
                pending.reject(new Error(String(msg["error"])));
              } else {
                pending.resolve(msg["data"]);
              }
            }
            continue;
          }

          // Incoming message from agent
          this.emit("message", msg);
        } catch {
          // Invalid JSON — skip
        }
      }
    });

    socket.on("close", () => {
      const wasConnected = this.connected;
      this.socket = null;
      this.connected = false;
      this.buffer = "";

      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("IPC stream disconnected"));
        this.pendingRequests.delete(id);
      }

      if (wasConnected) {
        this.emit("disconnected");
      }

      // Auto-reconnect
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.socket = socket;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.doConnect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  /** Send a fire-and-forget message to the agent. */
  send(msg: Record<string, unknown>): void {
    if (this.socket === null || !this.connected) return;
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  /** Send a request-response message to the agent and wait for the response. */
  request(msg: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.socket === null || !this.connected) {
        reject(new Error("IPC stream not connected"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("IPC stream request timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ ...msg, id }) + "\n");
    });
  }

  /** Check if the stream is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Close the stream and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket !== null) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC stream closed"));
      this.pendingRequests.delete(id);
    }
  }
}

/** Create and connect an IpcStream to the agent socket. */
export function createStreamConnection(socketPath: string): IpcStream {
  const stream = new IpcStream(socketPath);
  stream.connect();
  return stream;
}
