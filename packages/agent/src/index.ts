import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { randomNumberTool } from "./tools/random-number.js";

async function main(): Promise<void> {
  const client = new CopilotClient();

  try {
    const session = await client.createSession({
      model: "gpt-4.1",
      onPermissionRequest: approveAll,
      tools: [randomNumberTool],
    });

    await runSessionLoop({
      session: adaptCopilotSession(session),
      initialPrompt:
        'Use the random_number tool with min=1 and max=100, then say "hello, random value: <value>" where <value> is the result. Respond in one sentence.',
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
