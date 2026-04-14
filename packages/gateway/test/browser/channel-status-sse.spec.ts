import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";

/** Wait for the SSE connection to be established by polling the SSE broadcaster. */
async function waitForSseConnection(handle: ServerHandle, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.sseBroadcaster.clientCount > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`SSE connection not established within ${timeoutMs}ms`);
}

test("status bar shows derivedStatus from session_status_change SSE event", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;
  const channelId = store.listChannels()[0]!.id;

  try {
    await page.goto(`${baseUrl}/?channel=${channelId}`);
    // Wait for the frontend to connect SSE by polling the broadcaster
    await waitForSseConnection(handle);

    // Broadcast a session_status_change event with derivedStatus directly via sseBroadcaster
    handle.sseBroadcaster.broadcast({
      type: "session_status_change",
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
    await waitForSseConnection(handle);

    // Broadcast derivedStatus = "no-physical-session-initial"
    handle.sseBroadcaster.broadcast({
      type: "session_status_change",
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
    await waitForSseConnection(handle);

    // Broadcast without derivedStatus — frontend should fall back to raw status
    handle.sseBroadcaster.broadcast({
      type: "session_status_change",
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
