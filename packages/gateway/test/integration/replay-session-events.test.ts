import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_REPLAY_LIMIT, SessionEventStore } from "../../src/session-event-store.js";
import { replaySessionEventsAfter } from "../../src/daemon.js";

/**
 * Minimal mock ServerResponse with a spy on write().
 */
function makeMockRes(): { res: Pick<ServerResponse, "write">; written: string[] } {
  const written: string[] = [];
  const res = {
    write: vi.fn((chunk: string) => { written.push(chunk); return true; }),
  };
  return { res: res as unknown as Pick<ServerResponse, "write">, written };
}

describe("replaySessionEventsAfter", () => {
  let tmpDir: string;
  let store: SessionEventStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-replay-test-"));
    store = new SessionEventStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes events with id > afterId to res in ascending order with id: lines", () => {
    for (let i = 0; i < 5; i++) {
      store.appendEvent("replay-sess", { type: `event-${i}`, timestamp: `2026-04-15T00:00:0${i}Z`, data: { i } });
    }
    const all = store.getEvents("replay-sess");
    const pivotId = all[1]!.id!; // afterId = event-1's id

    const { res, written } = makeMockRes();
    const count = replaySessionEventsAfter(res as ServerResponse, "replay-sess", pivotId, store);

    expect(count).toBe(3);
    expect(written).toHaveLength(3);
    // Each written frame should have id: line matching the event id
    for (let i = 0; i < 3; i++) {
      const frame = written[i]!;
      const eventId = all[i + 2]!.id!;
      expect(frame).toMatch(new RegExp(`^id: ${eventId}\n`));
      expect(frame).toContain("data: ");
      expect(frame.endsWith("\n\n")).toBe(true);
    }
  });

  it("returns 0 and does not call write when afterId is NaN", () => {
    store.appendEvent("replay-nan", { type: "event-0", timestamp: "2026-04-15T00:00:00Z", data: {} });
    const { res, written } = makeMockRes();
    const count = replaySessionEventsAfter(res as ServerResponse, "replay-nan", NaN, store);
    expect(count).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("returns 0 and does not call write when afterId is beyond all event ids", () => {
    store.appendEvent("replay-beyond", { type: "event-0", timestamp: "2026-04-15T00:00:00Z", data: {} });
    const all = store.getEvents("replay-beyond");
    const maxId = all[all.length - 1]!.id!;

    const { res, written } = makeMockRes();
    const count = replaySessionEventsAfter(res as ServerResponse, "replay-beyond", maxId + 1000, store);
    expect(count).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("returns 0 and does not call write when session has no events", () => {
    const { res, written } = makeMockRes();
    const count = replaySessionEventsAfter(res as ServerResponse, "no-events-session", 0, store);
    expect(count).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("returns 0 and calls console.error when sessionEventStore.listEventsAfterId throws", () => {
    const errorStore = new SessionEventStore(tmpDir);
    errorStore.appendEvent("err-sess", { type: "event-0", timestamp: "2026-04-15T00:00:00Z", data: {} });

    const originalMethod = errorStore.listEventsAfterId.bind(errorStore);
    let shouldThrow = false;
    errorStore.listEventsAfterId = (...args) => {
      if (shouldThrow) throw new Error("simulated DB error");
      return originalMethod(...args);
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { res, written } = makeMockRes();

    shouldThrow = true;
    const count = replaySessionEventsAfter(res as ServerResponse, "err-sess", 0, errorStore);

    expect(count).toBe(0);
    expect(written).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    errorStore.close();
  });

  it("logs a warning when SESSION_REPLAY_LIMIT is reached", () => {
    for (let i = 0; i < SESSION_REPLAY_LIMIT + 5; i++) {
      store.appendEvent("replay-limit", { type: `event-${i}`, timestamp: "2026-04-15T00:00:00Z", data: {} });
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res } = makeMockRes();
    const count = replaySessionEventsAfter(res as ServerResponse, "replay-limit", 0, store);

    expect(count).toBe(SESSION_REPLAY_LIMIT);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("limit reached"));

    warnSpy.mockRestore();
  });

  it("writes events for afterId=0 (all events)", () => {
    for (let i = 0; i < 3; i++) {
      store.appendEvent("replay-all", { type: `event-${i}`, timestamp: `2026-04-15T00:00:0${i}Z`, data: {} });
    }

    const { res, written } = makeMockRes();
    const count = replaySessionEventsAfter(res as ServerResponse, "replay-all", 0, store);
    expect(count).toBe(3);
    expect(written).toHaveLength(3);
  });
});
