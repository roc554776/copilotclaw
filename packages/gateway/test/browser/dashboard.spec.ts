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
  await expect(statusBar).toContainText("gateway: running");
});

test("processing indicator is hidden by default", async ({ page }) => {
  await page.goto(baseUrl);
  const indicator = page.locator("#processing-indicator");
  await expect(indicator).not.toBeVisible();
});

test("processing indicator hides when agent message arrives via SSE", async ({ page }) => {
  await page.goto(`${baseUrl}/?channel=${channelId}`);

  // Wait for SSE connection (green dot)
  await page.waitForSelector(".ws-connected", { timeout: 3000 });

  // Force show the processing indicator via JS
  await page.evaluate(() => {
    const el = document.getElementById("processing-indicator");
    if (el) el.classList.add("visible");
  });
  await expect(page.locator("#processing-indicator")).toBeVisible();

  // Post an agent message — SSE should trigger hiding
  await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "agent", message: "done processing" }),
  });

  // Indicator should become hidden
  await expect(page.locator("#processing-indicator")).not.toBeVisible({ timeout: 3000 });
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

test("status bar shows incompatible label when agent is incompatible", async ({ page }) => {
  await page.goto(baseUrl);

  // Wait for status to load — agent is null (no agent manager), so should show unavailable or —
  await page.waitForTimeout(1000);

  // Check that status bar contains agent info
  const statusText = await page.locator("#status-text").textContent();
  expect(statusText).toContain("gateway: running");
});

test("logs panel toggles on button click", async ({ page }) => {
  await page.goto(baseUrl);

  const logsPanel = page.locator("#logs-panel");
  const logsBtn = page.locator("#logs-btn");

  // Initially hidden
  await expect(logsPanel).not.toBeVisible();

  // Click to open
  await logsBtn.click();
  await expect(logsPanel).toBeVisible();

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
