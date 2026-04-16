import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentPromptConfig, resolveModel } from "./agent-config.js";
import { AgentManager } from "./agent-manager.js";
import { type CronJobConfig, getProfileName, getStateDir, loadConfig, loadFileConfig, resolvePort, saveConfig } from "./config.js";
import { IntentsStore, intentsStore } from "./intents-store.js";
import { LogBuffer } from "./log-buffer.js";
import { type ChannelOperatorMeta, resolveAgentSenderMeta, type SubagentResolver } from "./message-sender.js";
import { initOtel, shutdownOtel } from "./otel.js";
import { initMetrics } from "./otel-metrics.js";
import { startServer } from "./server.js";
import { SessionController } from "./session-controller.js";
import { type SessionEvent, SessionEventStore } from "./session-event-store.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { type MessageSenderMeta, Store } from "./store.js";
import { ensureWorkspace, getDataDir, getStoreDbPath, getStoreFilePath, getWorkspaceRoot } from "./workspace.js";

const AGENT_MONITOR_INTERVAL_MS = 30_000; // 30 seconds
const AGENT_MONITOR_ERROR_THRESHOLD = 3;
const ORCHESTRATOR_CHECK_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Broadcasts a channel_list_change global SSE event with the current full channel list.
 * Exported so integration tests can import and exercise the exact same code path,
 * eliminating the risk of test/implementation drift.
 */
export function broadcastChannelListChange(
  store: Store,
  sseBroadcaster: { broadcastGlobal: (event: import("./sse-broadcaster.js").GlobalSseEvent) => void },
): void {
  try {
    const channels = store.listChannels({ includeArchived: true });
    sseBroadcaster.broadcastGlobal({ type: "channel_list_change", channels });
  } catch (err) {
    console.error("Failed to broadcast channel_list_change", err);
  }
}

/**
 * Wires the Store's channel list change callback to `broadcastChannelListChange`.
 * Exported as a named function so integration tests can import and verify the wire-up directly,
 * ensuring that tests break if this coupling is accidentally changed (drift prevention).
 */
export function wireStoreToChannelListChange(
  store: Store,
  sseBroadcaster: { broadcastGlobal: (event: import("./sse-broadcaster.js").GlobalSseEvent) => void },
): void {
  store.setOnChannelListChange(() => {
    broadcastChannelListChange(store, sseBroadcaster);
  });
}

/**
 * Broadcasts a token_usage_update global SSE event when an assistant.usage session event is appended.
 * Exported so integration tests can import and exercise the exact same code path,
 * eliminating the risk of test/implementation drift.
 */
export function broadcastTokenUsageIfNeeded(
  event: SessionEvent,
  sessionEventStore: SessionEventStore,
  sseBroadcaster: { broadcastGlobal: (event: import("./sse-broadcaster.js").GlobalSseEvent) => void },
): void {
  if (event.type !== "assistant.usage") return;
  try {
    const now = new Date();
    const from5h = new Date(now.getTime() - 5 * 3600_000).toISOString();
    const summary = sessionEventStore.getTokenUsage(from5h, now.toISOString());
    sseBroadcaster.broadcastGlobal({ type: "token_usage_update", summary });
  } catch (err) {
    console.error("[gateway] token_usage_update broadcast failed:", err);
  }
}

export interface IntentToolCallRequest {
  sessionId: string;
  channelId?: string;
  agentId?: string;
  agentDisplayName?: string;
  args?: Record<string, unknown>;
}

export function handleIntentToolCall(
  request: IntentToolCallRequest,
  store: IntentsStore,
): { acknowledged: true } {
  const args = (request.args ?? {}) as Record<string, unknown>;
  const intent = typeof args["intent"] === "string" ? args["intent"] : "";
  if (intent.length > 0) {
    const entry: import("./intents-store.js").IntentEntry = {
      sessionId: request.sessionId,
      channelId: request.channelId ?? "",
      agentId: request.agentId ?? "unknown",
      intent,
      timestamp: new Date().toISOString(),
    };
    if (request.agentDisplayName !== undefined) entry.agentDisplayName = request.agentDisplayName;
    store.recordIntent(entry);
  }
  return { acknowledged: true };
}

/**
 * Re-exported from session-replay.ts so integration tests can import from daemon.ts
 * following the same pattern as broadcastTokenUsageIfNeeded and broadcastChannelListChange.
 */
export { replaySessionEventsAfter } from "./session-replay.js";

