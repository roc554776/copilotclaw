import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { getAgentSocketPath } from "./ipc-paths.js";
import { listenIpc } from "./ipc-server.js";
import { runSessionLoop } from "./session-loop.js";
import { createChannelTools } from "./tools/channel.js";

const GATEWAY_URL = process.env["COPILOTCLAW_GATEWAY_URL"] ?? "http://localhost:19741";
const CHANNEL_ID = process.env["COPILOTCLAW_CHANNEL_ID"];
const MAX_TURNS = 1000;

function log(message: string): void {
  console.error(`[agent] ${message}`);
}

async function main(): Promise<void> {
  if (CHANNEL_ID === undefined) {
    console.error("Error: COPILOTCLAW_CHANNEL_ID environment variable is required");
    process.exit(1);
  }

  const socketPath = getAgentSocketPath(CHANNEL_ID);
  let stopRequested = false;
  let restartRequested = false;

  const result = await listenIpc(
    socketPath,
    () => { stopRequested = true; },
    () => { restartRequested = true; },
  );

  if (result.kind === "already-running") {
    log(`agent for channel ${CHANNEL_ID.slice(0, 8)} is already running`);
    process.exit(0);
  }

  const ipc = result.handle;
  log(`IPC listening on ${socketPath}`);

  process.once("exit", () => {
    try { ipc.close(); } catch {}
  });
  process.once("SIGTERM", () => { stopRequested = true; });
  process.once("SIGINT", () => { stopRequested = true; });

  // Run agent loop, restarting on request
  while (!stopRequested) {
    restartRequested = false;
    ipc.state.status = "starting";
    if (ipc.state.restartedAt !== undefined) {
      log("restarting copilot session...");
    }

    const client = new CopilotClient();
    try {
      const { receiveFirstInput, replyAndReceiveInput } = createChannelTools({
        gatewayBaseUrl: GATEWAY_URL,
        channelId: CHANNEL_ID,
        onStatusChange: (status) => { ipc.state.status = status; },
      });

      const session = await client.createSession({
        model: "gpt-4.1",
        onPermissionRequest: approveAll,
        tools: [receiveFirstInput, replyAndReceiveInput],
      });

      ipc.state.status = "waiting";

      await runSessionLoop({
        session: adaptCopilotSession(session),
        initialPrompt:
          "Call the copilotclaw_receive_first_input tool now to receive the first user input.",
        continuePrompt:
          "Call the copilotclaw_reply_and_receive_input tool to reply to the user and receive the next input. Do NOT stop without calling this tool.",
        maxTurns: MAX_TURNS,
        onMessage: (content) => { console.log(content); },
        log,
        shouldStop: () => stopRequested || restartRequested,
      });
    } finally {
      await client.stop();
    }

    if (restartRequested && !stopRequested) {
      ipc.state.restartedAt = new Date().toISOString();
    }
  }

  log("shutting down");
  await ipc.close();
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
