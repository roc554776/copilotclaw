import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { loadConfig, saveConfig } from "./config.js";
import { DEFAULT_PORT } from "./server.js";
import { ensureWorkspace, getDataDir, getWorkspaceRoot } from "./workspace.js";

function log(message: string): void {
  console.error(`[setup] ${message}`);
}

// Port candidates: non-round, non-common numbers in the registered range.
// Avoids well-known ports, common dev ports (3000, 8080, etc.), and round numbers.
const PORT_CANDIDATES = [
  19741, // default
  19743, 19747, 19753, 19759,
  21473, 21479, 21487, 21491,
  23147, 23153, 23159, 23167,
  24713, 24719, 24733, 24749,
  27143, 27149, 27163, 27179,
];

/** Check if a port is available by attempting to bind it. */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => { resolve(false); });
    server.listen(port, () => {
      server.close(() => { resolve(true); });
    });
  });
}

/** Find the first available port from the candidate list. */
export async function findAvailablePort(candidates: readonly number[] = PORT_CANDIDATES): Promise<number | undefined> {
  for (const port of candidates) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return undefined;
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

  // Port selection: if config already has a port, skip. Otherwise check default.
  const existingConfig = loadConfig();
  if (existingConfig.port === undefined) {
    const defaultAvailable = await isPortAvailable(DEFAULT_PORT);
    if (!defaultAvailable) {
      log(`default port ${DEFAULT_PORT} is in use, searching for available port...`);
      const available = await findAvailablePort(PORT_CANDIDATES.filter((p) => p !== DEFAULT_PORT));
      if (available !== undefined) {
        saveConfig({ ...existingConfig, port: available });
        log(`port ${available} selected and saved to config`);
      } else {
        log(`ERROR: no available port found — set port manually in config`);
        process.exit(1);
      }
    }
  } else {
    log(`port ${existingConfig.port} configured`);
  }

  log("setup complete");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
