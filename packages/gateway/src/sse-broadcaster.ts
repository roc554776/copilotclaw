import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { LogEntry } from "./log-buffer.js";
import type { SessionEvent } from "./session-event-store.js";
import type { Channel } from "./store.js";
import { reduceChannelSse, reduceGlobalSse } from "./sse-broadcaster-reducer.js";
import type {
  ChannelScopedSseState,
  GlobalSseState,
  SseBroadcasterEvent,
  ChannelSseEvent,
} from "./sse-broadcaster-events.js";

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
 * Format a session-scoped SSE frame with the event ID line when available.
 * Uses `id: <n>` from `event.event.id` so EventSource tracks Last-Event-ID automatically.
 * Exported so `replaySessionEventsAfter` in daemon.ts can share the same format and prevent drift.
 */
export function formatSessionSseFrame(event: SseSessionEvent): string {
  const id = event.event.id;
  return id !== undefined
    ? `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`
    : `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Server-Sent Events broadcaster. Uses SSE instead of WebSocket
 * because Node.js 22 has no built-in WebSocketServer and SSE
 * requires no external dependencies.
 *
 * World state (replay buffers) is managed by the channel and global SSE reducers.
 * Process state (live HTTP response handles) is kept in the `clients` Set and
 * is intentionally excluded from reducer world state — it cannot be serialized
 * and is not subject to reducer transitions.
 */
export class SseBroadcaster {
  private readonly clients = new Set<SseClient>();

  // ── World state managed by reducers ──────────────────────────────────────────

  /** Replay buffer world state for channel-scoped SSE (managed by reduceChannelSse). */
  private channelSseState: ChannelScopedSseState = { channels: {} };

  /** Replay buffer world state for global SSE (managed by reduceGlobalSse). */
  private globalSseState: GlobalSseState = { lastEventId: 0, recentEvents: [] };

  // ── Reducer dispatch ──────────────────────────────────────────────────────────

  /**
   * Dispatch a SseBroadcasterEvent through both channel and global reducers.
   * Executes all resulting commands as side effects against process state.
   * clientId is required for ClientConnected/ClientDisconnected events; pass undefined otherwise.
   */
  private dispatchSseEvent(event: SseBroadcasterEvent, clientRes?: ServerResponse): void {
    // Channel reducer
    const { newState: newChannelState, commands: channelCmds } = reduceChannelSse(this.channelSseState, event);
    this.channelSseState = newChannelState;

    // Global reducer
    const { newState: newGlobalState, commands: globalCmds } = reduceGlobalSse(this.globalSseState, event);
    this.globalSseState = newGlobalState;

    // Execute commands from both reducers
    for (const cmd of [...channelCmds, ...globalCmds]) {
      if (cmd.type === "BroadcastToChannel") {
        const payload = `data: ${JSON.stringify({ ...cmd.event, channelId: cmd.channelId })}\n\n`;
        for (const client of this.clients) {
          if (client.scope.type === "channel" && client.scope.channelId === cmd.channelId) {
            client.res.write(payload);
          }
        }
      } else if (cmd.type === "BroadcastGlobal") {
        const payload = `data: ${JSON.stringify(cmd.event)}\n\n`;
        for (const client of this.clients) {
          if (client.scope.type === "global") {
            client.res.write(payload);
          }
        }
      } else if (cmd.type === "SendReplayEvents") {
        // Send missed events to the newly connected client.
        if (clientRes !== undefined) {
          for (const evt of cmd.channelEvents) {
            clientRes.write(`data: ${JSON.stringify(evt)}\n\n`);
          }
          for (const evt of cmd.globalEvents) {
            clientRes.write(`data: ${JSON.stringify(evt)}\n\n`);
          }
        }
      }
    }
  }

  private initSse(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":\n\n"); // SSE comment as keepalive
  }

  addChannelClient(res: ServerResponse, channelId: string, lastEventId?: number): void {
    this.initSse(res);
    const clientId = randomUUID();
    const client: SseClient = { res, scope: { type: "channel", channelId } };
    this.clients.add(client);
    // Dispatch ClientConnected: triggers SendReplayEvents command if lastEventId is set.
    const event: SseBroadcasterEvent = {
      type: "ClientConnected",
      clientId,
      scope: "channel",
      channelId,
      lastEventId,
    };
    this.dispatchSseEvent(event, res);
    res.on("close", () => {
      this.clients.delete(client);
      this.dispatchSseEvent({ type: "ClientDisconnected", clientId });
    });
  }

  addGlobalClient(res: ServerResponse, lastEventId?: number): void {
    this.initSse(res);
    const clientId = randomUUID();
    const client: SseClient = { res, scope: { type: "global" } };
    this.clients.add(client);
    // Dispatch ClientConnected: triggers SendReplayEvents command if lastEventId is set.
    const event: SseBroadcasterEvent = {
      type: "ClientConnected",
      clientId,
      scope: "global",
      lastEventId,
    };
    this.dispatchSseEvent(event, res);
    res.on("close", () => {
      this.clients.delete(client);
      this.dispatchSseEvent({ type: "ClientDisconnected", clientId });
    });
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
    // Route through ChannelEventPublished — reducer updates replay buffer and emits BroadcastToChannel command.
    // The actual write to client.res is performed inside dispatchSseEvent via the BroadcastToChannel command.
    const sseEvent: ChannelSseEvent = {
      type: event.type as ChannelSseEvent["type"],
      channelId,
      data: event.data,
    };
    this.dispatchSseEvent({ type: "ChannelEventPublished", channelId, event: sseEvent });
  }

  broadcastToSession(sessionId: string, event: SseSessionEvent): void {
    const payload = formatSessionSseFrame(event);
    for (const client of this.clients) {
      if (client.scope.type === "session" && client.scope.sessionId === sessionId) {
        client.res.write(payload);
      }
    }
  }

  broadcastGlobal(event: GlobalSseEvent): void {
    // Route through GlobalEventPublished — reducer updates replay buffer and emits BroadcastGlobal command.
    // The actual write to client.res is performed inside dispatchSseEvent via the BroadcastGlobal command.
    this.dispatchSseEvent({ type: "GlobalEventPublished", event });
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
