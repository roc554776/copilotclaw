import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { createChannelTools } from "./tools/channel.js";

export type ChannelSessionStatus = "starting" | "waiting" | "processing";

export interface ChannelSessionInfo {
  status: ChannelSessionStatus;
  startedAt: string;
  processingStartedAt?: string;
}

interface ChannelSessionEntry {
  info: ChannelSessionInfo;
  client: CopilotClient;
  abortController: AbortController;
  retryCount: number;
  lastOldestInputId?: string;
}

export interface ChannelSessionManagerOptions {
  gatewayBaseUrl: string;
  staleTimeoutMs?: number;
}

const DEFAULT_STALE_TIMEOUT_MS = 10 * 60 * 1000;

export class ChannelSessionManager {
  private readonly sessions = new Map<string, ChannelSessionEntry>();
  private readonly gatewayBaseUrl: string;
  private readonly staleTimeoutMs: number;

  constructor(options: ChannelSessionManagerOptions) {
    this.gatewayBaseUrl = options.gatewayBaseUrl;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  }

  getChannelStatuses(): Record<string, ChannelSessionInfo> {
    const result: Record<string, ChannelSessionInfo> = {};
    for (const [channelId, entry] of this.sessions) {
      result[channelId] = { ...entry.info };
    }
    return result;
  }

  getChannelStatus(channelId: string): ChannelSessionInfo | undefined {
    const entry = this.sessions.get(channelId);
    if (entry === undefined) return undefined;
    return { ...entry.info };
  }

  hasSession(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  startSession(channelId: string): void {
    if (this.sessions.has(channelId)) return;

    const abortController = new AbortController();
    const client = new CopilotClient();
    const entry: ChannelSessionEntry = {
      info: { status: "starting", startedAt: new Date().toISOString() },
      client,
      abortController,
      retryCount: 0,
    };
    this.sessions.set(channelId, entry);

    this.runSession(channelId, entry).catch((err: unknown) => {
      console.error(`[agent] channel ${channelId.slice(0, 8)} session error:`, err);
    }).finally(() => {
      this.sessions.delete(channelId);
      client.stop().catch(() => {});
    });
  }

  private async runSession(channelId: string, entry: ChannelSessionEntry): Promise<void> {
    const { receiveFirstInput, replyAndReceiveInput } = createChannelTools({
      gatewayBaseUrl: this.gatewayBaseUrl,
      channelId,
      onStatusChange: (status) => {
        entry.info.status = status;
        if (status === "processing") {
          entry.info.processingStartedAt = new Date().toISOString();
        }
      },
    });

    const session = await entry.client.createSession({
      model: "gpt-4.1",
      onPermissionRequest: approveAll,
      tools: [receiveFirstInput, replyAndReceiveInput],
    });

    entry.info.status = "waiting";

    await runSessionLoop({
      session: adaptCopilotSession(session),
      initialPrompt:
        "Call the copilotclaw_receive_first_input tool now to receive the first user input.",
      continuePrompt:
        "Call the copilotclaw_reply_and_receive_input tool to reply to the user and receive the next input. Do NOT stop without calling this tool.",
      maxTurns: 1000,
      onMessage: (content) => { console.log(`[ch:${channelId.slice(0, 8)}] ${content}`); },
      log: (message) => { console.error(`[agent:${channelId.slice(0, 8)}] ${message}`); },
      shouldStop: () => entry.abortController.signal.aborted,
    });
  }

  stopSession(channelId: string): void {
    const entry = this.sessions.get(channelId);
    if (entry === undefined) return;
    entry.abortController.abort();
  }

  async stopAll(): Promise<void> {
    for (const [, entry] of this.sessions) {
      entry.abortController.abort();
    }
    // Wait a tick for sessions to clean up
    await new Promise((r) => { setTimeout(r, 100); });
  }

  async checkStaleAndHandle(channelId: string, oldestInputId: string | undefined): Promise<"ok" | "flushed"> {
    const entry = this.sessions.get(channelId);
    if (entry === undefined) return "ok";
    if (entry.info.status !== "processing") return "ok";

    const processingStartedAt = entry.info.processingStartedAt;
    if (processingStartedAt === undefined) return "ok";

    const elapsed = Date.now() - new Date(processingStartedAt).getTime();
    if (elapsed < this.staleTimeoutMs) return "ok";

    // Stale processing detected
    if (oldestInputId !== undefined && oldestInputId === entry.lastOldestInputId) {
      entry.retryCount++;
    } else {
      entry.retryCount = 0;
    }
    if (oldestInputId !== undefined) {
      entry.lastOldestInputId = oldestInputId;
    }

    if (entry.retryCount > 1) {
      // Same oldest input stuck after retry — flush and stop
      console.error(`[agent] channel ${channelId.slice(0, 8)} stuck after retry, flushing inputs`);
      this.stopSession(channelId);
      return "flushed";
    }

    // Restart session (first retry)
    console.error(`[agent] channel ${channelId.slice(0, 8)} stale processing (${Math.round(elapsed / 1000)}s), restarting session`);
    this.stopSession(channelId);
    // Wait for session to wind down, then restart
    await new Promise((r) => { setTimeout(r, 200); });
    this.sessions.delete(channelId);
    this.startSession(channelId);
    return "ok";
  }
}
