import { DEFAULT_PORT, startServer } from "./server.js";

const HEALTH_RETRY_COUNT = 5;
const HEALTH_RETRY_INTERVAL_MS = 1000;

function log(message: string): void {
  console.error(`[gateway] ${message}`);
}

async function checkHealth(): Promise<"healthy" | "unhealthy" | "port-free"> {
  try {
    const res = await fetch(`http://localhost:${DEFAULT_PORT}/healthz`);
    if (res.ok) return "healthy";
    return "unhealthy";
  } catch {
    return "port-free";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function main(): Promise<void> {
  const initialStatus = await checkHealth();

  if (initialStatus === "healthy") {
    log(`already running on port ${DEFAULT_PORT}`);
    return;
  }

  if (initialStatus === "unhealthy") {
    log(`port ${DEFAULT_PORT} is occupied but unhealthy, retrying...`);
    for (let attempt = 0; attempt < HEALTH_RETRY_COUNT; attempt++) {
      await sleep(HEALTH_RETRY_INTERVAL_MS);
      const status = await checkHealth();
      if (status === "healthy") {
        log("became healthy");
        return;
      }
      if (status === "port-free") {
        log("port freed, starting server");
        await startServer();
        return;
      }
      log(`retry ${attempt + 1}/${HEALTH_RETRY_COUNT}...`);
    }
    throw new Error(`port ${DEFAULT_PORT} is occupied but not healthy after ${HEALTH_RETRY_COUNT} retries`);
  }

  await startServer();
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