export interface AssistantMessageEventDeps {
  store: Store;
  orchestrator: SubagentResolver;
  channelOperatorMeta: ChannelOperatorMeta;
  sseBroadcast?: (event: Record<string, unknown>) => void;
}

/**
 * Handles an assistant.message session event: resolves senderMeta via resolveAgentSenderMeta,
 * stores the message in the channel timeline, and optionally broadcasts to SSE clients.
 *
 * Exported as a named function so tests can import and call the real code path directly,
 * preventing drift between the test replica and the daemon's onSessionEvent handler.
 */
export function handleAssistantMessageEvent(
  sessionId: string,
  channelId: string,
  data: Record<string, unknown>,
  deps: AssistantMessageEventDeps,
): { stored: boolean; senderMeta?: MessageSenderMeta } {
  const content = typeof data["content"] === "string" ? data["content"] : "";
  if (content.length === 0) return { stored: false };
  const parentToolCallId = typeof data["parentToolCallId"] === "string" ? data["parentToolCallId"] : undefined;
  const senderMeta = resolveAgentSenderMeta(sessionId, parentToolCallId, deps.orchestrator, deps.channelOperatorMeta);
  deps.store.addMessage(channelId, "agent", content, senderMeta);
  deps.sseBroadcast?.({ type: "new_message", channelId, data: { sender: "agent", message: content, senderMeta } });
  return { stored: true, senderMeta };
}

export interface SendMessageToolCallDeps {
  store: Store;
  channelOperatorMeta: ChannelOperatorMeta;
  sseBroadcast?: (event: Record<string, unknown>) => void;
}

/**
 * Handles the copilotclaw_send_message tool call: resolves senderMeta for the channel-operator
 * (send_message is only callable from channel-operator, never subagents), stores the message,
 * and optionally broadcasts to SSE clients.
 *
 * Exported as a named function so tests can import and call the real code path directly,
 * preventing drift between test expectations and the daemon's onToolCall handler.
 */
export function handleSendMessageToolCall(
  sessionId: string,
  channelId: string,
  message: string,
  deps: SendMessageToolCallDeps,
): { senderMeta: MessageSenderMeta } {
  const senderMeta = resolveAgentSenderMeta(sessionId, undefined, {}, deps.channelOperatorMeta);
  deps.store.addMessage(channelId, "agent", message, senderMeta);
  deps.sseBroadcast?.({ type: "new_message", channelId, data: { sender: "agent", message, senderMeta } });
  return { senderMeta };
}

export interface ChannelMessageAgentDeps {
  store: Store;
  orchestrator: SubagentResolver;
  channelOperatorMeta: ChannelOperatorMeta;
  sseBroadcast?: (event: Record<string, unknown>) => void;
}

/**
 * Handles the "agent" sender branch of the onChannelMessage IPC backward-compatible path.
 * Assigns channel-operator senderMeta to agent messages received via the legacy channel_message IPC path.
 *
 * Exported as a named function so tests can import and verify senderMeta is correctly assigned,
 * preventing silent drift in the backward-compatible IPC path.
 */
