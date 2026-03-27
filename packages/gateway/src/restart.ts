import { getProfileName, resolvePort } from "./config.js";

function log(message: string): void {
  console.error(`[gateway] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function stopGateway(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/stop`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForShutdown(port: number): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    try {
      await fetch(`http://localhost:${port}/healthz`);
    } catch {
      return true; // Port is free — shutdown complete
    }
  }
  return false;
}

async function main(): Promise<void> {
  const port = resolvePort(getProfileName());

  // Stop existing gateway
  log("stopping gateway...");
  const stopped = await stopGateway(port);
  if (stopped) {
    const shutdownComplete = await waitForShutdown(port);
    if (!shutdownComplete) {
      console.error("[gateway] shutdown timed out");
      process.exit(1);
    }
    log("gateway stopped");
  } else {
    log("gateway not running");
  }

  // Start new gateway by importing the start script
  log("starting gateway...");
  await import("./index.js");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
