import { join } from "node:path";
import { PhysicalSessionManager, type PhysicalSessionManagerOptions } from "./physical-session-manager.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { flushSendQueue, initSendQueue, listenIpc, sendToGateway, setMaxQueueSize, streamEvents } from "./ipc-server.js";
import { initOtel, getLogger, shutdownOtel } from "./otel.js";
import { StructuredLogger } from "./structured-logger.js";
import { type AuthConfig, resolveToken } from "./token-resolver.js";

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

    const onConfig = (msg: Record<string, unknown>) => {
      const config = msg["config"] as GatewayConfig | undefined;
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

  // Wait for gateway stream connection and config push
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
  const sessionManager = new PhysicalSessionManager(managerOpts);
  ipc.setSessionManager(sessionManager);

  // Report running sessions when gateway (re)connects stream.
  // This allows gateway to reconcile its orchestrator state with actually-running
  // physical sessions, preventing dual-session on gateway restart.
  const streamConnectedHandler = () => {
    // Flush any messages buffered during gateway downtime before reporting state.
    // This ensures gateway receives events (session_event, channel_message, etc.)
    // that occurred while it was offline, fulfilling the "no information loss" requirement.
    flushSendQueue();

    const running = sessionManager.getRunningPhysicalSessionsSummary();
    log(`stream connected, reporting ${running.length} running session(s)`);
    sendToGateway({ type: "running_sessions", sessions: running });
  };
  streamEvents.on("stream_connected", streamConnectedHandler);

  // Gateway-driven physical session commands (Phase 3)
  const startPhysicalSessionHandler = (msg: Record<string, unknown>) => {
    const sessionId = msg["sessionId"] as string;
    const copilotSessionId = msg["copilotSessionId"] as string | undefined;
    const resolvedModel = msg["model"] as string | undefined;
    log(`start_physical_session: session=${sessionId.slice(0, 8)}, copilotSession=${copilotSessionId ?? "(new)"}, model=${resolvedModel ?? "(auto)"}`);
    const opts: import("./physical-session-manager.js").StartPhysicalSessionOptions = { sessionId };
    if (copilotSessionId !== undefined) opts.copilotSessionId = copilotSessionId;
    if (resolvedModel !== undefined) opts.resolvedModel = resolvedModel;
    sessionManager.startPhysicalSession(opts);
  };
  streamEvents.on("start_physical_session", startPhysicalSessionHandler);

  const stopPhysicalSessionHandler = (msg: Record<string, unknown>) => {
    const sessionId = msg["sessionId"] as string;
    log(`stop_physical_session: session=${sessionId.slice(0, 8)}`);
    // Find session by sessionId and stop it
    const status = sessionManager.getPhysicalSessionStatus(sessionId);
    if (status !== undefined) {
      sessionManager.stopPhysicalSession(sessionId);
    } else {
      log(`stop_physical_session: session ${sessionId.slice(0, 8)} not found, ignoring`);
    }
  };
  streamEvents.on("stop_physical_session", stopPhysicalSessionHandler);

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
  await sessionManager.stopAllPhysicalSessions();
  await ipc.close();
  await shutdownOtel();
}

main().catch((err: unknown) => {
  logError(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
