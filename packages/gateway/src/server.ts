import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { AgentManager } from "./agent-manager.js";
import { BuiltinChatChannel } from "./builtin-chat-channel.js";
import type { ChannelProvider } from "./channel-provider.js";
import { Store } from "./store.js";
import { WsBroadcaster } from "./ws.js";

export const DEFAULT_PORT = 19741;

const MAX_BODY_SIZE = 1_048_576; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let limitExceeded = false;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        limitExceeded = true;
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!limitExceeded) resolve(Buffer.concat(chunks).toString("utf-8")); });
    req.on("error", (err) => { if (!limitExceeded) reject(err); });
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
  wsBroadcaster?: WsBroadcaster;
  channelProviders?: ChannelProvider[];
}

function createRequestHandler(
  store: Store,
  onStop: () => void,
  agentManager: AgentManager | null,
  channelProviders: ChannelProvider[],
) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;
    const fullPathname = url?.split("?")[0] ?? "/";
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
        // Agent process is NOT stopped — it is independent and keeps sessions alive
        onStop();
      });
      return;
    }

    if (fullPathname === "/api/status" && method === "GET") {
      const agentStatus = agentManager !== null ? await agentManager.getStatus() : null;
      json(res, 200, {
        gateway: { status: "running" },
        agent: agentStatus,
      });
      return;
    }

    // Channel management (core — provider-agnostic)
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

    // Channel-scoped routes (core — provider-agnostic)
    const route = parseChannelRoute(fullPathname);
    if (route !== undefined) {
      const { channelId, action } = route;

      if (store.getChannel(channelId) === undefined) {
        json(res, 404, { error: "channel not found" });
        return;
      }

      if (action === "messages" && method === "GET") {
        const limitParam = params.get("limit");
        const limit = limitParam !== null ? parseInt(limitParam, 10) : 5;
        json(res, 200, store.listMessages(channelId, Number.isFinite(limit) ? limit : 5));
        return;
      }

      if (action === "messages" && method === "POST") {
        const body = parseJson(await readBody(req));
        if (!isRecord(body) || typeof body["message"] !== "string") {
          json(res, 400, { error: "missing 'message' field" });
          return;
        }
        const sender = body["sender"] === "user" ? "user" as const : "agent" as const;
        const msg = store.addMessage(channelId, sender, body["message"] as string);
        if (msg === undefined) {
          json(res, 404, { error: "channel not found" });
          return;
        }
        // Agent process ensure is done at gateway start, not per-message.
        // Agent session ensure is the agent process's responsibility (it polls for pending).
        // Notify all channel providers
        for (const provider of channelProviders) {
          provider.onMessage?.(channelId, sender, msg.message);
        }
        json(res, 201, msg);
        return;
      }

      if (action === "messages/pending" && method === "POST") {
        const pending = store.drainPending(channelId);
        if (pending.length === 0) {
          json(res, 204, null);
          return;
        }
        json(res, 200, pending);
        return;
      }

      if (action === "messages/pending/peek" && method === "GET") {
        const oldest = store.peekOldestPending(channelId);
        if (oldest === undefined) {
          json(res, 204, null);
          return;
        }
        json(res, 200, oldest);
        return;
      }

      if (action === "messages/pending/flush" && method === "POST") {
        const count = store.flushPending(channelId);
        json(res, 200, { flushed: count });
        return;
      }

      json(res, 404, { error: "unknown channel action" });
      return;
    }

    // Delegate to channel providers (provider-specific routes like "/" dashboard, "/api/events" SSE)
    for (const provider of channelProviders) {
      const handled = await provider.handleRequest(req, res, params);
      if (handled) return;
    }

    json(res, 404, { error: "not found" });
  };
}

export interface ServerHandle {
  server: Server;
  port: number;
  store: Store;
  wsBroadcaster: WsBroadcaster;
  close: () => Promise<void>;
}

export function startServer(options?: ServerDeps): Promise<ServerHandle> {
  const port = options?.port ?? DEFAULT_PORT;
  const store = options?.store ?? new Store();
  const onStop = options?.onStop ?? (() => { process.exit(0); });
  const agentManager = options?.agentManager === null
    ? null
    : options?.agentManager ?? new AgentManager({ gatewayPort: port });
  const wsBroadcaster = options?.wsBroadcaster ?? new WsBroadcaster();

  // Channel providers: use provided list or default to built-in chat
  const channelProviders = options?.channelProviders ?? [
    new BuiltinChatChannel({ store, agentManager, wsBroadcaster }),
  ];

  const handleRequest = createRequestHandler(store, onStop, agentManager, channelProviders);

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
        wsBroadcaster,
        close: async () => {
          for (const provider of channelProviders) {
            provider.close?.();
          }
          // Agent process is NOT stopped — independent process
          await new Promise<void>((res, rej) => {
            server.close((err) => { err ? rej(err) : res(); });
          });
        },
      });
    });
  });
}
