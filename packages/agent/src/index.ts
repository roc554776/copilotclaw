import { CopilotClient, approveAll } from "@github/copilot-sdk";

const CONTINUE_PROBABILITY = 0.8;
const MAX_RETRIES = 20;

function log(message: string): void {
  console.error(`[agent] ${message}`);
}

async function main(): Promise<void> {
  const client = new CopilotClient();

  try {
    let helloCount = 0;

    const session = await client.createSession({
      model: "gpt-4.1",
      onPermissionRequest: approveAll,
    });

    try {
      const done = new Promise<void>((resolve, reject) => {
        let settled = false;

        function settle(action: () => void): void {
          if (settled) return;
          settled = true;
          action();
        }

        session.on("assistant.message", (event) => {
          console.log(event.data.content);
        });

        session.on("session.error", (event) => {
          settle(() => {
            reject(new Error(event.data.message));
          });
        });

        session.on("session.idle", () => {
          if (settled) return;

          helloCount++;
          if (helloCount > MAX_RETRIES) {
            log(`reached max retries (${MAX_RETRIES}), stopping`);
            settle(() => { resolve(); });
            return;
          }

          if (Math.random() < CONTINUE_PROBABILITY) {
            log(`blocked stop (hello #${helloCount})`);
            session
              .send({
                prompt: `Say "hello ${helloCount}" and then say you are about to stop.`,
                mode: "enqueue",
              })
              .catch((err: unknown) => {
                settle(() => {
                  reject(err instanceof Error ? err : new Error(String(err)));
                });
              });
          } else {
            log(`allowing stop (after ${helloCount} extra hellos)`);
            settle(() => { resolve(); });
          }
        });
      });

      await session.send({
        prompt: "Say hello! Respond in one sentence.",
      });
      await done;
    } finally {
      try {
        await session.disconnect();
      } catch (disconnectErr: unknown) {
        log(`disconnect error (suppressed): ${String(disconnectErr)}`);
      }
    }
  } finally {
    await client.stop();
  }
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
