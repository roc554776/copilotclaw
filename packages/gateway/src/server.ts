import { readFileSync, readdirSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager } from "./agent-manager.js";
import { BuiltinChatChannel } from "./builtin-chat-channel.js";
import type { ChannelProvider } from "./channel-provider.js";
import { DEFAULT_PORT, getProfileName, getStateDir, loadConfig } from "./config.js";
import { getWorkspaceRoot } from "./workspace.js";
import { LogBuffer } from "./log-buffer.js";
import { renderEventsPage, renderSessionsListPage, renderStatusPage } from "./observability-pages.js";
import { SessionEventStore } from "./session-event-store.js";
import type { SessionOrchestrator } from "./session-orchestrator.js";
import { Store } from "./store.js";
import { SseBroadcaster } from "./sse-broadcaster.js";
import { FRONTEND_DIST_DIR, FRONTEND_INDEX_HTML, hasFrontendDist } from "./frontend-dist.js";

export { DEFAULT_PORT };

const thisDir = dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(readFileSync(join(thisDir, "..", "package.json"), "utf-8")) as { version: string };
const GATEWAY_VERSION = pkgJson.version;

const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".html": "text/html",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Pre-load all frontend assets into memory at startup (Vite outputs a handful of hashed files).
// This eliminates synchronous file I/O from the request path.
const assetCache = new Map<string, { content: Buffer; mime: string }>();
if (hasFrontendDist()) {
  const assetsDir = join(FRONTEND_DIST_DIR, "assets");
  try {
    for (const name of readdirSync(assetsDir)) {
      const filePath = join(assetsDir, name);
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) {
          const ext = extname(name);
          const mime = MIME_TYPES[ext] ?? "application/octet-stream";
          assetCache.set("/assets/" + name, { content: readFileSync(filePath), mime });
        }
      } catch { /* skip */ }
    }
  } catch { /* assets dir missing */ }
}

/** Serve SPA HTML page routes or static assets from frontend-dist. Returns true if handled. */
function serveFrontend(pathname: string, res: ServerResponse): boolean {
  if (!hasFrontendDist()) return false;

  // Serve static assets from pre-loaded cache
  const cached = assetCache.get(pathname);
  if (cached !== undefined) {
    res.writeHead(200, { "Content-Type": cached.mime, "Cache-Control": "public, max-age=31536000, immutable" });
    res.end(cached.content);
    return true;
  }

  // SPA HTML routes — serve index.html for known page routes
  const spaRoutes = ["/", "/status", "/sessions"];
  const isSessionEventsRoute = /^\/sessions\/[^/]+\/events$/.test(pathname);
  if (spaRoutes.includes(pathname) || isSessionEventsRoute) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FRONTEND_INDEX_HTML);
    return true;
  }

  return false;
}

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

export interface CronJobStatus {
  id: string;
  channelId: string;
  intervalMs: number;
  message: string;
  disabled: boolean;
  scheduled: boolean;
}

export interface ServerDeps {
  port?: number;
  store?: Store;
  onStop?: () => void;
  agentManager?: AgentManager | null;
  sseBroadcaster?: SseBroadcaster;
  channelProviders?: ChannelProvider[];
  logBuffer?: LogBuffer;
  sessionEventStore?: SessionEventStore;
  sessionOrchestrator?: SessionOrchestrator;
  onCronReload?: () => void;
  getCronJobStatuses?: () => CronJobStatus[];
}

