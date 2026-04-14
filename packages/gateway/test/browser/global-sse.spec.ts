import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";

test("status bar updates agentVersion via global SSE agent_status_change", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    // Wait for the frontend to connect SSE
    await page.waitForSelector(".ws-connected", { timeout: 10000 });

    // Broadcast global agent_status_change event
    handle.sseBroadcaster.broadcastGlobal({
      type: "agent_status_change",
      version: "0.99.0",
      running: true,
    });

    // The status bar should reflect the new agent version
    await expect(page.locator("#status-text")).toContainText("0.99.0", { timeout: 3000 });
  } finally {
    await handle.close();
  }
});

test("status bar updates compatibility via global SSE agent_compatibility_change", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    await page.waitForSelector(".ws-connected", { timeout: 10000 });

    // Broadcast global agent_compatibility_change event
    handle.sseBroadcaster.broadcastGlobal({
      type: "agent_compatibility_change",
      compatibility: "incompatible",
    });

    // The status bar should reflect the incompatibility warning
    await expect(page.locator("#status-text")).toContainText("incompatible", { timeout: 3000 });
  } finally {
    await handle.close();
  }
});

test("global SSE does not affect channel SSE (independent connections)", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    await page.waitForSelector(".ws-connected", { timeout: 10000 });

    // Channel-specific SSE event should still work alongside global SSE
    handle.sseBroadcaster.broadcast({
      type: "session_status_change",
      channelId,
      data: { sessionId: "test-sess", status: "processing" },
    });

    await expect(page.locator("text=processing")).toBeVisible({ timeout: 3000 });
  } finally {
    await handle.close();
  }
});
