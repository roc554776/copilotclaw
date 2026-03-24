import { startServer } from "./server.js";

async function main(): Promise<void> {
  await startServer();
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
