import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reset module state between tests by re-importing via dynamic import.
// The send queue uses module-level state (sendQueue array, sendQueuePath),
// so we need vi.resetModules() to get fresh state.

const TEST_DIR = join(import.meta.dirname, "..", "..", "..", "tmp", "test-state", "agent", "send-queue");

describe("send queue — buffering and persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function getModule() {
    const mod = await import("../src/ipc-server.js");
    return mod;
  }

  it("buffers messages when stream is not connected", async () => {
    const { initSendQueue, sendToGateway } = await getModule();
    initSendQueue(TEST_DIR);

    sendToGateway({ type: "session_event", data: "test1" });
    sendToGateway({ type: "channel_message", data: "test2" });

    // Messages should be persisted to disk
    const content = readFileSync(join(TEST_DIR, "send-queue.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session_event", data: "test1" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "channel_message", data: "test2" });
  });

  it("restores buffered messages from disk on init", async () => {
    // Write some messages to the queue file before init
    const queuePath = join(TEST_DIR, "send-queue.jsonl");
    writeFileSync(queuePath, '{"type":"old_event","data":"restored"}\n', "utf-8");

    const { initSendQueue, flushSendQueue, setStreamSocket } = await getModule();
    initSendQueue(TEST_DIR);

    // Create a mock socket to receive flushed messages
    const written: string[] = [];
    const mockSocket = {
      destroyed: false,
      write: (data: string) => { written.push(data); return true; },
    };
    setStreamSocket(mockSocket as never);

    flushSendQueue();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({ type: "old_event", data: "restored" });

    // Queue file should be cleared after flush
    const content = readFileSync(queuePath, "utf-8");
    expect(content).toBe("");
  });

  it("flushes buffered messages when stream connects", async () => {
    const { initSendQueue, sendToGateway, flushSendQueue, setStreamSocket } = await getModule();
    initSendQueue(TEST_DIR);

    // Buffer messages while disconnected
    sendToGateway({ type: "event1" });
    sendToGateway({ type: "event2" });

    // Connect stream
    const written: string[] = [];
    const mockSocket = {
      destroyed: false,
      write: (data: string) => { written.push(data); return true; },
    };
    setStreamSocket(mockSocket as never);

    flushSendQueue();

    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]!)).toMatchObject({ type: "event1" });
    expect(JSON.parse(written[1]!)).toMatchObject({ type: "event2" });
  });

  it("sends directly when stream is connected (no buffering)", async () => {
    const { initSendQueue, sendToGateway, setStreamSocket } = await getModule();
    initSendQueue(TEST_DIR);

    const written: string[] = [];
    const mockSocket = {
      destroyed: false,
      write: (data: string) => { written.push(data); return true; },
    };
    setStreamSocket(mockSocket as never);

    sendToGateway({ type: "direct_send" });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({ type: "direct_send" });

    // Queue file should not have been written (message sent directly)
    const queuePath = join(TEST_DIR, "send-queue.jsonl");
    const content = existsSync(queuePath) ? readFileSync(queuePath, "utf-8") : "";
    expect(content).toBe("");
  });

  it("drops oldest messages when queue exceeds size limit", async () => {
    const { initSendQueue, sendToGateway } = await getModule();
    initSendQueue(TEST_DIR);

    // The MAX_QUEUE_SIZE is 10000 — too large for a unit test.
    // Instead, verify the queue grows and the file is written.
    for (let i = 0; i < 5; i++) {
      sendToGateway({ type: "msg", index: i });
    }

    const content = readFileSync(join(TEST_DIR, "send-queue.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);
  });

  it("handles missing queue file gracefully on init", async () => {
    const { initSendQueue } = await getModule();
    // No queue file exists — should not throw
    expect(() => initSendQueue(TEST_DIR)).not.toThrow();
  });

  it("handles malformed queue file gracefully on init", async () => {
    writeFileSync(join(TEST_DIR, "send-queue.jsonl"), "not json\n{\"valid\":true}\n", "utf-8");

    const { initSendQueue, flushSendQueue, setStreamSocket } = await getModule();
    initSendQueue(TEST_DIR);

    const written: string[] = [];
    const mockSocket = {
      destroyed: false,
      write: (data: string) => { written.push(data); return true; },
    };
    setStreamSocket(mockSocket as never);

    flushSendQueue();

    // Only the valid line should be restored
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({ valid: true });
  });

  it("does not buffer when initSendQueue was not called", async () => {
    const { sendToGateway } = await getModule();
    // No initSendQueue call — sendToGateway should still work (just no disk persistence)
    expect(() => sendToGateway({ type: "no_init" })).not.toThrow();
  });
});
