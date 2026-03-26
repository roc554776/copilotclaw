import { createConnection } from "node:net";

export interface PhysicalSessionSummary {
  sessionId: string;
  model: string;
  startedAt: string;
  currentState: string;
  currentTokens?: number;
  tokenLimit?: number;
}

export interface SubagentInfo {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
}

export interface AgentSessionStatusResponse {
  status: "starting" | "waiting" | "processing" | "stopped" | "not_running";
  startedAt?: string;
  processingStartedAt?: string;
  boundChannelId?: string;
  physicalSession?: PhysicalSessionSummary;
  subagentSessions?: SubagentInfo[];
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
