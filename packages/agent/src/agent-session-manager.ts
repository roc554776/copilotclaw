import { randomUUID } from "node:crypto";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { createChannelTools } from "./tools/channel.js";

export type AgentSessionStatus = "starting" | "waiting" | "processing";

export interface AgentSessionInfo {
  status: AgentSessionStatus;
  startedAt: string;
  processingStartedAt?: string;
  boundChannelId?: string;
}

interface AgentSessionEntry {
  sessionId: string;
  info: AgentSessionInfo;
  client: CopilotClient;
  abortController: AbortController;
  sessionPromise: Promise<void>;
  generation: number;
  restarting: boolean;
}

export interface AgentSessionManagerOptions {
  gatewayBaseUrl: string;
  staleTimeoutMs?: number;
}

export interface StartSessionOptions {
  boundChannelId?: string;
}

const DEFAULT_STALE_TIMEOUT_MS = 10 * 60 * 1000;

export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSessionEntry>();
  private readonly channelBindings = new Map<string, string>(); // channelId → sessionId
  private readonly restartCounts = new Map<string, number>(); // channelId → count (persists across session restarts)
  private readonly gatewayBaseUrl: string;
  private readonly staleTimeoutMs: number;
  private generationCounter = 0;

  constructor(options: AgentSessionManagerOptions) {
    this.gatewayBaseUrl = options.gatewayBaseUrl;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  }

  getSessionStatuses(): Record<string, AgentSessionInfo> {
    const result: Record<string, AgentSessionInfo> = {};
    for (const [sessionId, entry] of this.sessions) {
      result[sessionId] = { ...entry.info };
    }
    return result;
  }

  getSessionStatus(sessionId: string): AgentSessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return undefined;
    return { ...entry.info };
  }

  hasSessionForChannel(channelId: string): boolean {
    return this.channelBindings.has(channelId);
  }

  startSession(options?: StartSessionOptions): string {
    const boundChannelId = options?.boundChannelId;

    // Prevent duplicate session for same channel
    if (boundChannelId !== undefined && this.channelBindings.has(boundChannelId)) {
      return this.channelBindings.get(boundChannelId)!;
    }

    const sessionId = randomUUID();
    const abortController = new AbortController();
    const client = new CopilotClient();
    const generation = ++this.generationCounter;
    const entry: AgentSessionEntry = {
      sessionId,
      info: {
        status: "starting",
        startedAt: new Date().toISOString(),
      },
      client,
      abortController,
      sessionPromise: Promise.resolve(),
      generation,
      restarting: false,
    };

    if (boundChannelId !== undefined) {
      entry.info.boundChannelId = boundChannelId;
      this.channelBindings.set(boundChannelId, sessionId);
    }

    const promise = this.runSession(entry).catch((err: unknown) => {
      console.error(`[agent] session ${sessionId.slice(0, 8)} error:`, err);
    }).finally(() => {
      // Only delete if this is still the current generation
      const current = this.sessions.get(sessionId);
      if (current !== undefined && current.generation === generation) {
        this.sessions.delete(sessionId);
        if (boundChannelId !== undefined) {
          // Only unbind if still bound to this session
          if (this.channelBindings.get(boundChannelId) === sessionId) {
            this.channelBindings.delete(boundChannelId);
            // Only reset the restart count when the session ended normally (not during a
            // controlled restart). The restarting flag is set before stopSession() is called
            // so the finally block can distinguish the two cases.
            if (!current.restarting) {
              this.restartCounts.delete(boundChannelId);
            }
          }
        }
      }
      client.stop().catch(() => {});
    });

    entry.sessionPromise = promise;
    this.sessions.set(sessionId, entry);
    return sessionId;
  }

  private async runSession(entry: AgentSessionEntry): Promise<void> {
    const channelId = entry.info.boundChannelId;
    if (channelId === undefined) {
      throw new Error("channel-less sessions not yet supported");
    }

    const { sendMessage, receiveInput, listMessages } = createChannelTools({
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

    const gatewayBaseUrl = this.gatewayBaseUrl;
    const signal = entry.abortController.signal;

    const session = await entry.client.createSession({
      model: "gpt-4.1",
      onPermissionRequest: approveAll,
      tools: [sendMessage, receiveInput, listMessages],
      hooks: {
        onPostToolUse: async () => {
          // Check if channel has pending user inputs
          try {
            if (signal.aborted) return;
            const fetchOpts: RequestInit = { signal };
            const res = await fetch(`${gatewayBaseUrl}/api/channels/${channelId}/inputs/peek`, fetchOpts);
            if (res.status === 200) {
              return {
                additionalContext: `[NOTIFICATION] New user input is available on the channel. Call copilotclaw_receive_input immediately to read it.`,
              };
            }
          } catch {
            // Ignore errors (e.g. aborted)
          }
          return;
        },
      },
    });

    entry.info.status = "waiting";

    const logPrefix = channelId.slice(0, 8);
    await runSessionLoop({
      session: adaptCopilotSession(session),
      initialPrompt:
        "You are a copilotclaw agent bound to a channel. " +
        "Call copilotclaw_receive_input now to receive the first user input. " +
        "After processing input, use copilotclaw_send_message to send your response, then call copilotclaw_receive_input again to wait for the next input. " +
        "You may receive notifications about new user input via additionalContext in tool responses — when notified, call copilotclaw_receive_input immediately. " +
        "Never stop without calling copilotclaw_receive_input.",
      onMessage: (content) => { console.log(`[ch:${logPrefix}] ${content}`); },
      log: (message) => { console.error(`[agent:${logPrefix}] ${message}`); },
      shouldStop: () => entry.abortController.signal.aborted,
    });
  }

  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.abortController.abort();
  }

  stopSessionForChannel(channelId: string): void {
    const sessionId = this.channelBindings.get(channelId);
    if (sessionId !== undefined) {
      this.stopSession(sessionId);
    }
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

  async checkStaleAndHandle(sessionId: string, oldestInputId: string | undefined): Promise<"ok" | "flushed"> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return "ok";
    if (entry.restarting) return "ok";
    if (entry.info.status !== "processing") return "ok";

    const processingStartedAt = entry.info.processingStartedAt;
    if (processingStartedAt === undefined) return "ok";

    const elapsed = Date.now() - new Date(processingStartedAt).getTime();
    if (elapsed < this.staleTimeoutMs) return "ok";

    // Don't restart if there are no pending inputs (agent may be legitimately finishing)
    if (oldestInputId === undefined) return "ok";

    // Track restart count by channelId so it survives session restarts
    const boundChannelId = entry.info.boundChannelId;
    const countKey = boundChannelId ?? sessionId;
    const restarts = this.restartCounts.get(countKey) ?? 0;

    if (restarts >= 1) {
      // Already restarted once and still stuck — flush and give up
      console.error(`[agent] session ${sessionId.slice(0, 8)} stuck after ${restarts} restart(s), flushing inputs`);
      this.stopSession(sessionId);
      this.restartCounts.delete(countKey);
      return "flushed";
    }

    // First stale detection — restart session
    console.error(`[agent] session ${sessionId.slice(0, 8)} stale processing (${Math.round(elapsed / 1000)}s), restarting session`);
    this.restartCounts.set(countKey, restarts + 1);
    entry.restarting = true;
    this.stopSession(sessionId);
    await entry.sessionPromise.catch(() => {});

    // Start a new session bound to the same channel
    if (boundChannelId !== undefined) {
      this.startSession({ boundChannelId });
    }
    return "ok";
  }

  /** Get the sessionId bound to a channel, if any */
  getSessionIdForChannel(channelId: string): string | undefined {
    return this.channelBindings.get(channelId);
  }

  /** Get the boundChannelId for a session, if any */
  getBoundChannelId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.info.boundChannelId;
  }
}
