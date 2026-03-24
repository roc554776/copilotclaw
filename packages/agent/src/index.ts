import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";

async function main(): Promise<void> {
  const client = new CopilotClient();

  try {
    const session = await client.createSession({
      model: "gpt-4.1",
      onPermissionRequest: approveAll,
    });

    await runSessionLoop({
      session: adaptCopilotSession(session),
      initialPrompt: "Say hello! Respond in one sentence.",
      continueProbability: 0.8,
      maxRetries: 20,
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
