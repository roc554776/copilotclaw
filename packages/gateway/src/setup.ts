import { existsSync } from "node:fs";
import { ensureWorkspace, getDataDir, getWorkspaceRoot } from "./workspace.js";

function log(message: string): void {
  console.error(`[setup] ${message}`);
}

async function main(): Promise<void> {
  const root = getWorkspaceRoot();
  const alreadyExists = existsSync(getDataDir());

  ensureWorkspace();

  if (alreadyExists) {
    log(`workspace already exists at ${root}`);
  } else {
    log(`workspace created at ${root}`);
  }

  log("setup complete");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