export function handleChannelMessageAgent(
  sessionId: string,
  channelId: string,
  message: string,
  deps: ChannelMessageAgentDeps,
): { senderMeta: MessageSenderMeta } {
  const senderMeta = resolveAgentSenderMeta(sessionId, undefined, deps.orchestrator, deps.channelOperatorMeta);
  deps.store.addMessage(channelId, "agent", message, senderMeta);
  deps.sseBroadcast?.({ type: "new_message", channelId, data: { sender: "agent", message, senderMeta } });
  return { senderMeta };
}

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

  // Wire intentsStore to the Store for SQLite persistence (v0.79.0)
  intentsStore.init(store);

  // Sync channel model settings from config.json to DB on startup
  const channelConfigs = config.channels ?? {};
  for (const [channelId, chConfig] of Object.entries(channelConfigs)) {
    const ch = store.getChannel(channelId);
    if (ch !== undefined) {
      store.updateChannelModel(channelId, chConfig.model ?? null);
    }
  }

  const port = resolvePort(getProfileName());
  const agentManager = new AgentManager();

  const sessionEventStore = new SessionEventStore(getDataDir(getProfileName()));

  // Session orchestrator: manages abstract session lifecycle on the gateway side
  // Legacy migration: try session-orchestrator.json first (most recent), then agent-bindings.json (oldest)
  const dataDir = getDataDir(getProfileName());
  const legacyOrchestratorJson = join(dataDir, "session-orchestrator.json");
  const legacyBindingsJson = join(dataDir, "agent-bindings.json");
  const orchestrator = new SessionOrchestrator({
    persistPath: join(dataDir, "session-orchestrator.db"),
    legacyBindingsPath: existsSync(legacyOrchestratorJson) ? legacyOrchestratorJson : legacyBindingsJson,
    store, // v0.82.0: pass store for persistent channel backoff
  });
  const promptConfig = getAgentPromptConfig();

  // Channel-operator meta derived from agent-config customAgents (first non-infer agent)
  const channelOperatorAgent = promptConfig.customAgents.find((a) => !a.infer) ?? { name: "channel-operator", displayName: "Channel Operator" };
  const channelOperatorMetaForSender = { agentName: channelOperatorAgent.name, agentDisplayName: channelOperatorAgent.displayName };

  // Helper: resolve sessionId → channelId via orchestrator.
  const resolveChannelId = (sessionId: string): string | undefined => {
    return orchestrator.getSessionStatuses()[sessionId]?.channelId;
  };

  // Model multiplier cache for annotating assistant.usage events.
  const modelMultiplierCache = new Map<string, number>();

  // Resolve model for a channel, updating multiplier cache as a side effect.
  const resolveModelForChannel = async (channelId: string): Promise<string | undefined> => {
    const modelsResponse = await agentManager.getModels();
    const models = modelsResponse?.["models"] as Array<{ id: string; billing?: { multiplier?: number } }> | undefined;
    if (Array.isArray(models)) {
      for (const m of models) {
        if (m.billing?.multiplier !== undefined) {
          modelMultiplierCache.set(m.id, m.billing.multiplier);
        }
      }
    }
    const channel = store.getChannel(channelId);
    const configModel = channel?.model ?? config.model ?? null;
    return resolveModel(modelsResponse, configModel, config.zeroPremium ?? false);
  };

  // SessionController: centralizes session lifecycle and message delivery.
  const sessionController = new SessionController({
    orchestrator,
    store,
    agentManager,
    resolveModelForChannel,
  });

  // Helper: get reminder state from SessionController's per-session context.
  const getReminderState = (sessionId: string) => sessionController.getContext(sessionId).reminderState;

  const SWALLOWED_MESSAGE_INSTRUCTION =
    `[SYSTEM] CRITICAL: You received user message(s) but called copilotclaw_wait ` +
    `without sending a reply via copilotclaw_send_message. The user received NOTHING. ` +
    `You MUST call copilotclaw_send_message with your response NOW, then call copilotclaw_wait.`;

  // Set up IPC stream message handlers before connecting
  agentManager.setStreamMessageHandler({
    onToolCall: (request) => {
      // Gateway-side tool handler. All dynamic tools dispatch here via RPC.
      // Adding/modifying tools only requires gateway restart (no agent update).
      const channelId = resolveChannelId(request.sessionId);
      if (channelId === undefined) {
        return { error: `No channel bound to session ${request.sessionId}` };
      }
      switch (request.toolName) {
        case "copilotclaw_send_message": {
          const message = request.args["message"] as string ?? "";
          // copilotclaw_send_message is only callable from channel-operator (not subagents)
          handleSendMessageToolCall(request.sessionId, channelId, message, {
            store,
            channelOperatorMeta: channelOperatorMetaForSender,
            sseBroadcast: (event) => serverHandle?.sseBroadcaster?.broadcast(event as Parameters<typeof serverHandle.sseBroadcaster.broadcast>[0]),
          });
          // Clear swallowed-message flag — agent replied successfully
          sessionController.onAgentReplied(request.sessionId);
          return { status: "sent" };
        }
        case "copilotclaw_list_messages": {
          const limit = (request.args["limit"] as number) ?? 5;
          const messages = store.listMessages(channelId, limit);
          return { messages };
        }
        case "copilotclaw_intent": {
          const intentReq: IntentToolCallRequest = {
            sessionId: request.sessionId,
            channelId,
            agentId: typeof request.args["agentId"] === "string" ? request.args["agentId"] : "unknown",
            args: request.args,
          };
          if (typeof request.args["agentDisplayName"] === "string") {
            intentReq.agentDisplayName = request.args["agentDisplayName"];
          }
          return handleIntentToolCall(intentReq, intentsStore);
        }
        case "copilotclaw_wait": {
          // Swallowed-message guard
          if (sessionController.checkSwallowedMessage(request.sessionId)) {
            return { userMessage: SWALLOWED_MESSAGE_INSTRUCTION };
          }

          // Drain pending messages for the channel
          const drained = store.drainPending(channelId);
          if (drained.length > 0) {
            sessionController.onAgentDrainedMessages(request.sessionId, drained);
            const combined = drained.map((m) => {
              const sender = m.sender;
              const msg = m.message;
              if (sender === "cron") return `[CRON TASK] ${msg}`;
              if (sender === "system") return `[SYSTEM EVENT] ${msg}`;
              return msg;
            }).join("\n\n");
            return {
              userMessage: combined +
                "\n\n---\n[SYSTEM] Required workflow: (A) Call copilotclaw_send_message with your complete reply, " +
                "then (B) call copilotclaw_wait to wait for the next message. " +
                "You MUST call copilotclaw_send_message BEFORE copilotclaw_wait. " +
                "The user CANNOT see your text output — only messages sent via copilotclaw_send_message reach them. " +
                "Do NOT stop without calling copilotclaw_wait.",
            };
          }
          // No pending messages — return null so agent falls through to its keepalive loop
          return null;
        }
        default:
          return { error: `Unknown tool: ${request.toolName}` };
      }
    },
    onLifecycle: (request) => {
      return sessionController.decideLifecycleAction(request.sessionId, request.event);
    },
    onHook: (request) => {
      // Gateway-side hook handler. All SDK hooks are forwarded here via RPC.
      // Return a result object to control the hook's output, or null for no-op.
      // Adding new hook logic only requires gateway restart (no agent update).
      const hookChannelId = resolveChannelId(request.sessionId);
      switch (request.hookName) {
        case "onPostToolUse": {
          const parts: string[] = [];
          // Check for pending user messages
          if (hookChannelId !== undefined) {
            const oldest = store.peekOldestPending(hookChannelId);
            if (oldest !== undefined) {
              parts.push(`[NOTIFICATION] New user message is available on the channel. Call copilotclaw_wait immediately to read it.`);
            }
          }
          // Check reminder state: inject systemReminder when context usage crossed threshold
          const rs = getReminderState(request.sessionId);
          if (rs.needsReminder) {
            rs.needsReminder = false;
            rs.lastReminderPercent = rs.currentUsagePercent;
            parts.push(promptConfig.systemReminder);
          }
          if (parts.length > 0) {
            return { additionalContext: parts.join("\n\n") };
          }
          return null;
        }
        default:
          // Unknown hook — return null (agent uses fallback or no-op)
          return null;
      }
    },
    onChannelMessage: (sessionId, sender, message) => {
      const msgChannelId = resolveChannelId(sessionId);
      if (msgChannelId === undefined) return;
      const senderType = sender === "user" ? "user" as const : sender === "cron" ? "cron" as const : sender === "system" ? "system" as const : "agent" as const;
      if (senderType === "agent") {
        // IPC backward-compatible path: assign channel-operator senderMeta as default
        handleChannelMessageAgent(sessionId, msgChannelId, message, {
          store,
          orchestrator,
          channelOperatorMeta: channelOperatorMetaForSender,
          sseBroadcast: (event) => serverHandle?.sseBroadcaster?.broadcast(event as Parameters<typeof serverHandle.sseBroadcaster.broadcast>[0]),
        });
      } else {
        store.addMessage(msgChannelId, senderType, message);
        // Broadcast to SSE clients (serverHandle.sseBroadcaster set after startServer)
        serverHandle?.sseBroadcaster?.broadcast({
          type: "new_message",
          channelId: msgChannelId,
          data: { sender: senderType, message },
        });
      }
    },
    onSessionEvent: (sessionId, copilotSessionId, eventType, timestamp, data) => {
      const eventChannelId = resolveChannelId(sessionId);
      const event: { type: string; timestamp: string; data: Record<string, unknown> } = {
        type: eventType,
        timestamp,
        data,
      };
      // Annotate assistant.usage events with billing multiplier from cache
      if (eventType === "assistant.usage" && data["multiplier"] === undefined) {
        const model = data["model"] as string | undefined;
        if (model !== undefined) {
          const mult = modelMultiplierCache.get(model);
          if (mult !== undefined) {
            event.data = { ...data, multiplier: mult };
          }
        }
      }
      if (copilotSessionId !== undefined) {
        sessionEventStore.appendEvent(copilotSessionId, event);
      }

      // Route SDK events to SessionController for status tracking.
      const orchSessionId = sessionId;
      if (orchestrator.getSessionStatuses()[orchSessionId] !== undefined) {
        switch (eventType) {
          case "tool.execution_start": {
            const toolName = data["toolName"] as string ?? "unknown";
            sessionController.onToolExecutionStart(orchSessionId, toolName);
            break;
          }
          case "tool.execution_complete":
            sessionController.onToolExecutionComplete(orchSessionId);
            break;
          case "session.idle": {
            const bgTasks = data["backgroundTasks"];
            sessionController.onSessionIdle(orchSessionId, bgTasks != null);
            break;
          }
          case "session.usage_info": {
            const currentTokens = data["currentTokens"] as number ?? 0;
            const tokenLimit = data["tokenLimit"] as number ?? 0;
            sessionController.onUsageInfo(orchSessionId, currentTokens, tokenLimit);
            // Track context usage for periodic system prompt reminder
            if (tokenLimit > 0) {
              const rs = getReminderState(orchSessionId);
              rs.currentUsagePercent = currentTokens / tokenLimit;
              if (rs.currentUsagePercent >= rs.lastReminderPercent + promptConfig.reminderThresholdPercent) {
                rs.needsReminder = true;
              }
            }
            break;
          }
          case "assistant.usage":
            sessionController.onAssistantUsage(
              orchSessionId,
              data["inputTokens"] as number ?? 0,
              data["outputTokens"] as number ?? 0,
              data["quotaSnapshots"] as Record<string, unknown> | undefined,
            );
            break;
          case "session.compaction_complete": {
            // After compaction, the LLM may lose critical instructions. Flag immediate reminder.
            const compRs = getReminderState(orchSessionId);
            compRs.needsReminder = true;
            compRs.lastReminderPercent = 0; // Reset — usage drops after compaction
            break;
          }
          case "session.model_change":
            sessionController.onModelChange(orchSessionId, data["newModel"] as string ?? "unknown");
            break;
          case "subagent.started":
            sessionController.onSubagentStarted(orchSessionId, {
              toolCallId: data["toolCallId"] as string ?? "",
              agentName: data["agentName"] as string ?? "unknown",
              agentDisplayName: data["agentDisplayName"] as string ?? "unknown",
              status: "running",
              startedAt: timestamp,
            });
            break;
          case "subagent.completed":
            sessionController.onSubagentStatusChanged(orchSessionId, data["toolCallId"] as string ?? "", "completed");
            break;
          case "subagent.failed":
            sessionController.onSubagentStatusChanged(orchSessionId, data["toolCallId"] as string ?? "", "failed");
            break;
        }
      }

      // Reflect assistant.message to channel timeline as agent message.
      // The agent forwards all SDK events as session_event; gateway handles the
      // channel reflection here instead of the agent sending a separate channel_message.
      // parentToolCallId in the event data identifies subagent messages (SDK convention).
      if (eventChannelId !== undefined && eventType === "assistant.message") {
        handleAssistantMessageEvent(sessionId, eventChannelId, data, {
          store,
          orchestrator,
          channelOperatorMeta: channelOperatorMetaForSender,
          sseBroadcast: (event) => serverHandle?.sseBroadcaster?.broadcast(event as Parameters<typeof serverHandle.sseBroadcaster.broadcast>[0]),
        });
      }

      // session.idle with backgroundTasks: a subagent stopped but the overall session
      // is still running (copilotclaw_wait is active). Notify the agent so copilotclaw_wait
      // can unblock and the parent agent can process the subagent's result.
      if (eventChannelId !== undefined && eventType === "session.idle") {
        const bgTasks = data["backgroundTasks"] as { agents?: Array<{ agentId: string; agentType: string }> } | undefined;
        if (bgTasks?.agents !== undefined && bgTasks.agents.length > 0) {
          for (const agent of bgTasks.agents) {
            const msg = `[SUBAGENT IDLE] ${agent.agentId} (${agent.agentType}) stopped`;
            store.addMessage(eventChannelId, "system", msg);
          }
          agentManager.notifyAgent(sessionId);
        }
      }

      // Subagent completion/failure: insert system message and notify agent
      if (eventChannelId !== undefined && (eventType === "subagent.completed" || eventType === "subagent.failed")) {
        // Only notify for direct subagent calls (no parentToolCallId in the event data)
        // Nested subagent events carry parentToolCallId from the outer task tool
        if (data["parentToolCallId"] === undefined) {
          const agentName = data["agentName"] as string ?? "unknown";
          const status = eventType === "subagent.completed" ? "completed" : "failed";
          const error = typeof data["error"] === "string" ? ` (error: ${data["error"]})` : "";
          const msg = `[SUBAGENT ${status.toUpperCase()}] ${agentName} ${status}${error}`;
          store.addMessage(eventChannelId, "system", msg);
          agentManager.notifyAgent(sessionId);
        }
      }
    },
    onSystemPromptOriginal: (model, prompt, capturedAt) => {
      sessionEventStore.saveOriginalPrompt({ model, prompt, capturedAt });
    },
    onSystemPromptSession: (sessionId, model, prompt) => {
      sessionEventStore.saveEffectivePrompt(sessionId, prompt, model);
    },
    onDrainPending: (sessionId) => {
      const ch = resolveChannelId(sessionId);
      if (ch === undefined) return [];
      const drained = store.drainPending(ch);
      sessionController.onAgentDrainedMessages(sessionId, drained);
      return drained;
    },
    onPeekPending: (sessionId) => {
      const ch = resolveChannelId(sessionId);
      if (ch === undefined) return null;
      return store.peekOldestPending(ch) ?? null;
    },
    onFlushPending: (sessionId) => {
      const ch = resolveChannelId(sessionId);
      if (ch === undefined) return 0;
      return store.flushPending(ch);
    },
    onListMessages: (sessionId, limit) => {
      const ch = resolveChannelId(sessionId);
      if (ch === undefined) return [];
      return store.listMessages(ch, limit);
    },
    onRunningSessionsReport: (sessions) => {
      console.error(`[gateway] agent reports ${sessions.length} running session(s), reconciling`);
      sessionController.onReconcile(sessions);
    },
    onPhysicalSessionStarted: (sessionId, copilotSessionId, model) => {
      sessionController.onPhysicalSessionStarted(sessionId, copilotSessionId, model);
    },
    onPhysicalSessionEnded: (sessionId, reason, _copilotSessionId, elapsedMs, error) => {
      sessionController.onPhysicalSessionEnded(sessionId, reason, elapsedMs, error);
    },
  });

  // Set config to push to agent when stream connects
  agentManager.setConfigToSend({
    model: config.model ?? null,
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

  // Session start and pending check are now handled by SessionController.
  // startSessionForChannel → sessionController.ensureSessionForChannel
  // checkAllChannelsPending → sessionController.checkAllChannelsPending

  // Cron scheduler: periodically send cron messages to channels.
  // Supports dynamic reload — existing timers for unchanged jobs are preserved.
  interface CronTimerEntry {
    job: import("./config.js").CronJobConfig;
    timer: ReturnType<typeof setInterval>;
  }
  const cronTimerMap = new Map<string, CronTimerEntry>();

  /** Serialize a cron job config for diff comparison (all fields that affect scheduling). */
  const cronJobKey = (job: import("./config.js").CronJobConfig): string =>
    JSON.stringify({ id: job.id, channelId: job.channelId, intervalMs: job.intervalMs, message: job.message, disabled: job.disabled ?? false });

  /** Schedule a single cron job. Returns the timer entry or undefined if skipped. */
  const scheduleCronJob = (job: import("./config.js").CronJobConfig): CronTimerEntry | undefined => {
    if (job.disabled === true) {
      console.error(`[gateway] cron job '${job.id}' skipped (disabled)`);
      return undefined;
    }
    // Skip if channel is archived
    const ch = store.getChannel(job.channelId);
    if (ch?.archivedAt != null) {
      console.error(`[gateway] cron job '${job.id}' skipped (channel archived)`);
      return undefined;
    }
    const timer = setInterval(() => {
      console.error(`[gateway] cron tick: ${job.id}`);
      // Re-check archive status on each tick
      const tickCh = store.getChannel(job.channelId);
      if (tickCh?.archivedAt != null) {
        console.error(`[gateway] cron ${job.id}: skipped (channel archived)`);
        return;
      }
      const prefix = `[cron:${job.id}] `;
      if (store.hasPendingCronMessage(job.channelId, prefix)) {
        console.error(`[gateway] cron ${job.id}: skipped (pending dedup)`);
        return;
      }
      // Deliver cron message via SessionController (unified session start + notification).
      // Dedup check was already done above (hasPendingCronMessage).
      sessionController.deliverMessage(job.channelId, "cron", `${prefix}${job.message}`).catch((err: unknown) => {
        console.error(`[gateway] cron ${job.id}: failed to deliver:`, err);
      });
    }, job.intervalMs);
    timer.unref();
    console.error(`[gateway] cron job '${job.id}' scheduled for channel ${job.channelId.slice(0, 8)} every ${Math.round(job.intervalMs / 1000)}s`);
    return { job, timer };
  };

  /** Reload cron scheduler from a list of job configs. Preserves timers for unchanged jobs. */
  const reloadCronScheduler = (jobs: import("./config.js").CronJobConfig[]) => {
    const newKeys = new Map<string, import("./config.js").CronJobConfig>();
    for (const job of jobs) {
      newKeys.set(job.id, job);
    }

    // Remove jobs that no longer exist or have changed
    for (const [id, entry] of cronTimerMap) {
      const newJob = newKeys.get(id);
      if (newJob === undefined || cronJobKey(newJob) !== cronJobKey(entry.job)) {
        clearInterval(entry.timer);
        cronTimerMap.delete(id);
        if (newJob === undefined) {
          console.error(`[gateway] cron job '${id}' removed`);
        } else {
          console.error(`[gateway] cron job '${id}' changed, rescheduling`);
        }
      }
    }

    // Add new or changed jobs
    for (const job of jobs) {
      if (cronTimerMap.has(job.id)) continue; // unchanged, keep existing timer
      const entry = scheduleCronJob(job);
      if (entry !== undefined) {
        cronTimerMap.set(job.id, entry);
      }
    }
  };

  /** Get the current list of cron jobs with their scheduling status. */
  const getCronJobStatuses = (): Array<{ id: string; channelId: string; intervalMs: number; message: string; disabled: boolean; scheduled: boolean }> => {
    const currentConfig = loadConfig(getProfileName());
    const jobs = currentConfig.cron ?? [];
    return jobs.map((job) => {
      const ch = store.getChannel(job.channelId);
      const effectivelyDisabled = (job.disabled === true) || (ch?.archivedAt != null);
      return {
        id: job.id,
        channelId: job.channelId,
        intervalMs: job.intervalMs,
        message: job.message,
        disabled: job.disabled ?? false,
        scheduled: cronTimerMap.has(job.id) && !effectivelyDisabled,
      };
    });
  };

  // Initial cron scheduling
  reloadCronScheduler(config.cron ?? []);

  // Start HTTP server (after cron scheduler is initialized, so reload/list handlers are available)
  const onCronReload = () => {
    const freshConfig = loadConfig(getProfileName());
    reloadCronScheduler(freshConfig.cron ?? []);
    console.error("[gateway] cron scheduler reloaded");
  };
  let serverHandle: Awaited<ReturnType<typeof startServer>> | undefined;
  const saveCronJobs = (jobs: CronJobConfig[]) => {
    const fileConfig = loadFileConfig(getProfileName());
    fileConfig.cron = jobs;
    saveConfig(fileConfig, getProfileName());
    // Reload scheduler with the new config
    reloadCronScheduler(jobs);
    console.error(`[gateway] cron config saved (${jobs.length} jobs) and scheduler reloaded`);
  };
  const saveChannelModel = (channelId: string, model: string | null) => {
    const fileConfig = loadFileConfig(getProfileName());
    if (fileConfig.channels === undefined) fileConfig.channels = {};
    if (model !== null) {
      fileConfig.channels[channelId] = { ...fileConfig.channels[channelId], model };
    } else {
      if (fileConfig.channels[channelId] !== undefined) {
        delete fileConfig.channels[channelId]!.model;
        // Remove empty channel config entry
        if (Object.keys(fileConfig.channels[channelId]!).length === 0) {
          delete fileConfig.channels[channelId];
        }
      }
      // Remove empty channels section
      if (Object.keys(fileConfig.channels).length === 0) {
        delete fileConfig.channels;
      }
    }
    saveConfig(fileConfig, getProfileName());
  };
  serverHandle = await startServer({ port, store, agentManager, logBuffer, sessionEventStore, sessionOrchestrator: orchestrator, sessionController, onCronReload, getCronJobStatuses: () => getCronJobStatuses(), saveCronJobs, saveChannelModel });
  // Wire SSE broadcaster to SessionController for status change broadcasts (channel-scoped)
  if (serverHandle.sseBroadcaster !== undefined) {
    sessionController.setSseBroadcast((event) => {
      const broadcaster = serverHandle!.sseBroadcaster!;
      if (event.channelId !== undefined) {
        broadcaster.broadcastToChannel(event.channelId, { type: event.type, data: event.data });
      }
      // Intentionally drop events without channelId: session status events are always
      // channel-scoped (a session is bound to exactly one channel). If no channelId is
      // present, there is no way to determine which connected clients should receive the
      // event, so broadcasting to all would be incorrect. Unbound session events are
      // therefore not delivered via SSE. This differs from the pre-global-SSE behavior
      // (which incorrectly broadcast to all clients); the new behavior is intentional.
    });
    // Wire log buffer append events to global SSE so the dashboard receives live log entries.
    // Only log entries appended after this hook is set are broadcast (no re-broadcast of prior entries).
    logBuffer.setOnAppend((entry) => {
      serverHandle!.sseBroadcaster!.broadcastGlobal({
        type: "log_appended",
        entries: [entry],
      });
    });
    // Wire session event store to session-scoped SSE so SessionEventsPage receives live events.
    // Additionally, when an assistant.usage event is appended, broadcast a token_usage_update
    // global event so StatusPage can update its 5h window without polling.
    sessionEventStore.setOnAppend((sessionId, event) => {
      serverHandle!.sseBroadcaster!.broadcastToSession(sessionId, {
        type: "session_event_appended",
        event,
      });
      broadcastTokenUsageIfNeeded(event, sessionEventStore, serverHandle!.sseBroadcaster!);
    });
    // Wire store channel list changes to global SSE so DashboardPage receives live channel updates.
    wireStoreToChannelListChange(store, serverHandle!.sseBroadcaster!);
  }

  // Agent status change detection state (for global SSE push)
  let lastAgentVersion: string | undefined;
  let lastAgentCompatibility: string | undefined;
  let lastAgentRunning = false;

  // Periodic agent process monitoring + global SSE change detection
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

    // Detect agent status changes and push to global SSE clients
    if (serverHandle?.sseBroadcaster !== undefined) {
      try {
        const status = await agentManager.getStatus().catch(() => null);
        const running = status !== null;
        const version = status?.version;
        const compatibility = await agentManager.checkCompatibility().catch(() => "unavailable" as const);

        if (version !== lastAgentVersion || running !== lastAgentRunning) {
          serverHandle.sseBroadcaster.broadcastGlobal({
            type: "agent_status_change",
            version,
            running,
          });
          lastAgentVersion = version;
          lastAgentRunning = running;
        }
        if (compatibility !== lastAgentCompatibility) {
          serverHandle.sseBroadcaster.broadcastGlobal({
            type: "agent_compatibility_change",
            compatibility,
          });
          lastAgentCompatibility = compatibility;
        }
      } catch {
        // Ignore — agent status check errors are non-fatal
      }
    }
  }, AGENT_MONITOR_INTERVAL_MS);
  monitor.unref();

  // Periodic safety-net check: pending messages and session max age.
  // The primary message pickup is via deliverMessage → ensureSession.
  // This interval is a backstop for edge cases (agent crash, missed notifications).
  const orchestratorCheck = setInterval(() => {
    sessionController.checkAllChannelsPending();
    sessionController.checkSessionMaxAge(promptConfig.maxSessionAgeMs);
  }, ORCHESTRATOR_CHECK_INTERVAL_MS);
  orchestratorCheck.unref();

  agentManager.onStreamConnected(() => {
    console.error("[gateway] stream connected, waiting for agent running_sessions report");
  });

  agentManager.onStreamDisconnected(() => {
    console.error("[gateway] stream disconnected, idling all active sessions");
    sessionController.onStreamDisconnected();
  });

  // Graceful shutdown on process exit
  const gracefulShutdown = async (): Promise<void> => {
    orchestrator.close();
    agentManager.closeStream();
    await shutdownOtel();
    process.exit(0);
  };
  process.once("SIGTERM", () => { gracefulShutdown().catch(console.error); });
  process.once("SIGINT", () => { gracefulShutdown().catch(console.error); });
}

// Run when executed directly (not imported as module for testing)
const isDirectExecution = process.argv[1]?.endsWith("daemon.js") === true;
if (isDirectExecution) {
  main().catch((err: unknown) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
