import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
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

function createRequestHandler(store: Store, onStop: () => void) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;

    const pathname = url?.split("?")[0];

    if (pathname === "/healthz" && method === "GET") {
      json(res, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/stop" && method === "POST") {
      json(res, 200, { status: "stopping" });
      onStop();
      return;
    }

    if (pathname === "/" && method === "GET") {
      const html = renderDashboard(store.listAll());
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (pathname === "/api/inputs" && method === "POST") {
      const body = parseJson(await readBody(req));
      if (!isRecord(body) || typeof body["message"] !== "string") {
        json(res, 400, { error: "missing 'message' field" });
        return;
      }
      const input = store.addInput(body["message"] as string);
      json(res, 201, input);
      return;
    }

    if (pathname === "/api/inputs/next" && method === "POST") {
      const input = store.findNextInput();
      if (input === undefined) {
        json(res, 204, null);
        return;
      }
      json(res, 200, input);
      return;
    }

    if (pathname === "/api/replies" && method === "POST") {
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

    json(res, 404, { error: "not found" });
  };
}

export interface ServerHandle {
  server: Server;
  port: number;
  store: Store;
  close: () => Promise<void>;
}

export function startServer(options?: { port?: number; store?: Store; onStop?: () => void }): Promise<ServerHandle> {
  const port = options?.port ?? DEFAULT_PORT;
  const store = options?.store ?? new Store();
  const onStop = options?.onStop ?? (() => { process.exit(0); });
  const handleRequest = createRequestHandler(store, onStop);

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
        close: () => new Promise<void>((res, rej) => {
          server.close((err) => { err ? rej(err) : res(); });
        }),
      });
    });
  });
}
