import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Channel provider interface.
 *
 * A channel provider is a plugin that connects a specific communication
 * medium (built-in chat UI, Discord, Telegram, etc.) to the gateway core.
 *
 * The gateway core handles channel-agnostic concerns:
 * - Channel and message persistence (Store)
 * - Agent session management
 * - Message pending queue
 *
 * Channel providers handle medium-specific concerns:
 * - UI rendering (for built-in chat)
 * - External service integration (for Discord, Telegram, etc.)
 * - HTTP routes specific to the medium
 */
export interface ChannelProvider {
  /** Unique identifier for this provider type (e.g. "builtin-chat", "discord") */
  readonly type: string;

  /**
   * Try to handle an HTTP request. Return true if handled, false to pass to next handler.
   * This allows providers to register their own routes (e.g. "/" for dashboard, "/webhook" for Discord).
   */
  handleRequest(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): Promise<boolean>;

  /** Called when a new message is added to any channel managed by this provider */
  onMessage?(channelId: string, sender: "user" | "agent" | "cron", message: string): void;

  /** Called on server shutdown */
  close?(): void;
}
