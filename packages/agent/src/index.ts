import { join } from "node:path";
import { PhysicalSessionManager, type PhysicalSessionManagerOptions } from "./physical-session-manager.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { flushSendQueue, initSendQueue, listenIpc, sendToGateway, setMaxQueueSize, streamEvents } from "./ipc-server.js";
import { initOtel, getLogger, shutdownOtel } from "./otel.js";
import { StructuredLogger } from "./structured-logger.js";
import { type AuthConfig, resolveToken } from "./token-resolver.js";
import type { GatewayToAgentEvent } from "./ipc-types.js";

interface OtelConfig {
  endpoints?: string[];
}

interface DebugConfig {
  logLevel?: "info" | "debug";
}

interface CustomAgentDef {
  name: string;
  displayName: string;
  description: string;
  prompt: string;
  infer: boolean;
  /** Copilotclaw tool names to include in this agent's tools list (in addition to builtin tools). */
  copilotclawTools: string[];
}

interface AgentPromptConfig {
  customAgents?: CustomAgentDef[];
  primaryAgentName?: string;
  systemReminder: string;
  initialPrompt: string;
  staleTimeoutMs: number;
  maxSessionAgeMs: number;
  rapidFailureThresholdMs: number;
  backoffDurationMs: number;
  keepaliveTimeoutMs?: number;
  reminderThresholdPercent?: number;
  maxReinject?: number;
  knownSections?: string[];
  maxQueueSize?: number;
  clientOptions?: Record<string, unknown>;
  sessionConfigOverrides?: Record<string, unknown>;
  toolDefinitions?: Array<{ name: string; description: string; parameters: Record<string, unknown>; skipPermission?: boolean }>;
}

interface GatewayConfig {
  model: string | null;
  stateDir: string | null;
  workspaceRoot: string | null;
  auth: AuthConfig | null;
  otel: OtelConfig | null;
  debug: DebugConfig | null;
  prompts: AgentPromptConfig | null;
}

let structuredLogger: StructuredLogger | undefined;

function log(message: string): void {
  if (structuredLogger !== undefined) {
    structuredLogger.info(message);
  } else {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "info", component: "agent", msg: message }));
  }
}

function logError(message: string): void {
  if (structuredLogger !== undefined) {
    structuredLogger.error(message);
  } else {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", component: "agent", msg: message }));
  }
}

/** Wait for the gateway to establish a stream connection and push config.
 *  Returns the config data, or a default config after timeout. */
function waitForConfig(timeoutMs = 30_000): Promise<GatewayConfig> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (config: GatewayConfig) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(config);
    };

    const timer = setTimeout(() => {
      log("config push not received within timeout, using defaults");
      settle({ model: null, stateDir: null, workspaceRoot: null, auth: null, otel: null, debug: null, prompts: null });
    }, timeoutMs);
    timer.unref();

    const onConfig = (rawMsg: Record<string, unknown>) => {
      const msg = rawMsg as Extract<GatewayToAgentEvent, { type: "config" }>;
      const config = msg.config as unknown as GatewayConfig | undefined;
      if (config !== undefined) {
        settle(config);
      }
    };

    streamEvents.on("config", onConfig);

    function cleanup(): void {
      clearTimeout(timer);
      streamEvents.removeListener("config", onConfig);
    }
  });
}

