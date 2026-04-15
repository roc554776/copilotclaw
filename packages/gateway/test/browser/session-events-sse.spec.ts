import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startServer, type ServerHandle } from "../../src/server.js";
import { Store } from "../../src/store.js";
import { SessionEventStore } from "../../src/session-event-store.js";

test("SessionEventsPage receives live events via SSE after session_event_appended broadcast", async ({ page }) => {
  const store = new Store();
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  const tmpDir = mkdtempSync(join(process.cwd(), "tmp/session-events-sse-test-"));
  const sessionEventStore = new SessionEventStore(tmpDir);
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null, sessionEventStore });
  const baseUrl = `http://localhost:${handle.port}`;
  const testSessionId = "playwright-test-session-001";

  // Wire the onAppend hook to broadcastToSession (mirrors daemon.ts wiring)
  sessionEventStore.setOnAppend((sessionId, event) => {
    handle.sseBroadcaster.broadcastToSession(sessionId, {
      type: "session_event_appended",
      event,
    });
  });

  try {
    // Navigate to the SessionEventsPage for this session
    await page.goto(`${baseUrl}/sessions/${encodeURIComponent(testSessionId)}/events`);

    // Wait for the session SSE to be connected
    await page.waitForSelector("[data-session-sse-connected='true']", { timeout: 10000 });

    // Inject a new event via the store (hook will broadcast via SSE)
    sessionEventStore.appendEvent(testSessionId, {
      type: "tool.execution_start",
      timestamp: new Date().toISOString(),
      data: { toolName: "playwright-sse-test-tool" },
    });

    // The event should appear in the page
    await expect(page.locator("text=tool.execution_start")).toBeVisible({ timeout: 5000 });
  } finally {
    await handle.close();
    sessionEventStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("SessionEventsPage deduplicates events arriving via SSE that match initial snapshot", async ({ page }) => {
  const store = new Store();
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  const tmpDir = mkdtempSync(join(process.cwd(), "tmp/session-events-dedup-test-"));
  const sessionEventStore = new SessionEventStore(tmpDir);
  const handle: ServerHandle = await startServer({ port: 0, store, agentManager: null, sessionEventStore });
  const baseUrl = `http://localhost:${handle.port}`;
  const testSessionId = "playwright-dedup-session-002";

  // Prepopulate the store before page load so initial snapshot fetch returns it
  sessionEventStore.appendEvent(testSessionId, {
    type: "session.start",
    timestamp: "2026-04-14T10:00:00Z",
    data: { sessionId: testSessionId },
  });

  // Wire hook after initial population
  sessionEventStore.setOnAppend((sessionId, event) => {
    handle.sseBroadcaster.broadcastToSession(sessionId, {
      type: "session_event_appended",
      event,
    });
  });

  try {
    await page.goto(`${baseUrl}/sessions/${encodeURIComponent(testSessionId)}/events`);

    // Wait for SSE connection and initial data
    await page.waitForSelector("[data-session-sse-connected='true']", { timeout: 10000 });
    await expect(page.locator("text=session.start")).toBeVisible({ timeout: 5000 });

    // Add a genuinely new event — should appear in the page
    sessionEventStore.appendEvent(testSessionId, {
      type: "tool.execution_complete",
      timestamp: "2026-04-14T10:01:00Z",
      data: { result: "success" },
    });

    await expect(page.locator("text=tool.execution_complete")).toBeVisible({ timeout: 5000 });

    // Verify count: exactly 2 events
    await expect(page.locator("text=(2 events loaded)")).toBeVisible({ timeout: 3000 });
  } finally {
    await handle.close();
    sessionEventStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
