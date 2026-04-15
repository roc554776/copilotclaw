import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";
import type { LogEntry } from "../../src/log-buffer.js";

test("logs panel shows entries injected via broadcastGlobal log_appended", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    // Wait for global SSE to be established
    await page.waitForSelector("[data-global-sse-connected='true']", { timeout: 10000 });

    // Open the logs panel
    await page.locator("#logs-btn").click();
    await expect(page.locator("#logs-panel")).toBeVisible();

    // Broadcast a log_appended event
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      source: "gateway",
      level: "info",
      message: "playwright-sse-log-test",
    };
    handle.sseBroadcaster.broadcastGlobal({
      type: "log_appended",
      entries: [entry],
    });

    // The log message should appear in the logs panel
    await expect(page.locator("#logs-panel")).toContainText("playwright-sse-log-test", { timeout: 3000 });
  } finally {
    await handle.close();
  }
});
