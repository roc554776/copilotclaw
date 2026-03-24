import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { AgentManager } from "./agent-manager.js";
import { renderDashboard } from "./dashboard.js";
import { Store } from "./store.js";

export const DEFAULT_PORT = 19741;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf-8")); });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseChannelRoute(pathname: string): { channelId: string; action: string } | undefined {
  const match = /^\/api\/channels\/([^/]+)\/(.+)$/.exec(pathname);
  if (match) return { channelId: match[1]!, action: match[2]! };
  return undefined;
}

export interface ServerDeps {
  port?: number;
  store?: Store;
  onStop?: () => void;
  agentManager?: AgentManager | null;
}

function createRequestHandler(store: Store, onStop: () => void, agentManager: AgentManager | null) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;
    const fullPathname = url?.split("?")[0] ?? "/";
    // Parse query string for channel selection in dashboard
    const queryString = url?.split("?")[1] ?? "";
    const params = new URLSearchParams(queryString);

    if (fullPathname === "/healthz" && method === "GET") {
      json(res, 200, { status: "ok" });
      return;
    }

    if (fullPathname === "/api/stop" && method === "POST") {
      const remoteAddr = req.socket.remoteAddress ?? "";
      if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
        json(res, 403, { error: "forbidden" });
        return;
      }
      json(res, 200, { status: "stopping" });
      res.once("finish", () => {
        agentManager?.stopAgent().catch(() => {});
        onStop();
      });
      return;
    }

    // Channel management
    if (fullPathname === "/api/channels" && method === "GET") {
      json(res, 200, store.listChannels());
      return;
    }

    if (fullPathname === "/api/channels" && method === "POST") {
      const channel = store.createChannel();
      json(res, 201, channel);
      return;
    }

    if (fullPathname === "/api/channels/pending" && method === "GET") {
      json(res, 200, store.pendingCounts());
      return;
    }

    // Channel-scoped routes: /api/channels/:channelId/:action
    const route = parseChannelRoute(fullPathname);
    if (route !== undefined) {
      const { channelId, action } = route;

      if (store.getChannel(channelId) === undefined) {
        json(res, 404, { error: "channel not found" });
        return;
      }

      if (action === "inputs" && method === "POST") {
        const body = parseJson(await readBody(req));
        if (!isRecord(body) || typeof body["message"] !== "string") {
          json(res, 400, { error: "missing 'message' field" });
          return;
        }
        const input = store.addInput(channelId, body["message"] as string);
        if (input === undefined) {
          json(res, 404, { error: "channel not found" });
          return;
        }
        // Ensure agent process is running
        if (agentManager !== null) {
          agentManager.ensureAgent().catch((err: unknown) => {
            console.error("[gateway] ensureAgent error:", err);
          });
        }
        json(res, 201, input);
        return;
      }

      if (action === "inputs/next" && method === "POST") {
        const inputs = store.drainInputs(channelId);
        if (inputs.length === 0) {
          json(res, 204, null);
          return;
        }
        json(res, 200, inputs);
        return;
      }

      if (action === "replies" && method === "POST") {
        const body = parseJson(await readBody(req));
        if (!isRecord(body) || typeof body["inputId"] !== "string" || typeof body["message"] !== "string") {
          json(res, 400, { error: "missing 'inputId' or 'message' field" });
          return;
        }
        const updated = store.addReply(body["inputId"] as string, body["message"] as string);
        if (updated === undefined) {
          json(res, 404, { error: "input not found" });
          return;
        }
        json(res, 200, updated);
        return;
      }

      if (action === "inputs/flush" && method === "POST") {
        const count = store.flushInputs(channelId);
        json(res, 200, { flushed: count });
        return;
      }

      if (action === "inputs/peek" && method === "GET") {
        const oldest = store.peekOldestInput(channelId);
        if (oldest === undefined) {
          json(res, 204, null);
          return;
        }
        json(res, 200, oldest);
        return;
      }

      json(res, 404, { error: "unknown channel action" });
      return;
    }

    // Dashboard
    if (fullPathname === "/" && method === "GET") {
      const channels = store.listChannels();
      const selectedChannelId = params.get("channel") ?? channels[0]?.id;
      const inputs = selectedChannelId !== undefined ? store.listInputs(selectedChannelId) : [];
      const html = renderDashboard(channels, inputs, selectedChannelId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    json(res, 404, { error: "not found" });
  };
}

export interface ServerHandle {
  server: Server;
  port: number;
  store: Store;
  close: () => Promise<void>;
}

export function startServer(options?: ServerDeps): Promise<ServerHandle> {
  const port = options?.port ?? DEFAULT_PORT;
  const store = options?.store ?? new Store();
  const onStop = options?.onStop ?? (() => { process.exit(0); });
  // agentManager: null means no agent spawning (for tests), undefined means create default
  const agentManager = options?.agentManager === null
    ? null
    : options?.agentManager ?? new AgentManager({ gatewayPort: port });
  const handleRequest = createRequestHandler(store, onStop, agentManager);

  // Create default channel on startup
  if (store.listChannels().length === 0) {
    store.createChannel();
  }

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      handleRequest(req, res).catch((err: unknown) => {
        console.error("[gateway] request error:", err);
        if (!res.headersSent) {
          json(res, 500, { error: "internal server error" });
        }
      });
    });

    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      console.error(`[gateway] listening on http://localhost:${actualPort}`);
      resolve({
        server,
        port: actualPort,
        store,
        close: async () => {
          await agentManager?.stopAgent().catch(() => {});
          await new Promise<void>((res, rej) => {
            server.close((err) => { err ? rej(err) : res(); });
          });
        },
      });
    });
  });
}
