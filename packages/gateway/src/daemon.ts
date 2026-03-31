import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentPromptConfig, resolveModel } from "./agent-config.js";
import { AgentManager } from "./agent-manager.js";
import { type CronJobConfig, getProfileName, getStateDir, loadConfig, loadFileConfig, resolvePort, saveConfig } from "./config.js";
import { LogBuffer } from "./log-buffer.js";
import { initOtel, shutdownOtel } from "./otel.js";
import { initMetrics } from "./otel-metrics.js";
import { startServer } from "./server.js";
import { SessionEventStore } from "./session-event-store.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { Store } from "./store.js";
import { ensureWorkspace, getDataDir, getStoreDbPath, getStoreFilePath, getWorkspaceRoot } from "./workspace.js";

const AGENT_MONITOR_INTERVAL_MS = 30_000; // 30 seconds
const AGENT_MONITOR_ERROR_THRESHOLD = 3;
const ORCHESTRATOR_CHECK_INTERVAL_MS = 30_000; // 30 seconds

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
  });
  const promptConfig = getAgentPromptConfig();

  // Helper: resolve sessionId → channelId via orchestrator.
  // Agent sends opaque sessionId; gateway looks up the bound channelId.
  const resolveChannelId = (sessionId: string): string | undefined => {
    return orchestrator.getSessionStatuses()[sessionId]?.channelId;
  };

  // Reminder state per session: tracks context usage to decide when to inject
  // systemReminder into onPostToolUse additionalContext.
  const reminderStates = new Map<string, {
    needsReminder: boolean;
    lastReminderPercent: number;
    currentUsagePercent: number;
  }>();

  const getReminderState = (sessionId: string) => {
    let state = reminderStates.get(sessionId);
    if (state === undefined) {
      state = { needsReminder: false, lastReminderPercent: 0, currentUsagePercent: 0 };
      reminderStates.set(sessionId, state);
    }
    return state;
  };

  // Swallowed-message detection state per session.
  // Tracks whether the previous wait returned user messages AND no
  // copilotclaw_send_message was called since. If so, the agent swallowed
  // the message (processed it but never replied to the user).
  const pendingReplyExpected = new Map<string, boolean>();
  // Tracks whether the most recent session.idle event for a session had backgroundTasks.
  // Used by onLifecycle to distinguish subagent stop from true parent-agent idle.
  const lastIdleHasBackgroundTasks = new Map<string, boolean>();

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
          store.addMessage(channelId, "agent", message);
          serverHandle?.sseBroadcaster?.broadcast({
            type: "new_message",
            channelId,
            data: { sender: "agent", message },
          });
          // Clear swallowed-message flag — agent replied successfully
          pendingReplyExpected.set(request.sessionId, false);
          return { status: "sent" };
        }
        case "copilotclaw_list_messages": {
          const limit = (request.args["limit"] as number) ?? 5;
          const messages = store.listMessages(channelId, limit);
          return { messages };
        }
        case "copilotclaw_wait": {
          // Swallowed-message guard: if a previous wait returned user messages
          // and no copilotclaw_send_message was called since, inject a reminder.
          if (pendingReplyExpected.get(request.sessionId) === true) {
            console.error(`[gateway] swallowed message detected for session ${request.sessionId.slice(0, 8)} — forcing reply reminder`);
            pendingReplyExpected.set(request.sessionId, false);
            return { userMessage: SWALLOWED_MESSAGE_INSTRUCTION };
          }

          // Wait tool: check for pending messages.
          // The full keepalive loop lives in agent (built-in fallback),
          // but gateway can provide the drain+wait logic here.
          const drained = store.drainPending(channelId);
          if (drained.length > 0) {
            const combined = drained.map((m) => {
              const sender = m.sender;
              const msg = m.message;
              if (sender === "cron") return `[CRON TASK] ${msg}`;
              if (sender === "system") return `[SYSTEM EVENT] ${msg}`;
              return msg;
            }).join("\n\n");
            // Mark that we returned user messages — next wait should check for reply
            pendingReplyExpected.set(request.sessionId, true);
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
      // Gateway-side lifecycle handler. Agent asks what to do on idle/error.
      // Gateway decides: stop (destroy session), reinject (re-enter session loop), wait (keep alive).
      // Changing this logic only requires gateway restart (no agent update).
      if (request.event === "error") {
        // Error: stop the session and clear copilotSessionId (don't try to resume a broken session)
        return { action: "stop", clearCopilotSessionId: true };
      }

      // Idle exit: distinguish subagent stop from true parent-agent idle.
      // If the most recent session.idle had backgroundTasks, a subagent just stopped
      // and the parent agent is likely still running copilotclaw_wait.
      if (lastIdleHasBackgroundTasks.get(request.sessionId) === true) {
        console.error(`[gateway] session ${request.sessionId.slice(0, 8)} idle with backgroundTasks — waiting (subagent stop)`);
        lastIdleHasBackgroundTasks.delete(request.sessionId);
        return { action: "wait" };
      }

      // If copilotclaw_wait is still executing, the parent agent is active.
      const sessionState = orchestrator.getSessionStatuses()[request.sessionId];
      if (sessionState?.physicalSession?.currentState === "tool:copilotclaw_wait") {
        console.error(`[gateway] session ${request.sessionId.slice(0, 8)} idle but copilotclaw_wait active — waiting`);
        return { action: "wait" };
      }

      // True idle: LLM finished without calling copilotclaw_wait — stop the session
      return { action: "stop" };
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
      store.addMessage(msgChannelId, senderType, message);
      // Broadcast to SSE clients (serverHandle.sseBroadcaster set after startServer)
      serverHandle?.sseBroadcaster?.broadcast({
        type: "new_message",
        channelId: msgChannelId,
        data: { sender: senderType, message },
      });
    },
    onSessionEvent: (sessionId, copilotSessionId, eventType, timestamp, data, parentId) => {
      const eventChannelId = resolveChannelId(sessionId);
      const event: { type: string; timestamp: string; data: Record<string, unknown>; parentId?: string } = {
        type: eventType,
        timestamp,
        data,
      };
      if (parentId !== undefined) event.parentId = parentId;
      if (copilotSessionId !== undefined) {
        sessionEventStore.appendEvent(copilotSessionId, event);
      }

      // Update orchestrator's physical session state from forwarded SDK events.
      // This allows the gateway to maintain dashboard-visible state without
      // relying on the agent's IPC status RPC.
      // Use sessionId (opaque token = orchestrator session ID) directly.
      const orchSessionId = sessionId;
      if (orchestrator.getSessionStatuses()[orchSessionId] !== undefined) {
        switch (eventType) {
          case "tool.execution_start": {
            const toolName = data["toolName"] as string ?? "unknown";
            orchestrator.updatePhysicalSessionState(orchSessionId, `tool:${toolName}`);
            // Update abstract status based on tool type
            if (toolName === "copilotclaw_wait") {
              orchestrator.updateSessionStatus(orchSessionId, "waiting");
            } else {
              orchestrator.updateSessionStatus(orchSessionId, "processing");
            }
            break;
          }
          case "tool.execution_complete":
            orchestrator.updatePhysicalSessionState(orchSessionId, "idle");
            break;
          case "session.idle": {
            const bgTasks = data["backgroundTasks"];
            lastIdleHasBackgroundTasks.set(orchSessionId, bgTasks != null);
            // Only transition to "idle" when there are no background tasks.
            // When backgroundTasks is present, a subagent stopped but the parent
            // agent's tool (e.g. copilotclaw_wait) is still executing — preserve
            // the current state so the onLifecycle fallback check can detect it.
            if (bgTasks == null) {
              orchestrator.updatePhysicalSessionState(orchSessionId, "idle");
            }
            break;
          }
          case "session.usage_info": {
            const currentTokens = data["currentTokens"] as number ?? 0;
            const tokenLimit = data["tokenLimit"] as number ?? 0;
            orchestrator.updatePhysicalSessionTokens(orchSessionId, currentTokens, tokenLimit);
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
            orchestrator.accumulateUsageTokens(
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
            orchestrator.updatePhysicalSessionModel(orchSessionId, data["newModel"] as string ?? "unknown");
            break;
          case "subagent.started":
            orchestrator.addSubagentSession(orchSessionId, {
              toolCallId: data["toolCallId"] as string ?? "",
              agentName: data["agentName"] as string ?? "unknown",
              agentDisplayName: data["agentDisplayName"] as string ?? "unknown",
              status: "running",
              startedAt: timestamp,
            });
            break;
          case "subagent.completed":
            orchestrator.updateSubagentStatus(orchSessionId, data["toolCallId"] as string ?? "", "completed");
            break;
          case "subagent.failed":
            orchestrator.updateSubagentStatus(orchSessionId, data["toolCallId"] as string ?? "", "failed");
            break;
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
      return store.drainPending(ch);
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
      console.error(`[gateway] agent reports ${sessions.length} running session(s), reconciling with orchestrator`);
      orchestrator.reconcileWithAgent(sessions);
      // After reconciliation, check for pending messages on channels without active sessions
      checkAllChannelsPending();
    },
    onPhysicalSessionStarted: (sessionId, copilotSessionId, model) => {
      console.error(`[gateway] physical session started: session=${sessionId.slice(0, 8)}, copilot=${copilotSessionId.slice(0, 12)}, model=${model}`);
      orchestrator.updateSessionStatus(sessionId, "waiting");
      orchestrator.updatePhysicalSession(sessionId, {
        sessionId: copilotSessionId,
        model,
        startedAt: new Date().toISOString(),
        currentState: "idle",
      });

    },
    onPhysicalSessionEnded: (sessionId, reason, _copilotSessionId, elapsedMs, error) => {
      console.error(`[gateway] physical session ended: session=${sessionId.slice(0, 8)}, reason=${reason}, elapsed=${Math.round(elapsedMs / 1000)}s`);

      // Clear per-session state on physical session boundary.
      // Without this, a new physical session on the same abstract session would
      // inherit stale state (e.g., swallowed-message flag from the previous session).
      pendingReplyExpected.delete(sessionId);
      reminderStates.delete(sessionId);
      lastIdleHasBackgroundTasks.delete(sessionId);

      // Check for rapid failure and record backoff
      const session = orchestrator.getSessionStatuses()[sessionId];
      const channelId = session?.channelId;
      if (channelId !== undefined && elapsedMs < promptConfig.rapidFailureThresholdMs) {
        orchestrator.recordBackoff(channelId, promptConfig.backoffDurationMs);
        console.error(`[gateway] channel ${channelId.slice(0, 8)} entering ${promptConfig.backoffDurationMs / 1000}s backoff after rapid failure (${elapsedMs}ms)`);
      }

      // Token counts are already accumulated in real-time via assistant.usage events.
      orchestrator.updatePhysicalSessionState(sessionId, "stopped");

      // If the session was already transitioned by an API call (end-turn-run
      // sets "idle", stop sets "suspended"), skip redundant state transition
      // to avoid double token accumulation.
      if (session?.status === "idle" || session?.status === "suspended") {
        // no-op: API already transitioned the session
      } else if (reason === "idle") {
        // Turn run ended (true idle): keep physical session visible, set status to "idle"
        orchestrator.idleSession(sessionId);
      } else {
        // Error or abort: full suspend (archive physical session)
        orchestrator.suspendSession(sessionId);

        // Notify channel about unexpected stop
        if (channelId !== undefined) {
          const detail = error !== undefined ? `: ${error}` : "";
          store.addMessage(channelId, "system", `[SYSTEM] Agent session stopped unexpectedly${detail}. A new session will start when you send a message.`);
        }
      }

      // Flush pending messages for the channel
      if (channelId !== undefined) {
        const flushed = store.flushPending(channelId);
        if (flushed > 0) {
          console.error(`[gateway] flushed ${flushed} pending message(s) for channel ${channelId.slice(0, 8)}`);
        }
      }
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

  // Helper: start a session for a channel via orchestrator + agent manager.
  // Resolves the model on gateway side so the selection algorithm can be updated
  // by restarting gateway alone (without restarting agent).
  const startSessionForChannel = async (channelId: string) => {
    if (orchestrator.isChannelInBackoff(channelId)) {
      console.error(`[gateway] skipping session start for channel ${channelId.slice(0, 8)} (in backoff)`);
      return;
    }
    if (orchestrator.hasActiveSessionForChannel(channelId)) return;
    const sessionId = orchestrator.startSession(channelId);
    const session = orchestrator.getSessionStatuses()[sessionId];

    // Resolve model on gateway side (channel model overrides global config)
    let resolvedModelName: string | undefined;
    try {
      const modelsResponse = await agentManager.getModels();
      const channel = store.getChannel(channelId);
      const configModel = channel?.model ?? config.model ?? null;
      resolvedModelName = resolveModel(modelsResponse, configModel, config.zeroPremium ?? false);
    } catch {
      // Model resolution failed — agent will fall back to its own resolution
    }

    console.error(`[gateway] starting physical session for channel ${channelId.slice(0, 8)}, session=${sessionId.slice(0, 8)}, model=${resolvedModelName ?? "(agent-fallback)"}`);
    agentManager.startPhysicalSession(sessionId, session?.copilotSessionId, resolvedModelName);
  };

  // Helper: check all channels for pending messages and start sessions via orchestrator
  const checkAllChannelsPending = () => {
    const channels = store.listChannels();
    for (const channel of channels) {
      const channelId = channel.id;
      if (orchestrator.hasActiveSessionForChannel(channelId)) continue;
      if (orchestrator.isChannelInBackoff(channelId)) continue;
      const oldest = store.peekOldestPending(channelId);
      if (oldest !== undefined) {
        console.error(`[gateway] pending message found for channel ${channelId.slice(0, 8)}, starting session`);
        startSessionForChannel(channelId).catch((err: unknown) => {
          console.error(`[gateway] failed to start session for channel ${channelId.slice(0, 8)}:`, err);
        });
      }
    }
  };

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
      const msg = store.addMessage(job.channelId, "cron", `${prefix}${job.message}`);
      if (msg !== undefined) {
        startSessionForChannel(job.channelId).catch((err: unknown) => {
          console.error(`[gateway] cron ${job.id}: failed to start session:`, err);
        });
        const cronSessionId = orchestrator.getSessionIdForChannel(job.channelId);
        if (cronSessionId !== undefined) {
          agentManager.notifyAgent(cronSessionId);
          const cronSess = orchestrator.getSessionStatuses()[cronSessionId];
          if (cronSess?.status === "waiting") {
            orchestrator.updateSessionStatus(cronSessionId, "notified");
          }
        }
      }
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
  serverHandle = await startServer({ port, store, agentManager, logBuffer, sessionEventStore, sessionOrchestrator: orchestrator, onCronReload, getCronJobStatuses: () => getCronJobStatuses(), saveCronJobs, saveChannelModel });

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

  // Periodic orchestrator check: pending messages and session max age
  const orchestratorCheck = setInterval(() => {
    // Check all channels for pending messages
    checkAllChannelsPending();

    // Check all sessions for max age
    const sessions = orchestrator.getSessionStatuses();
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session.status === "suspended") continue;
      if (orchestrator.checkSessionMaxAge(sessionId, promptConfig.maxSessionAgeMs)) {
        console.error(`[gateway] session ${sessionId.slice(0, 8)} exceeded max age, stopping`);
        agentManager.stopPhysicalSession(sessionId);
        orchestrator.suspendSession(sessionId);
  
      }
    }
  }, ORCHESTRATOR_CHECK_INTERVAL_MS);
  orchestratorCheck.unref();

  // On stream "connected" event: do NOT check pending immediately.
  // Wait for the agent's running_sessions report (sent automatically on stream connect)
  // to reconcile orchestrator state before starting new sessions.
  // checkAllChannelsPending() is called in onRunningSessionsReport handler.
  agentManager.onStreamConnected(() => {
    console.error("[gateway] stream connected, waiting for agent running_sessions report");
  });

  // On stream "disconnected" event: suspend all active sessions (agent restart scenario)
  agentManager.onStreamDisconnected(() => {
    console.error("[gateway] stream disconnected, suspending all active sessions");
    orchestrator.suspendAllActive();
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

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
