import { createConnection } from "node:net";

export interface AgentSessionStatusResponse {
  status: "starting" | "waiting" | "processing" | "stopped" | "not_running";
  startedAt?: string;
  processingStartedAt?: string;
  boundChannelId?: string;
}

export interface AgentStatusResponse {
  version?: string;
  startedAt: string;
  sessions: Record<string, AgentSessionStatusResponse>;
}

function sendIpcRequest(socketPath: string, method: string, params?: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
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
          resolve(JSON.parse(line) as Record<string, unknown>);
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

export async function getAgentStatus(socketPath: string): Promise<AgentStatusResponse | null> {
  try {
    const res = await sendIpcRequest(socketPath, "status");
    return res as unknown as AgentStatusResponse;
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