async function main(): Promise<void> {
  const socketPath = getAgentSocketPath();
  let stopRequested = false;

  // Start IPC server first — gateway will connect with a stream
  // We create the session manager after receiving config from gateway
  const result = await listenIpc(
    socketPath,
    () => { stopRequested = true; },
    null, // sessionManager set later via listenIpc's design — but we need it for IPC methods
  );

  if (result.kind === "already-running") {
    log("agent is already running");
    process.exit(0);
  }

  const ipc = result.handle;
  log(`IPC listening on ${socketPath}`);

  process.once("SIGTERM", () => { stopRequested = true; });
  process.once("SIGINT", () => { stopRequested = true; });

  // Register stream_connected handler BEFORE waitForConfig so we don't miss
  // the first stream_connected event that fires when gateway connects.
  const streamConnectedHandler = () => {
    // Flush any messages buffered during gateway downtime before reporting state.
    // This ensures gateway receives events (session_event, channel_message, etc.)
    // that occurred while it was offline, fulfilling the "no information loss" requirement.
    flushSendQueue();
    // Note (Item F, v0.83.0): running sessions are now reported only in response to
    // gateway's request_running_sessions request. Self-initiated reporting is removed.
  };
  streamEvents.on("stream_connected", streamConnectedHandler);

  // Wait for gateway stream connection and config push
  let sessionManager: PhysicalSessionManager | null = null;
  log("waiting for gateway stream connection and config...");
  const config = await waitForConfig();
  log(`config: model=${config.model ?? "(auto)"}`);

  // Initialize OpenTelemetry (before structured logger, so bridge is available)
  const otelEndpoints = config.otel?.endpoints ?? [];
  initOtel({ endpoints: otelEndpoints, serviceName: "copilotclaw-agent" });
  const otelLoggerRaw = getLogger("agent");

  // Initialize structured logger and send queue if state dir is available.
  if (config.stateDir !== null) {
    const dataDir = join(config.stateDir, "data");
    const agentLogPath = join(dataDir, "agent.log");
    structuredLogger = new StructuredLogger(agentLogPath, "agent", otelLoggerRaw);
    log("structured logger initialized");

    // Initialize persistent send queue for gateway disconnect resilience.
    // Restores any buffered messages from a previous agent run.
    if (config.prompts?.maxQueueSize !== undefined) {
      setMaxQueueSize(config.prompts.maxQueueSize);
    }
    initSendQueue(dataDir);
    log("send queue initialized");
  }

  // Resolve auth token from gateway config (if configured)
  let githubToken: string | undefined;
  if (config.auth !== null) {
    try {
      githubToken = resolveToken(config.auth);
      log(`auth: resolved token via ${config.auth.type}${config.auth.user !== undefined ? ` (user: ${config.auth.user})` : ""}`);
    } catch (err: unknown) {
      logError(`auth: failed to resolve token: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const managerOpts: PhysicalSessionManagerOptions = {
    debugLogLevel: config.debug?.logLevel ?? "info",
    prompts: config.prompts!,
    log,
    logError,
  };
  if (githubToken !== undefined) managerOpts.githubToken = githubToken;
  if (config.workspaceRoot !== null) {
    managerOpts.workingDirectory = config.workspaceRoot;
  }
  sessionManager = new PhysicalSessionManager(managerOpts);
  ipc.setSessionManager(sessionManager!);

  // Flush queue on initial startup (sends any messages from a prior session).
  // Running sessions are now reported only in response to gateway's request_running_sessions
  // (Item F, v0.83.0 — request-response reconcile protocol).
  flushSendQueue();

  // Gateway-driven physical session commands (Phase 3)
  const startPhysicalSessionHandler = (rawMsg: Record<string, unknown>) => {
    const msg = rawMsg as Extract<GatewayToAgentEvent, { type: "start_physical_session" }>;
    const sessionId = msg.sessionId;
    // Accept both "physicalSessionId" (new) and "copilotSessionId" (legacy) from gateway
    const physicalSessionId = (msg.physicalSessionId ?? (rawMsg["copilotSessionId"] as string | undefined));
    const resolvedModel = msg.model;
    log(`start_physical_session: session=${sessionId.slice(0, 8)}, physicalSession=${physicalSessionId ?? "(new)"}, model=${resolvedModel ?? "(auto)"}`);
    const opts: import("./physical-session-manager.js").StartPhysicalSessionOptions = { sessionId };
    if (physicalSessionId !== undefined) opts.physicalSessionId = physicalSessionId;
    if (resolvedModel !== undefined) opts.resolvedModel = resolvedModel;
    sessionManager!.startPhysicalSession(opts);
  };
  streamEvents.on("start_physical_session", startPhysicalSessionHandler);

  const stopPhysicalSessionHandler = (rawMsg: Record<string, unknown>) => {
    const msg = rawMsg as Extract<GatewayToAgentEvent, { type: "stop_physical_session" }>;
    const { sessionId } = msg;
    log(`stop_physical_session: session=${sessionId.slice(0, 8)}`);
    const status = sessionManager!.getPhysicalSessionStatus(sessionId);
    if (status !== undefined) {
      sessionManager!.stopPhysicalSession(sessionId);
    } else {
      log(`stop_physical_session: session ${sessionId.slice(0, 8)} not found, ignoring`);
    }
  };
  streamEvents.on("stop_physical_session", stopPhysicalSessionHandler);

  const disconnectPhysicalSessionHandler = (rawMsg: Record<string, unknown>) => {
    const msg = rawMsg as Extract<GatewayToAgentEvent, { type: "disconnect_physical_session" }>;
    const { sessionId } = msg;
    log(`disconnect_physical_session: session=${sessionId.slice(0, 8)}`);
    const status = sessionManager!.getPhysicalSessionStatus(sessionId);
    if (status !== undefined) {
      sessionManager!.disconnectPhysicalSession(sessionId);
    } else {
      log(`disconnect_physical_session: session ${sessionId.slice(0, 8)} not found, ignoring`);
    }
  };
  streamEvents.on("disconnect_physical_session", disconnectPhysicalSessionHandler);

  // Item F (v0.83.0): reconcile coordinator request-response protocol.
  // Gateway sends request_running_sessions when it needs to reconcile;
  // agent responds with running_sessions_report listing all non-suspended physical session IDs.
  const requestRunningSessionsHandler = (_rawMsg: Record<string, unknown>) => {
    const running = sessionManager!.getRunningPhysicalSessionsSummary();
    log(`request_running_sessions received, reporting ${running.length} session(s)`);
    // RunningSessionsReport: physicalSessionIds are the physical (Copilot) session IDs.
    // Use sessionId as the identifier since physical-session-manager maps sessionId → worldState.
    // The gateway reconcile coordinator matches against AbstractSessionState.physicalSessionId.
    sendToGateway({
      type: "running_sessions_report",
      physicalSessionIds: running.map((r) => r.sessionId),
    });
  };
  streamEvents.on("request_running_sessions", requestRunningSessionsHandler);

  // Wait for stop signal
  await new Promise<void>((resolve) => {
    if (stopRequested) { resolve(); return; }
    const check = setInterval(() => {
      if (stopRequested) {
        clearInterval(check);
        resolve();
      }
    }, 500);
    check.unref();
  });

  log("shutting down");
  streamEvents.removeListener("stream_connected", streamConnectedHandler);
  streamEvents.removeListener("start_physical_session", startPhysicalSessionHandler);
  streamEvents.removeListener("stop_physical_session", stopPhysicalSessionHandler);
  streamEvents.removeListener("disconnect_physical_session", disconnectPhysicalSessionHandler);
  streamEvents.removeListener("request_running_sessions", requestRunningSessionsHandler);
  await sessionManager!.stopAllPhysicalSessions();
  await ipc.close();
  await shutdownOtel();
}

main().catch((err: unknown) => {
  logError(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
