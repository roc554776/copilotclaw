import { getProfileName, resolvePort } from "./config.js";

async function main(): Promise<void> {
  const port = resolvePort(getProfileName());
  const url = `http://localhost:${port}/api/stop`;
  try {
    const res = await fetch(url, { method: "POST" });
    if (res.ok) {
      console.error("[gateway] stopped");
    } else {
      console.error(`[gateway] unexpected response: ${res.status}`);
      process.exit(1);
    }
  } catch {
    console.error("[gateway] not running");
  }
}

main();
