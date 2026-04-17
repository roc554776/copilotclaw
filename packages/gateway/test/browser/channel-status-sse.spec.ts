import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";

test("status bar shows derivedStatus from channel_status_change SSE event", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    // Wait for the frontend to connect SSE by watching for the green dot indicator
    await page.waitForSelector(".ws-connected", { timeout: 10000 });

    // Broadcast a session_status_change event with derivedStatus directly via sseBroadcaster
    handle.sseBroadcaster.broadcast({
      type: "channel_status_change",
      channelId,
      data: {
        sessionId: "test-session-id",
        status: "waiting",
        derivedStatus: "idle-no-trigger",
      },
    });

    // The status bar should reflect derivedStatus "idle-no-trigger"
    await expect(page.locator("text=idle-no-trigger")).toBeVisible({ timeout: 3000 });
  } finally {
    await handle.close();
  }
});

test("status bar shows derivedStatus no-physical-session-initial via SSE", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    await page.waitForSelector(".ws-connected", { timeout: 10000 });

    // Broadcast derivedStatus = "no-physical-session-initial"
    handle.sseBroadcaster.broadcast({
      type: "channel_status_change",
      channelId,
      data: {
        sessionId: "test-session-id",
        status: "new",
        derivedStatus: "no-physical-session-initial",
      },
    });

    await expect(page.locator("text=no-physical-session-initial")).toBeVisible({ timeout: 3000 });
  } finally {
    await handle.close();
  }
});

test("status bar falls back to raw status when derivedStatus absent in SSE event", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    await page.waitForSelector(".ws-connected", { timeout: 10000 });

    // Broadcast without derivedStatus — frontend should fall back to raw status
    handle.sseBroadcaster.broadcast({
      type: "channel_status_change",
      channelId,
      data: {
        sessionId: "test-session-id",
        status: "processing",
      },
    });

    await expect(page.locator("text=processing")).toBeVisible({ timeout: 3000 });
  } finally {
    await handle.close();
  }
});

// v0.83.0 backward compatibility: DashboardPage accepts both "channel_status_change" (new name)
// and "session_status_change" (pre-v0.83.0 name). This test verifies the old name still works.
test("status bar updates via legacy session_status_change SSE event name (backward compat)", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    await page.waitForSelector(".ws-connected", { timeout: 10000 });

    // Broadcast with old event type name — frontend must still update status bar
    handle.sseBroadcaster.broadcast({
      type: "session_status_change",
      channelId,
      data: {
        sessionId: "test-session-id",
        status: "waiting",
        derivedStatus: "pending-trigger",
      },
    });

    await expect(page.locator("text=pending-trigger")).toBeVisible({ timeout: 3000 });
  } finally {
    await handle.close();
  }
});
