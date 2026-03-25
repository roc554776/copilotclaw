import type { ServerResponse } from "node:http";

export interface SseClient {
  res: ServerResponse;
  channelId: string | undefined;
}

/**
 * Server-Sent Events broadcaster. Uses SSE instead of WebSocket
 * because Node.js 22 has no built-in WebSocketServer and SSE
 * requires no external dependencies.
 */
export class WsBroadcaster {
  private readonly clients = new Set<SseClient>();

  addClient(res: ServerResponse, channelId: string | undefined): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":\n\n"); // SSE comment as keepalive

    const client: SseClient = { res, channelId };
    this.clients.add(client);

    res.on("close", () => { this.clients.delete(client); });
  }

  broadcast(event: { type: string; channelId?: string; data?: unknown }): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (event.channelId === undefined || client.channelId === undefined || client.channelId === event.channelId) {
        client.res.write(payload);
      }
    }
  }

  broadcastAll(event: { type: string; data?: unknown }): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      client.res.write(payload);
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
