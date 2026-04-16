import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";

let handle: ServerHandle;
let baseUrl: string;
let channelId: string;

test.beforeAll(async () => {
  const store = new Store();
  handle = await startServer({ port: 0, store, agentManager: null });
  baseUrl = `http://localhost:${handle.port}`;
  const channels = store.listChannels();
  channelId = channels[0]!.id;
});

test.afterAll(async () => {
  await handle.close();
});

test("dashboard loads and shows status bar", async ({ page }) => {
  await page.goto(baseUrl);
  const statusBar = page.locator("#status-bar");
  await expect(statusBar).toBeVisible();
  await expect(statusBar).toContainText("gateway: v");
});

test("processing indicator is hidden by default", async ({ page }) => {
  await page.goto(baseUrl);
  const indicator = page.locator("#processing-indicator");
  await expect(indicator).not.toBeVisible();
});

test("processing indicator shows when sessionStatus is processing and hides when agent message arrives", async ({ page }) => {
  // Fresh server for isolation
  const freshStore = new Store();
  const freshHandle = await startServer({ port: 0, store: freshStore, agentManager: null });
  const freshUrl = `http://localhost:${freshHandle.port}`;
  const freshChannelId = freshStore.listChannels()[0]!.id;

  await page.goto(`${freshUrl}/?channel=${freshChannelId}`);
  await page.waitForSelector(".ws-connected", { timeout: 3000 });

  // Show the processing indicator via SSE channel_status_change with status "processing"
  freshHandle.sseBroadcaster.broadcast({
    type: "channel_status_change",
    channelId: freshChannelId,
    data: { sessionId: "test-session", status: "processing" },
  });
  await expect(page.locator("#processing-indicator")).toBeVisible({ timeout: 3000 });

  // Post an agent message — SSE new_message triggers refreshStatus which reads "no session" status
  await fetch(`${freshUrl}/api/channels/${freshChannelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "agent", message: "done processing" }),
  });

  // Indicator should become hidden as sessionStatus transitions away from "processing"
  await expect(page.locator("#processing-indicator")).not.toBeVisible({ timeout: 5000 });

  await freshHandle.close();
});

test("new message appears in chat via SSE without manual refresh", async ({ page }) => {
  // Use a fresh server to avoid interference
  const freshStore = new Store();
  const freshHandle = await startServer({ port: 0, store: freshStore, agentManager: null });
  const freshUrl = `http://localhost:${freshHandle.port}`;
  const freshChannelId = freshStore.listChannels()[0]!.id;

  await page.goto(`${freshUrl}/?channel=${freshChannelId}`);
  await page.waitForSelector(".ws-connected", { timeout: 3000 });

  // Post a user message
  await fetch(`${freshUrl}/api/channels/${freshChannelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "user", message: "hello from playwright" }),
  });

  // Chat should update via SSE
  await expect(page.locator("#chat")).toContainText("hello from playwright", { timeout: 3000 });

  await freshHandle.close();
});

test("status bar updates with agent info after status poll", async ({ page }) => {
  await page.goto(baseUrl);

  // Wait for refreshStatus to complete — status text should contain agent version or unavailable indicator
  await expect(page.locator("#status-text")).toContainText("gateway: v", { timeout: 3000 });
});

test("logs panel toggles on button click without opening status modal", async ({ page }) => {
  await page.goto(baseUrl);

  const logsPanel = page.locator("#logs-panel");
  const logsBtn = page.locator("#logs-btn");
  const modal = page.locator("#status-modal");

  // Initially hidden
  await expect(logsPanel).not.toBeVisible();

  // Click to open — status modal must NOT open (stopPropagation)
  await logsBtn.click();
  await expect(logsPanel).toBeVisible();
  await expect(modal).not.toBeVisible();

  // Click again to close
  await logsBtn.click();
  await expect(logsPanel).not.toBeVisible();
});

test("logs panel closes on Escape key", async ({ page }) => {
  await page.goto(baseUrl);

  const logsPanel = page.locator("#logs-panel");
  await page.locator("#logs-btn").click();
  await expect(logsPanel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(logsPanel).not.toBeVisible();
});

test("status modal opens on status bar click and closes on Escape", async ({ page }) => {
  await page.goto(baseUrl);

  const modal = page.locator("#status-modal");
  await expect(modal).not.toBeVisible();

  await page.locator("#status-bar").click();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("System Status");

  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
});
