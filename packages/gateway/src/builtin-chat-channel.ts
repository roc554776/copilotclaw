import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentManager } from "./agent-manager.js";
import type { ChannelProvider } from "./channel-provider.js";
import { renderDashboard, type DashboardAgentStatus } from "./dashboard.js";
import { hasFrontendDist } from "./frontend-dist.js";
import type { Store } from "./store.js";
import type { SseBroadcaster } from "./sse-broadcaster.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const GATEWAY_VERSION = (JSON.parse(readFileSync(join(thisDir, "..", "package.json"), "utf-8")) as { version: string }).version;

export interface BuiltinChatChannelDeps {
  store: Store;
  agentManager: AgentManager | null;
  sseBroadcaster: SseBroadcaster;
}

/**
 * Built-in chat channel provider.
 *
 * Handles the browser-based chat UI dashboard at "/".
 * This is a channel provider implementation — the same interface that
 * future Discord, Telegram, etc. providers would implement.
 */
export class BuiltinChatChannel implements ChannelProvider {
  readonly type = "builtin-chat";
  private readonly store: Store;
  private readonly agentManager: AgentManager | null;
  private readonly sseBroadcaster: SseBroadcaster;

  constructor(deps: BuiltinChatChannelDeps) {
    this.store = deps.store;
    this.agentManager = deps.agentManager;
    this.sseBroadcaster = deps.sseBroadcaster;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): Promise<boolean> {
    const { method, url } = req;
    const pathname = url?.split("?")[0] ?? "/";

    // Dashboard route — skip if React SPA frontend is available (served by server.ts)
    if (pathname === "/" && method === "GET" && hasFrontendDist()) {
      return false;
    }
    if (pathname === "/" && method === "GET") {
      const channels = this.store.listChannels();
      const selectedChannelId = params.get("channel") ?? channels[0]?.id;
      // listMessages returns reverse-chronological; reverse for dashboard (oldest first)
      const chatMessages = selectedChannelId !== undefined ? this.store.listMessages(selectedChannelId, 100).reverse() : [];

      let dashboardAgentStatus: DashboardAgentStatus | undefined;
      if (this.agentManager !== null) {
        try {
          const agentInfo = await this.agentManager.getStatus();
          if (agentInfo !== null) {
            let sessionStatus: string | undefined;
            if (selectedChannelId !== undefined) {
              for (const sess of Object.values(agentInfo.sessions)) {
                if (sess.boundChannelId === selectedChannelId) {
                  sessionStatus = sess.status;
                  break;
                }
              }
            }
            dashboardAgentStatus = {
              gatewayVersion: GATEWAY_VERSION,
              sessionStatus: sessionStatus ?? "no session",
            };
            if (agentInfo.version !== undefined) {
              dashboardAgentStatus.version = agentInfo.version;
            }
            // Add compatibility status
            const compat = await this.agentManager?.checkCompatibility();
            if (compat !== undefined) {
              dashboardAgentStatus.compatibility = compat;
            }
          }
        } catch {
          // Agent not reachable
        }
      }

      const html = renderDashboard(channels, chatMessages, selectedChannelId, dashboardAgentStatus);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    // SSE events route
    if (pathname === "/api/events" && method === "GET") {
      const channelId = params.get("channel") ?? undefined;
      this.sseBroadcaster.addClient(res, channelId);
      return true;
    }

    return false;
  }

  onMessage(channelId: string, sender: "user" | "agent" | "cron", message: string): void {
    this.sseBroadcaster.broadcast({
      type: "new_message",
      channelId,
      data: { sender, message },
    });
  }

  close(): void {
    this.sseBroadcaster.closeAll();
  }
}
