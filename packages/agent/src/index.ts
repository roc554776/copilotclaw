import { AgentSessionManager } from "./agent-session-manager.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { listenIpc } from "./ipc-server.js";

const GATEWAY_URL = process.env["COPILOTCLAW_GATEWAY_URL"] ?? "http://localhost:19741";
const POLL_INTERVAL_MS = 5000;

function log(message: string): void {
  console.error(`[agent] ${message}`);
}

async function fetchPendingCounts(gatewayUrl: string): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${gatewayUrl}/api/channels/pending`);
    if (res.ok) return await res.json() as Record<string, number>;
  } catch {}
  return {};
}

async function peekOldestPending(gatewayUrl: string, channelId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${gatewayUrl}/api/channels/${channelId}/messages/pending/peek`);
    if (res.status === 200) {
      const data = await res.json() as { id: string };
      return data.id;
    }
  } catch {}
  return undefined;
}

async function flushPending(gatewayUrl: string, channelId: string): Promise<void> {
  try {
    await fetch(`${gatewayUrl}/api/channels/${channelId}/messages/pending/flush`, { method: "POST" });
  } catch {}
}

async function main(): Promise<void> {
  const socketPath = getAgentSocketPath();
  let stopRequested = false;

  const sessionManager = new AgentSessionManager({
    gatewayBaseUrl: GATEWAY_URL,
  });

  const result = await listenIpc(
    socketPath,
    () => { stopRequested = true; },
    sessionManager,
  );

  if (result.kind === "already-running") {
    log("agent is already running");
    process.exit(0);
  }

  const ipc = result.handle;
  log(`IPC listening on ${socketPath}`);

  process.once("SIGTERM", () => { stopRequested = true; });
  process.once("SIGINT", () => { stopRequested = true; });

  // Main polling loop: check gateway for pending inputs across all channels
  while (!stopRequested) {
    try {
      const pending = await fetchPendingCounts(GATEWAY_URL);

      for (const [channelId, count] of Object.entries(pending)) {
        if (count > 0 && !sessionManager.hasSessionForChannel(channelId)) {
          log(`starting session for channel ${channelId.slice(0, 8)} (${count} pending messages)`);
          sessionManager.startSession({ boundChannelId: channelId });
        }
      }

      // Check for stale sessions
      const sessionStatuses = sessionManager.getSessionStatuses();
      for (const [sessionId, info] of Object.entries(sessionStatuses)) {
        const channelId = info.boundChannelId;
        if (channelId === undefined) continue;
        const oldestPendingId = await peekOldestPending(GATEWAY_URL, channelId);
        const action = await sessionManager.checkStaleAndHandle(sessionId, oldestPendingId);
        if (action === "flushed") {
          await flushPending(GATEWAY_URL, channelId);
        }
      }
    } catch (err: unknown) {
      log(`poll error: ${String(err)}`);
    }

    await new Promise((r) => { setTimeout(r, POLL_INTERVAL_MS); });
  }

  log("shutting down");
  await sessionManager.stopAll();
  await ipc.close();
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