function createRequestHandler(
  store: Store,
  onStop: () => void,
  agentManager: AgentManager | null,
  channelProviders: ChannelProvider[],
  logBuffer: LogBuffer,
  sessionEventStore: SessionEventStore | null,
  sessionOrchestrator: SessionOrchestrator | null,
  onCronReload: (() => void) | null,
  getCronJobStatuses: (() => CronJobStatus[]) | null,
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

    if (fullPathname === "/api/logs" && method === "GET") {
      const limitParam = params.get("limit");
      const limit = limitParam !== null ? parseInt(limitParam, 10) : 50;
      json(res, 200, logBuffer.list(Number.isFinite(limit) && limit > 0 ? limit : 50));
      return;
    }

    if (fullPathname === "/api/status" && method === "GET") {
      const agentStatus = agentManager !== null ? await agentManager.getStatus() : null;
      const agentCompatibility = agentManager !== null ? await agentManager.checkCompatibility() : "unavailable";
      const config = loadConfig(getProfileName());
      const statusResponse: Record<string, unknown> = {
        gateway: { status: "running", version: GATEWAY_VERSION, profile: getProfileName() ?? null },
        agent: agentStatus,
        agentCompatibility,
        config: {
          model: config.model ?? null,
          zeroPremium: config.zeroPremium ?? false,
          debugMockCopilotUnsafeTools: config.debugMockCopilotUnsafeTools ?? false,
          stateDir: getStateDir(getProfileName()),
          workspaceRoot: getWorkspaceRoot(getProfileName()),
          // Full auth config is safe to expose on localhost — values are references
          // to secrets (env var names, file paths, commands), not secrets themselves.
          auth: config.auth?.github ?? null,
          otel: config.otel ?? null,
        },
      };
      // Merge orchestrator data into agent.sessions so the frontend has a single source.
      // Orchestrator is authoritative for abstract session state (status, cumulative tokens,
      // physical session history, live physical session details, subagent tracking).
      if (sessionOrchestrator !== null) {
        const orchSessions = sessionOrchestrator.getSessionStatuses();
        const agentObj = (statusResponse["agent"] ?? { sessions: {} }) as Record<string, unknown>;
        const mergedSessions: Record<string, unknown> = {};
        for (const [sessionId, orchSession] of Object.entries(orchSessions)) {
          mergedSessions[sessionId] = {
            status: orchSession.status,
            startedAt: orchSession.startedAt,
            boundChannelId: orchSession.channelId,
            processingStartedAt: orchSession.processingStartedAt,
            physicalSession: orchSession.physicalSession,
            physicalSessionHistory: orchSession.physicalSessionHistory,
            subagentSessions: orchSession.subagentSessions,
            cumulativeInputTokens: orchSession.cumulativeInputTokens,
            cumulativeOutputTokens: orchSession.cumulativeOutputTokens,
          };
        }
        agentObj["sessions"] = mergedSessions;
        statusResponse["agent"] = agentObj;
      }
      json(res, 200, statusResponse);
      return;
    }

    if (fullPathname === "/api/quota" && method === "GET") {
      // Try live IPC first, fall back to session event store
      const quota = agentManager !== null ? await agentManager.getQuota() : null;
      if (quota !== null) {
        json(res, 200, quota);
      } else if (sessionEventStore !== null) {
        const cached = sessionEventStore.getLatestQuota();
        json(res, 200, cached ?? { quotaSnapshots: {} });
      } else {
        json(res, 200, { quotaSnapshots: {} });
      }
      return;
    }

    if (fullPathname === "/api/models" && method === "GET") {
      // Try live IPC first, fall back to session event store
      const models = agentManager !== null ? await agentManager.getModels() : null;
      if (models !== null) {
        json(res, 200, models);
      } else if (sessionEventStore !== null) {
        json(res, 200, { models: sessionEventStore.getKnownModels() });
      } else {
        json(res, 200, { models: [] });
      }
      return;
    }

    // Session messages (physical session context detail)
    const sessionMsgMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(fullPathname);
    if (sessionMsgMatch !== null && method === "GET") {
      const sessionId = decodeURIComponent(sessionMsgMatch[1]!);
      const messages = agentManager !== null ? await agentManager.getSessionMessages(sessionId) : null;
      if (messages !== null) {
        json(res, 200, messages);
      } else {
        json(res, 404, { error: "session not found or no messages available" });
      }
      return;
    }

    // Cron management
    if (fullPathname === "/api/cron" && method === "GET") {
      if (getCronJobStatuses !== null) {
        json(res, 200, getCronJobStatuses());
      } else {
        json(res, 200, []);
      }
      return;
    }

    if (fullPathname === "/api/cron/reload" && method === "POST") {
      if (onCronReload !== null) {
        onCronReload();
        json(res, 200, { status: "reloaded" });
      } else {
        json(res, 503, { error: "cron reload not available" });
      }
      return;
    }

    // Physical session stop via API (for channel settings modal)
    const sessionStopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(fullPathname);
    if (sessionStopMatch !== null && method === "POST") {
      if (agentManager === null || sessionOrchestrator === null) {
        json(res, 503, { error: "agent not available" });
        return;
      }
      const sessionId = decodeURIComponent(sessionStopMatch[1]!);
      agentManager.stopPhysicalSession(sessionId);
      sessionOrchestrator.suspendSession(sessionId);
      json(res, 200, { status: "stopped" });
      return;
    }

    // Channel management (core — provider-agnostic)
    if (fullPathname === "/api/channels" && method === "GET") {
      const includeArchived = params.get("includeArchived") === "true";
      json(res, 200, store.listChannels({ includeArchived }));
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

    // Channel update (archive/unarchive and/or model setting)
    const channelPatchMatch = /^\/api\/channels\/([^/]+)$/.exec(fullPathname);
    if (channelPatchMatch !== null && method === "PATCH") {
      const channelId = decodeURIComponent(channelPatchMatch[1]!);
      const body = parseJson(await readBody(req));
      if (!isRecord(body)) {
        json(res, 400, { error: "invalid request body" });
        return;
      }

      // Handle archive/unarchive
      if (typeof body["archived"] === "boolean") {
        const ok = body["archived"]
          ? store.archiveChannel(channelId)
          : store.unarchiveChannel(channelId);
        if (!ok) {
          json(res, 404, { error: "channel not found or already in requested state" });
          return;
        }
      }

      // Handle model setting (string to set, null to clear)
      if ("model" in body) {
        const modelVal = body["model"];
        if (modelVal !== null && typeof modelVal !== "string") {
          json(res, 400, { error: "'model' must be a string or null" });
          return;
        }
        const ok = store.updateChannelModel(channelId, modelVal as string | null);
        if (!ok) {
          json(res, 404, { error: "channel not found" });
          return;
        }
      }

      const channel = store.getChannel(channelId);
      if (channel === undefined) {
        json(res, 404, { error: "channel not found" });
        return;
      }
      json(res, 200, channel);
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
        const before = params.get("before") ?? undefined;
        json(res, 200, store.listMessages(channelId, Number.isFinite(limit) ? limit : 5, before));
        return;
      }

      if (action === "messages" && method === "POST") {
        const body = parseJson(await readBody(req));
        if (!isRecord(body) || typeof body["message"] !== "string") {
          json(res, 400, { error: "missing 'message' field" });
          return;
        }
        const senderRaw = body["sender"];
        const sender = senderRaw === "user" ? "user" as const : senderRaw === "cron" ? "cron" as const : senderRaw === "system" ? "system" as const : "agent" as const;
        const msg = store.addMessage(channelId, sender, body["message"] as string);
        if (msg === undefined) {
          json(res, 404, { error: "channel not found" });
          return;
        }
        // Notify all channel providers
        for (const provider of channelProviders) {
          provider.onMessage?.(channelId, sender, msg.message);
        }
        // Notify agent via IPC stream when a user or cron message arrives
        if ((sender === "user" || sender === "cron") && agentManager !== null && sessionOrchestrator !== null) {
          const notifySessionId = sessionOrchestrator.getSessionIdForChannel(channelId);
          if (notifySessionId !== undefined) {
            agentManager.notifyAgent(notifySessionId);
          }
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

    // Serve React SPA frontend (if built) for page routes and static assets
    if (method === "GET" && serveFrontend(fullPathname, res)) {
      return;
    }

    // SystemStatus standalone page (fallback when frontend-dist not built)
    if (fullPathname === "/status" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderStatusPage());
      return;
    }

    // Sessions list page (all sessions from event store)
    if (fullPathname === "/sessions" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderSessionsListPage());
      return;
    }

    // Session events stream page
    const eventsPageMatch = /^\/sessions\/([^/]+)\/events$/.exec(fullPathname);
    if (eventsPageMatch !== null && method === "GET") {
      const sessionId = decodeURIComponent(eventsPageMatch[1]!);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderEventsPage(sessionId));
      return;
    }

    // Session event routes (observability)
    if (sessionEventStore !== null) {
      // POST /api/session-events — agent posts events here
      if (fullPathname === "/api/session-events" && method === "POST") {
        const body = parseJson(await readBody(req));
        if (!isRecord(body) || typeof body["sessionId"] !== "string" || typeof body["type"] !== "string") {
          json(res, 400, { error: "missing sessionId or type" });
          return;
        }
        const event: { type: string; timestamp: string; data: Record<string, unknown>; parentId?: string } = {
          type: body["type"] as string,
          timestamp: typeof body["timestamp"] === "string" ? body["timestamp"] as string : new Date().toISOString(),
          data: isRecord(body["data"]) ? body["data"] as Record<string, unknown> : {},
        };
        if (typeof body["parentId"] === "string") event.parentId = body["parentId"];
        sessionEventStore.appendEvent(body["sessionId"] as string, event);
        json(res, 201, { ok: true });
        return;
      }

      // GET /api/sessions/:id/events — get events for a session
      const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(fullPathname);
      if (eventsMatch !== null && method === "GET") {
        const sessionId = decodeURIComponent(eventsMatch[1]!);
        const limitParam = params.get("limit");
        const beforeParam = params.get("before");
        const afterParam = params.get("after");
        if (limitParam !== null) {
          const limit = parseInt(limitParam, 10);
          const options: { before?: number; after?: number } = {};
          if (beforeParam !== null) options.before = parseInt(beforeParam, 10);
          if (afterParam !== null) options.after = parseInt(afterParam, 10);
          json(res, 200, sessionEventStore.getEventsPaginated(sessionId, Number.isFinite(limit) ? limit : 50, options));
        } else {
          json(res, 200, sessionEventStore.getEvents(sessionId));
        }
        return;
      }

      // GET /api/session-events/sessions — list sessions with events
      if (fullPathname === "/api/session-events/sessions" && method === "GET") {
        json(res, 200, sessionEventStore.listSessions());
        return;
      }

      // GET /api/token-usage — aggregate token usage by model for a time range
      if (fullPathname === "/api/token-usage" && method === "GET") {
        const hoursParam = params.get("hours");
        const fromParam = params.get("from");
        const toParam = params.get("to");
        const now = new Date();
        const to = toParam ?? now.toISOString();
        const from = fromParam ?? new Date(now.getTime() - (Number(hoursParam) || 5) * 3600_000).toISOString();
        json(res, 200, sessionEventStore.getTokenUsage(from, to));
        return;
      }

      // POST /api/system-prompts/original — agent posts captured original prompt
      if (fullPathname === "/api/system-prompts/original" && method === "POST") {
        const body = parseJson(await readBody(req));
        if (!isRecord(body) || typeof body["model"] !== "string" || typeof body["prompt"] !== "string") {
          json(res, 400, { error: "missing model or prompt" });
          return;
        }
        sessionEventStore.saveOriginalPrompt({
          model: body["model"] as string,
          prompt: body["prompt"] as string,
          capturedAt: typeof body["capturedAt"] === "string" ? body["capturedAt"] as string : new Date().toISOString(),
        });
        json(res, 201, { ok: true });
        return;
      }

      // GET /api/system-prompts/original — list all original prompts
      if (fullPathname === "/api/system-prompts/original" && method === "GET") {
        json(res, 200, sessionEventStore.listOriginalPrompts());
        return;
      }

      // GET /api/system-prompts/original/:model — get original prompt for a model
      const promptMatch = /^\/api\/system-prompts\/original\/(.+)$/.exec(fullPathname);
      if (promptMatch !== null && method === "GET") {
        const model = decodeURIComponent(promptMatch[1]!);
        const snap = sessionEventStore.getOriginalPrompt(model);
        if (snap !== undefined) {
          json(res, 200, snap);
        } else {
          json(res, 404, { error: "no prompt captured for this model" });
        }
        return;
      }

      // POST /api/system-prompts/effective — agent posts effective prompt
      if (fullPathname === "/api/system-prompts/effective" && method === "POST") {
        const body = parseJson(await readBody(req));
        if (!isRecord(body) || typeof body["sessionId"] !== "string" || typeof body["prompt"] !== "string" || typeof body["model"] !== "string") {
          json(res, 400, { error: "missing sessionId, model, or prompt" });
          return;
        }
        sessionEventStore.saveEffectivePrompt(body["sessionId"] as string, body["prompt"] as string, body["model"] as string);
        json(res, 201, { ok: true });
        return;
      }

      // GET /api/system-prompts/effective/:sessionId — get effective prompt
      const sessPromptMatch = /^\/api\/system-prompts\/effective\/(.+)$/.exec(fullPathname);
      if (sessPromptMatch !== null && method === "GET") {
        const sessionId = decodeURIComponent(sessPromptMatch[1]!);
        const snap = sessionEventStore.getEffectivePrompt(sessionId);
        if (snap !== undefined) {
          json(res, 200, snap);
        } else {
          json(res, 404, { error: "no prompt captured for this session" });
        }
        return;
      }
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
  sseBroadcaster: SseBroadcaster;
  close: () => Promise<void>;
}

export function startServer(options?: ServerDeps): Promise<ServerHandle> {
  const port = options?.port ?? DEFAULT_PORT;
  const store = options?.store ?? new Store();
  const onStop = options?.onStop ?? (() => { process.exit(0); });
  const agentManager = options?.agentManager === null
    ? null
    : options?.agentManager ?? new AgentManager();
  const sseBroadcaster = options?.sseBroadcaster ?? new SseBroadcaster();
  const logBuffer = options?.logBuffer ?? new LogBuffer();
  const sessionEventStore = options?.sessionEventStore ?? null;
  const sessionOrchestrator = options?.sessionOrchestrator ?? null;

  // Channel providers: use provided list or default to built-in chat
  const channelProviders = options?.channelProviders ?? [
    new BuiltinChatChannel({ store, agentManager, sseBroadcaster }),
  ];

  const onCronReload = options?.onCronReload ?? null;
  const getCronJobStatuses = options?.getCronJobStatuses ?? null;
  const handleRequest = createRequestHandler(store, onStop, agentManager, channelProviders, logBuffer, sessionEventStore, sessionOrchestrator, onCronReload, getCronJobStatuses);

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

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      console.error(`[gateway] listening on http://localhost:${actualPort}`);
      resolve({
        server,
        port: actualPort,
        store,
        sseBroadcaster,
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
