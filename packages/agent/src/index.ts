import { join } from "node:path";
import { AgentSessionManager, type AgentSessionManagerOptions } from "./agent-session-manager.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { listenIpc, streamEvents, requestFromGateway } from "./ipc-server.js";
import { initOtel, getLogger, shutdownOtel } from "./otel.js";
import { StructuredLogger } from "./structured-logger.js";
import { type AuthConfig, resolveToken } from "./token-resolver.js";

const STALE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

interface OtelConfig {
  endpoints?: string[];
}

interface GatewayConfig {
  model: string | null;
  zeroPremium: boolean;
  debugMockCopilotUnsafeTools: boolean;
  stateDir: string | null;
  workspaceRoot: string | null;
  auth: AuthConfig | null;
  otel: OtelConfig | null;
}

let structuredLogger: StructuredLogger | undefined;

function log(message: string): void {
  console.error(`[agent] ${message}`);
  structuredLogger?.info(message);
}

function logError(message: string): void {
  console.error(`[agent] ${message}`);
  structuredLogger?.error(message);
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
      settle({ model: null, zeroPremium: false, debugMockCopilotUnsafeTools: false, stateDir: null, workspaceRoot: null, auth: null, otel: null });
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
  log(`config: model=${config.model ?? "(auto)"}, zeroPremium=${config.zeroPremium}, debugMockCopilotUnsafeTools=${config.debugMockCopilotUnsafeTools}`);

  // Initialize OpenTelemetry (before structured logger, so bridge is available)
  const otelEndpoints = config.otel?.endpoints ?? [];
  initOtel({ endpoints: otelEndpoints, serviceName: "copilotclaw-agent" });
  const otelLoggerRaw = getLogger("agent");

  // Initialize structured logger if state dir is available.
  if (config.stateDir !== null) {
    const dataDir = join(config.stateDir, "data");
    const agentLogPath = join(dataDir, "agent.log");
    structuredLogger = new StructuredLogger(agentLogPath, "agent", otelLoggerRaw);
    log("structured logger initialized");
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

  const managerOpts: AgentSessionManagerOptions = {
    zeroPremium: config.zeroPremium,
    debugMockCopilotUnsafeTools: config.debugMockCopilotUnsafeTools,
  };
  if (githubToken !== undefined) managerOpts.githubToken = githubToken;
  if (config.model !== null) managerOpts.model = config.model;
  if (config.workspaceRoot !== null) {
    managerOpts.workingDirectory = config.workspaceRoot;
  }
  if (config.stateDir !== null) {
    managerOpts.persistPath = join(config.stateDir, "data", "agent-bindings.json");
  }
  const sessionManager = new AgentSessionManager(managerOpts);

  // Listen for pending_notify push messages from gateway — start sessions as needed
  const pendingHandler = (msg: Record<string, unknown>) => {
    const channelId = msg["channelId"] as string | undefined;
    const count = typeof msg["count"] === "number" ? msg["count"] as number : 1;
    if (channelId === undefined || count <= 0) return;

    if (!sessionManager.hasActiveSessionForChannel(channelId)) {
      if (sessionManager.isChannelInBackoff(channelId)) return;
      log(`starting/reviving session for channel ${channelId.slice(0, 8)} (${count} pending messages)`);
      sessionManager.startSession({ boundChannelId: channelId });
    }
  };
  streamEvents.on("pending_notify", pendingHandler);

  // Periodic stale session and max-age checks (still interval-based)
  const staleCheckTimer = setInterval(async () => {
    if (stopRequested) return;
    try {
      const sessionStatuses = sessionManager.getSessionStatuses();
      for (const [sessionId, info] of Object.entries(sessionStatuses)) {
        if (sessionManager.checkSessionMaxAge(sessionId)) continue;

        const channelId = info.boundChannelId;
        if (channelId === undefined) continue;

        let oldestPendingId: string | undefined;
        try {
          const peekResult = await requestFromGateway({ type: "peek_pending", channelId });
          if (peekResult !== null && peekResult !== undefined && typeof peekResult === "object" && "id" in (peekResult as object)) {
            oldestPendingId = (peekResult as { id: string }).id;
          }
        } catch {
          // IPC error — skip
        }

        const action = await sessionManager.checkStaleAndHandle(sessionId, oldestPendingId);
        if (action === "flushed") {
          try {
            await requestFromGateway({ type: "flush_pending", channelId });
          } catch {
            // IPC error — non-fatal
          }
        }
      }
    } catch (err: unknown) {
      logError(`stale check error: ${String(err)}`);
    }
  }, STALE_CHECK_INTERVAL_MS);
  staleCheckTimer.unref();

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
  streamEvents.removeListener("pending_notify", pendingHandler);
  clearInterval(staleCheckTimer);
  await sessionManager.stopAll();
  await ipc.close();
  await shutdownOtel();
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
