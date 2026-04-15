import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";

test("channel_list_change SSE adds new channel to sidebar", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    await page.waitForSelector(".ws-connected", { timeout: 10000 });
    await page.waitForSelector("[data-global-sse-connected='true']", { timeout: 10000 });

    // Wait for initial channel to appear in sidebar
    await expect(page.locator(`text=${channelId.slice(0, 8)}`)).toBeVisible({ timeout: 5000 });

    // Create a new channel via store and broadcast the change
    const newChannel = store.createChannel();
    handle.sseBroadcaster.broadcastGlobal({
      type: "channel_list_change",
      channels: store.listChannels({ includeArchived: true }),
    });

    // The sidebar should now show the new channel id (first 8 chars as displayed)
    await expect(page.locator(`text=${newChannel.id.slice(0, 8)}`)).toBeVisible({ timeout: 5000 });
  } finally {
    await handle.close();
  }
});

test("channel_list_change SSE falls back to first channel when active channel is removed from list", async ({ page }) => {
  const store = new Store();
  // Start the server first so the default channel is created
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  // After startServer, a default channel exists
  const ch1 = store.listChannels()[0]!;

  try {
    // Navigate with ch1 as the active channel
    await page.goto(`${baseUrl}/?channel=${ch1.id}`);
    await page.waitForSelector(".ws-connected", { timeout: 10000 });
    await page.waitForSelector("[data-global-sse-connected='true']", { timeout: 10000 });

    // Wait for initial channel to render
    await expect(page.locator(`text=${ch1.id.slice(0, 8)}`)).toBeVisible({ timeout: 5000 });

    // Broadcast a list with a brand-new channel that the frontend does not know (ch1 is absent → fallback)
    const ch2Id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const ch2 = { id: ch2Id, createdAt: new Date().toISOString() };
    handle.sseBroadcaster.broadcastGlobal({
      type: "channel_list_change",
      channels: [ch2],
    });

    // The sidebar should update to show ch2 and the URL should change to ch2
    await expect(page.locator(`text=${ch2.id.slice(0, 8)}`)).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(new RegExp(`channel=${ch2Id}`), { timeout: 5000 });
  } finally {
    await handle.close();
  }
});
