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
  sessionPromise: Promise<void>;
  generation: number;
  restarting: boolean;
}

export interface ChannelSessionManagerOptions {
  gatewayBaseUrl: string;
  staleTimeoutMs?: number;
}

const DEFAULT_STALE_TIMEOUT_MS = 10 * 60 * 1000;

export class ChannelSessionManager {
  private readonly sessions = new Map<string, ChannelSessionEntry>();
  private readonly restartCounts = new Map<string, number>();
  private readonly gatewayBaseUrl: string;
  private readonly staleTimeoutMs: number;
  private generationCounter = 0;

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
    const generation = ++this.generationCounter;
    const entry: ChannelSessionEntry = {
      info: { status: "starting", startedAt: new Date().toISOString() },
      client,
      abortController,
      sessionPromise: Promise.resolve(),
      generation,
      restarting: false,
    };

    const promise = this.runSession(channelId, entry).catch((err: unknown) => {
      console.error(`[agent] channel ${channelId.slice(0, 8)} session error:`, err);
    }).finally(() => {
      // Only delete if this is still the current generation
      const current = this.sessions.get(channelId);
      if (current !== undefined && current.generation === generation) {
        this.sessions.delete(channelId);
        this.restartCounts.delete(channelId);
      }
      client.stop().catch(() => {});
    });

    entry.sessionPromise = promise;
    this.sessions.set(channelId, entry);
  }

  private async runSession(channelId: string, entry: ChannelSessionEntry): Promise<void> {
    const { receiveFirstInput, replyAndReceiveInput } = createChannelTools({
      gatewayBaseUrl: this.gatewayBaseUrl,
      channelId,
      abortSignal: entry.abortController.signal,
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
    const promises: Promise<void>[] = [];
    for (const [, entry] of this.sessions) {
      entry.abortController.abort();
      promises.push(entry.sessionPromise);
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => { timeoutHandle = setTimeout(r, 5000); });
    await Promise.race([
      Promise.allSettled(promises).finally(() => { clearTimeout(timeoutHandle); }),
      timeout,
    ]);
  }

  async checkStaleAndHandle(channelId: string, oldestInputId: string | undefined): Promise<"ok" | "flushed"> {
    const entry = this.sessions.get(channelId);
    if (entry === undefined) return "ok";
    if (entry.restarting) return "ok";
    if (entry.info.status !== "processing") return "ok";

    const processingStartedAt = entry.info.processingStartedAt;
    if (processingStartedAt === undefined) return "ok";

    const elapsed = Date.now() - new Date(processingStartedAt).getTime();
    if (elapsed < this.staleTimeoutMs) return "ok";

    // Don't restart if there are no pending inputs (agent may be legitimately finishing)
    if (oldestInputId === undefined) return "ok";

    // Track restart count at manager level (survives session restarts)
    const restarts = this.restartCounts.get(channelId) ?? 0;

    if (restarts >= 1) {
      // Already restarted once and still stuck — flush and give up
      console.error(`[agent] channel ${channelId.slice(0, 8)} stuck after ${restarts} restart(s), flushing inputs`);
      this.stopSession(channelId);
      this.restartCounts.delete(channelId);
      return "flushed";
    }

    // First stale detection — restart session
    console.error(`[agent] channel ${channelId.slice(0, 8)} stale processing (${Math.round(elapsed / 1000)}s), restarting session`);
    this.restartCounts.set(channelId, restarts + 1);
    entry.restarting = true;
    this.stopSession(channelId);
    await entry.sessionPromise.catch(() => {});
    this.startSession(channelId);
    // Clear restart count — the restart succeeded, give the new session a fresh start
    this.restartCounts.delete(channelId);
    return "ok";
  }
}
