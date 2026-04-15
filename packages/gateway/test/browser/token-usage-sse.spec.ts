import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";

test("StatusPage updates tokenUsage5h table via token_usage_update global SSE", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;

  try {
    await page.goto(`${baseUrl}/status`);

    // Wait for the page to connect SSE
    await page.waitForSelector("[data-global-sse-connected='true']", { timeout: 10000 });

    // Initially no token usage data in the table
    await expect(page.locator("text=No token usage data in the last 5 hours.")).toBeVisible({ timeout: 3000 });

    // Inject a token_usage_update event via broadcastGlobal
    handle.sseBroadcaster.broadcastGlobal({
      type: "token_usage_update",
      summary: [
        {
          model: "gpt-4o-test-model",
          inputTokens: 42000,
          outputTokens: 8000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          multiplier: 1,
        },
      ],
    });

    // The UI should now show the model in the token consumption table
    await expect(page.locator("text=gpt-4o-test-model")).toBeVisible({ timeout: 3000 });
    // Input tokens should be formatted as 42,000
    await expect(page.locator("text=42,000")).toBeVisible({ timeout: 3000 });
  } finally {
    await handle.close();
  }
});

test("StatusPage does not poll for token usage after initial mount", async ({ page }) => {
  const store = new Store();
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null });
  const baseUrl = `http://localhost:${handle.port}`;

  // Track how many times /api/token-usage is called after initial mount
  let tokenUsageCallCount = 0;
  await page.route("**/api/token-usage**", async (route) => {
    tokenUsageCallCount++;
    await route.fulfill({ status: 200, body: JSON.stringify([]), contentType: "application/json" });
  });

  try {
    await page.goto(`${baseUrl}/status`);
    await page.waitForSelector("[data-global-sse-connected='true']", { timeout: 10000 });

    // Give a moment for initial fetches to settle
    await page.waitForTimeout(500);
    const countAfterMount = tokenUsageCallCount;

    // Wait 3 seconds — this is well under the old 60s polling interval.
    // With polling removed, count should remain unchanged.
    await page.waitForTimeout(3000);

    // Count should not have increased (no polling active)
    expect(tokenUsageCallCount).toBe(countAfterMount);
  } finally {
    await handle.close();
  }
});
