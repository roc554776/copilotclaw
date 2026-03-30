import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentPromptConfig } from "./agent-config.js";
import { AgentManager } from "./agent-manager.js";
import { getProfileName, getStateDir, loadConfig, resolvePort } from "./config.js";
import { LogBuffer } from "./log-buffer.js";
import { initOtel, shutdownOtel } from "./otel.js";
import { initMetrics } from "./otel-metrics.js";
import { startServer } from "./server.js";
import { SessionEventStore } from "./session-event-store.js";
import { Store } from "./store.js";
import { ensureWorkspace, getDataDir, getStoreDbPath, getStoreFilePath, getWorkspaceRoot } from "./workspace.js";

const AGENT_MONITOR_INTERVAL_MS = 30_000; // 30 seconds
const AGENT_MONITOR_ERROR_THRESHOLD = 3;

async function main(): Promise<void> {
  const forceAgentRestart = process.env["COPILOTCLAW_FORCE_AGENT_RESTART"] === "1";

  ensureWorkspace(getProfileName());
  const logBuffer = new LogBuffer();
  logBuffer.enableFileOutput(join(getDataDir(getProfileName()), "gateway.log"));
  logBuffer.interceptConsole();

  // Initialize OpenTelemetry (before any structured logging)
  const config = loadConfig(getProfileName());
  const otelEndpoints = config.otel?.endpoints ?? [];
  initOtel({ endpoints: otelEndpoints, serviceName: "copilotclaw-gateway" });
  initMetrics();
  const store = new Store({ persistPath: getStoreDbPath(getProfileName()), legacyJsonPath: getStoreFilePath(getProfileName()) });
  const port = resolvePort(getProfileName());
  const agentManager = new AgentManager();

  const sessionEventStore = new SessionEventStore(getDataDir(getProfileName()));

  // Set up IPC stream message handlers before connecting
  agentManager.setStreamMessageHandler({
    onChannelMessage: (channelId, sender, message) => {
      const senderType = sender === "user" ? "user" as const : sender === "cron" ? "cron" as const : sender === "system" ? "system" as const : "agent" as const;
      store.addMessage(channelId, senderType, message);
      // Broadcast to SSE clients (serverHandle.sseBroadcaster set after startServer)
      serverHandle?.sseBroadcaster?.broadcast({
        type: "new_message",
        channelId,
        data: { sender: senderType, message },
      });
    },
    onSessionEvent: (sessionId, channelId, eventType, timestamp, data, parentId) => {
      const event: { type: string; timestamp: string; data: Record<string, unknown>; parentId?: string } = {
        type: eventType,
        timestamp,
        data,
      };
      if (parentId !== undefined) event.parentId = parentId;
      sessionEventStore.appendEvent(sessionId, event);

      // Cache quotaSnapshots from assistant.usage events to disk
      if (eventType === "assistant.usage" && data["quotaSnapshots"] !== undefined) {
        try {
          const cacheDir = join(getStateDir(getProfileName()), "data");
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(join(cacheDir, "quota-cache.json"), JSON.stringify({ quotaSnapshots: data["quotaSnapshots"] }, null, 2) + "\n", "utf-8");
        } catch { /* ignore */ }
      }

      // Subagent completion/failure: insert system message and notify agent
      if (channelId !== undefined && (eventType === "subagent.completed" || eventType === "subagent.failed")) {
        // Only notify for direct subagent calls (no parentToolCallId in the event data)
        // Nested subagent events carry parentToolCallId from the outer task tool
        if (data["parentToolCallId"] === undefined) {
          const agentName = data["agentName"] as string ?? "unknown";
          const status = eventType === "subagent.completed" ? "completed" : "failed";
          const error = typeof data["error"] === "string" ? ` (error: ${data["error"]})` : "";
          const msg = `[SUBAGENT ${status.toUpperCase()}] ${agentName} ${status}${error}`;
          store.addMessage(channelId, "system", msg);
          agentManager.notifyAgent(channelId);
        }
      }
    },
    onSystemPromptOriginal: (model, prompt, capturedAt) => {
      sessionEventStore.saveOriginalPrompt({ model, prompt, capturedAt });
    },
    onSystemPromptSession: (sessionId, model, prompt) => {
      sessionEventStore.saveEffectivePrompt(sessionId, prompt, model);
    },
    onDrainPending: (channelId) => {
      return store.drainPending(channelId);
    },
    onPeekPending: (channelId) => {
      return store.peekOldestPending(channelId) ?? null;
    },
    onFlushPending: (channelId) => {
      return store.flushPending(channelId);
    },
    onListMessages: (channelId, limit) => {
      return store.listMessages(channelId, limit);
    },
  });

  // Set config to push to agent when stream connects
  agentManager.setConfigToSend({
    model: config.model ?? null,
    zeroPremium: config.zeroPremium ?? false,
    debugMockCopilotUnsafeTools: config.debugMockCopilotUnsafeTools ?? false,
    stateDir: getStateDir(getProfileName()),
    workspaceRoot: getWorkspaceRoot(getProfileName()),
    auth: config.auth?.github ?? null,
    otel: config.otel ?? null,
    debug: config.debug ?? null,
    prompts: getAgentPromptConfig(),
  });

  // Always ensure agent process on gateway start (version check + spawn if absent)
  try {
    const oldBootId = await agentManager.ensureAgent({ forceRestart: forceAgentRestart });
    // If force-restart was performed, wait for the new agent to come up
    if (oldBootId !== undefined) {
      console.error("[gateway] waiting for new agent to start...");
      const ok = await agentManager.waitForNewAgent(oldBootId);
      if (ok) {
        console.error("[gateway] new agent started successfully");
      } else {
        console.error("[gateway] WARNING: new agent did not start within timeout");
      }
    }
  } catch (err: unknown) {
    console.error("[gateway] agent ensure failed:", err);
  }

  // Establish IPC stream connection to agent (after agent is ensured)
  agentManager.connectStream();

  // Need to capture serverHandle for SSE broadcaster access in stream handler
  let serverHandle: Awaited<ReturnType<typeof startServer>> | undefined;
  serverHandle = await startServer({ port, store, agentManager, logBuffer, sessionEventStore, stateDir: getStateDir(getProfileName()) });

  // Cron scheduler: periodically send cron messages to channels
  const cronJobs = config.cron ?? [];
  const cronTimers: ReturnType<typeof setInterval>[] = [];
  for (const job of cronJobs) {
    if (job.enabled === false) {
      console.error(`[gateway] cron job '${job.id}' skipped (disabled)`);
      continue;
    }
    const timer = setInterval(() => {
      const prefix = `[cron:${job.id}] `;
      if (store.hasPendingCronMessage(job.channelId, prefix)) return;
      const msg = store.addMessage(job.channelId, "cron", `${prefix}${job.message}`);
      if (msg !== undefined) {
        agentManager.notifyAgent(job.channelId);
      }
    }, job.intervalMs);
    timer.unref();
    cronTimers.push(timer);
    console.error(`[gateway] cron job '${job.id}' scheduled for channel ${job.channelId.slice(0, 8)} every ${Math.round(job.intervalMs / 1000)}s`);
  }

  // Periodic agent process monitoring
  let consecutiveFailures = 0;
  const monitor = setInterval(async () => {
    try {
      await agentManager.ensureAgent();
      if (consecutiveFailures > 0) {
        console.error("[gateway] agent process recovered");
      }
      consecutiveFailures = 0;
    } catch (err: unknown) {
      consecutiveFailures++;
      if (consecutiveFailures >= AGENT_MONITOR_ERROR_THRESHOLD) {
        console.error(`[gateway] agent process ERROR: health check failed after ${consecutiveFailures} attempts:`, err);
      } else {
        console.error(`[gateway] agent ensure failed (attempt ${consecutiveFailures}/${AGENT_MONITOR_ERROR_THRESHOLD}):`, err);
      }
    }
  }, AGENT_MONITOR_INTERVAL_MS);
  monitor.unref();

  // Graceful OTel shutdown on process exit
  const gracefulShutdown = async (): Promise<void> => {
    agentManager.closeStream();
    await shutdownOtel();
    process.exit(0);
  };
  process.once("SIGTERM", () => { gracefulShutdown().catch(console.error); });
  process.once("SIGINT", () => { gracefulShutdown().catch(console.error); });
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
