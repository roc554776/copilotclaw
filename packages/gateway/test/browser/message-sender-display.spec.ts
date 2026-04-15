import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";

let handle: ServerHandle;
let baseUrl: string;
let channelId: string;
let store: Store;

test.beforeAll(async () => {
  store = new Store();
  handle = await startServer({ port: 0, store, agentManager: null });
  baseUrl = `http://localhost:${handle.port}`;
  const channels = store.listChannels();
  channelId = channels[0]!.id;
});

test.afterAll(async () => {
  await handle.close();
});

test("user message avatar is present", async ({ page }) => {
  // Post a user message via API
  await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "user", message: "hello from user" }),
  });

  await page.goto(`${baseUrl}/?channel=${channelId}`);
  await page.waitForSelector(".ws-connected", { timeout: 3000 });

  // User avatar should be visible
  const userAvatar = page.locator("[data-testid='avatar-user']");
  await expect(userAvatar).toBeVisible({ timeout: 3000 });
});

test("agent message avatar and display name are shown", async ({ page }) => {
  // Inject an agent message with senderMeta directly
  const freshStore = new Store();
  const freshHandle = await startServer({ port: 0, store: freshStore, agentManager: null });
  const freshUrl = `http://localhost:${freshHandle.port}`;
  const freshChannelId = freshStore.listChannels()[0]!.id;

  freshStore.addMessage(freshChannelId, "agent", "agent reply", {
    agentId: "channel-operator",
    agentDisplayName: "Channel Operator",
    agentRole: "channel-operator",
  });

  await page.goto(`${freshUrl}/?channel=${freshChannelId}`);
  await page.waitForSelector(".ws-connected", { timeout: 3000 });

  // Agent avatar should be visible
  const agentAvatar = page.locator("[data-testid='avatar-agent']");
  await expect(agentAvatar).toBeVisible({ timeout: 3000 });

  // Sender label "Channel Operator" should appear near the message
  await expect(page.locator("#chat")).toContainText("Channel Operator", { timeout: 3000 });

  await freshHandle.close();
});

test("agent avatar click opens ProfileModal and Escape closes it", async ({ page }) => {
  const freshStore = new Store();
  const freshHandle = await startServer({ port: 0, store: freshStore, agentManager: null });
  const freshUrl = `http://localhost:${freshHandle.port}`;
  const freshChannelId = freshStore.listChannels()[0]!.id;

  freshStore.addMessage(freshChannelId, "agent", "I am agent", {
    agentId: "channel-operator",
    agentDisplayName: "Channel Operator",
    agentRole: "channel-operator",
  });

  await page.goto(`${freshUrl}/?channel=${freshChannelId}`);
  await page.waitForSelector(".ws-connected", { timeout: 3000 });

  // Wait for the avatar to appear
  const agentAvatar = page.locator("[data-testid='avatar-agent']");
  await expect(agentAvatar).toBeVisible({ timeout: 3000 });

  // Click the avatar
  await agentAvatar.click();

  // ProfileModal should appear
  const modal = page.locator("[data-testid='profile-modal']");
  await expect(modal).toBeVisible({ timeout: 3000 });

  // Press Escape to close
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible({ timeout: 3000 });

  await freshHandle.close();
});

test("subagent messages are collapsed in details element", async ({ page }) => {
  const freshStore = new Store();
  const freshHandle = await startServer({ port: 0, store: freshStore, agentManager: null });
  const freshUrl = `http://localhost:${freshHandle.port}`;
  const freshChannelId = freshStore.listChannels()[0]!.id;

  // Add two consecutive subagent messages
  freshStore.addMessage(freshChannelId, "agent", "Subagent msg 1", {
    agentId: "worker",
    agentDisplayName: "Worker",
    agentRole: "subagent",
  });
  freshStore.addMessage(freshChannelId, "agent", "Subagent msg 2", {
    agentId: "worker",
    agentDisplayName: "Worker",
    agentRole: "subagent",
  });

  await page.goto(`${freshUrl}/?channel=${freshChannelId}`);
  await page.waitForSelector(".ws-connected", { timeout: 3000 });

  // The collapse group should be a details element
  const collapseGroup = page.locator("[data-testid='subagent-collapse-group']");
  await expect(collapseGroup).toBeVisible({ timeout: 3000 });

  // Summary should mention 2 messages
  const summary = page.locator("[data-testid='subagent-collapse-summary']");
  await expect(summary).toContainText("2 messages", { timeout: 3000 });

  // Details should be closed by default (not have open attribute)
  const isOpen = await collapseGroup.evaluate((el) => (el as HTMLDetailsElement).open);
  expect(isOpen).toBe(false);

  // Click summary to expand
  await summary.click();
  const isOpenAfter = await collapseGroup.evaluate((el) => (el as HTMLDetailsElement).open);
  expect(isOpenAfter).toBe(true);

  // Click summary again to collapse
  await summary.click();
  const isOpenFinal = await collapseGroup.evaluate((el) => (el as HTMLDetailsElement).open);
  expect(isOpenFinal).toBe(false);

  await freshHandle.close();
});
