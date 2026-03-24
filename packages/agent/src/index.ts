import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { createChannelTools } from "./tools/channel.js";

const GATEWAY_URL = process.env["COPILOTCLAW_GATEWAY_URL"] ?? "http://localhost:19741";
const CHANNEL_ID = process.env["COPILOTCLAW_CHANNEL_ID"];
const MAX_TURNS = 1000;

async function main(): Promise<void> {
  if (CHANNEL_ID === undefined) {
    console.error("Error: COPILOTCLAW_CHANNEL_ID environment variable is required");
    process.exit(1);
  }

  const client = new CopilotClient();

  try {
    const { receiveFirstInput, replyAndReceiveInput } = createChannelTools({
      gatewayBaseUrl: GATEWAY_URL,
      channelId: CHANNEL_ID,
    });

    const session = await client.createSession({
      model: "gpt-4.1",
      onPermissionRequest: approveAll,
      tools: [receiveFirstInput, replyAndReceiveInput],
    });

    await runSessionLoop({
      session: adaptCopilotSession(session),
      initialPrompt:
        "Call the copilotclaw_receive_first_input tool now to receive the first user input.",
      continuePrompt:
        "Call the copilotclaw_reply_and_receive_input tool to reply to the user and receive the next input. Do NOT stop without calling this tool.",
      maxTurns: MAX_TURNS,
      onMessage: (content) => { console.log(content); },
      log: (message) => { console.error(`[agent] ${message}`); },
    });
  } finally {
    await client.stop();
  }
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
