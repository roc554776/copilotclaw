import type { ServerResponse } from "node:http";
import type { LogEntry } from "./log-buffer.js";
import type { SessionEvent } from "./session-event-store.js";
import type { Channel } from "./store.js";

/**
 * Token usage summary aggregated per model over a time window.
 * Mirrors the return type of SessionEventStore.getTokenUsage().
 */
export type TokenUsageSummary = Array<{
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  multiplier: number;
}>;

type SseClientScope = { type: "channel"; channelId: string } | { type: "global" } | { type: "session"; sessionId: string };

interface SseClient {
  res: ServerResponse;
  scope: SseClientScope;
}

/**
 * Session-scoped SSE events broadcast to clients subscribed to `/api/sessions/:id/events/stream`.
 * These events are scoped to a specific physical session.
 */
export type SseSessionEvent = { type: "session_event_appended"; event: SessionEvent };

/**
 * Global SSE events broadcast to clients subscribed to `/api/global-events`.
 * These are system-wide events not tied to any specific channel.
 *
 * See `docs/proposals/state-management-architecture.md` "GlobalSseEvent" for the design contract.
 */
export type GlobalSseEvent =
  | { type: "gateway_status_change"; version: string; running: boolean }
  | { type: "agent_status_change"; version: string | undefined; running: boolean }
  | { type: "agent_compatibility_change"; compatibility: "compatible" | "incompatible" | "unavailable" }
  | { type: "log_appended"; entries: LogEntry[] }
  | { type: "token_usage_update"; summary: TokenUsageSummary }
  | { type: "channel_list_change"; channels: Channel[] };

/**
 * Server-Sent Events broadcaster. Uses SSE instead of WebSocket
 * because Node.js 22 has no built-in WebSocketServer and SSE
 * requires no external dependencies.
 */
export class SseBroadcaster {
  private readonly clients = new Set<SseClient>();

  private initSse(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":\n\n"); // SSE comment as keepalive
  }

  addChannelClient(res: ServerResponse, channelId: string): void {
    this.initSse(res);
    const client: SseClient = { res, scope: { type: "channel", channelId } };
    this.clients.add(client);
    res.on("close", () => { this.clients.delete(client); });
  }

  addGlobalClient(res: ServerResponse): void {
    this.initSse(res);
    const client: SseClient = { res, scope: { type: "global" } };
    this.clients.add(client);
    res.on("close", () => { this.clients.delete(client); });
  }

  addSessionClient(res: ServerResponse, sessionId: string): void {
    this.initSse(res);
    const client: SseClient = { res, scope: { type: "session", sessionId } };
    this.clients.add(client);
    res.on("close", () => { this.clients.delete(client); });
  }

  /**
   * @deprecated Use addChannelClient or addGlobalClient instead.
   * Kept for backward compatibility. Will be removed in a future version.
   */
  addClient(res: ServerResponse, channelId: string | undefined): void {
    if (channelId !== undefined) {
      this.addChannelClient(res, channelId);
    } else {
      this.addGlobalClient(res);
    }
  }

  broadcastToChannel(channelId: string, event: { type: string; data?: unknown }): void {
    const payload = `data: ${JSON.stringify({ ...event, channelId })}\n\n`;
    for (const client of this.clients) {
      if (client.scope.type === "channel" && client.scope.channelId === channelId) {
        client.res.write(payload);
      }
    }
  }

  broadcastToSession(sessionId: string, event: SseSessionEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (client.scope.type === "session" && client.scope.sessionId === sessionId) {
        client.res.write(payload);
      }
    }
  }

  broadcastGlobal(event: GlobalSseEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (client.scope.type === "global") {
        client.res.write(payload);
      }
    }
  }

  /**
   * @deprecated Scope-ambiguous broadcast. Use broadcastToChannel or broadcastGlobal instead.
   * For backward compatibility: if event.channelId is set, delegates to broadcastToChannel.
   * Otherwise logs a warning and does nothing (global broadcasts must be explicit).
   */
  broadcast(event: { type: string; channelId?: string; data?: unknown }): void {
    if (event.channelId !== undefined) {
      this.broadcastToChannel(event.channelId, { type: event.type, data: event.data });
    } else {
      // No channelId — ambiguous. Silently ignored; callers should use broadcastGlobal explicitly.
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.res.end();
    }
    this.clients.clear();
  }
}
