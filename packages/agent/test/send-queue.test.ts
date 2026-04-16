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

  it("ACK protocol: disk is not cleared on flush, cleared after all ACKs received", async () => {
    const queuePath = join(TEST_DIR, "send-queue.jsonl");
    const { initSendQueue, sendToGateway, flushSendQueue, setStreamSocket, acknowledgeMessage, pendingAckIds } = await getModule();
    initSendQueue(TEST_DIR);

    // Buffer two messages while disconnected
    sendToGateway({ type: "event_a" });
    sendToGateway({ type: "event_b" });

    // Connect stream and flush
    const written: string[] = [];
    const mockSocket = {
      destroyed: false,
      write: (data: string) => { written.push(data); return true; },
    };
    setStreamSocket(mockSocket as never);
    flushSendQueue();

    // Disk should still have the messages (not cleared yet — waiting for ACKs)
    const diskAfterFlush = readFileSync(queuePath, "utf-8");
    expect(diskAfterFlush.trim().length).toBeGreaterThan(0);
    expect(pendingAckIds.size).toBe(2);

    // Each flushed message has a _queueId
    const sent = written.map((w) => JSON.parse(w));
    expect(sent[0]!._queueId).toBeDefined();
    expect(sent[1]!._queueId).toBeDefined();

    // ACK first message — disk still has content (second pending)
    acknowledgeMessage(sent[0]!._queueId as string);
    expect(pendingAckIds.size).toBe(1);
    const diskAfterFirstAck = readFileSync(queuePath, "utf-8");
    expect(diskAfterFirstAck.trim().length).toBeGreaterThan(0);

    // ACK second message — disk should now be cleared
    acknowledgeMessage(sent[1]!._queueId as string);
    expect(pendingAckIds.size).toBe(0);
    const diskAfterAllAcks = readFileSync(queuePath, "utf-8");
    expect(diskAfterAllAcks).toBe("");
  });

  it("ACK protocol: buffered messages carry _queueId field", async () => {
    const { initSendQueue, sendToGateway } = await getModule();
    initSendQueue(TEST_DIR);

    sendToGateway({ type: "event_x" });

    const queuePath = join(TEST_DIR, "send-queue.jsonl");
    const line = readFileSync(queuePath, "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed._queueId).toBeDefined();
    expect(typeof parsed._queueId).toBe("string");
    // Original type field is preserved
    expect(parsed.type).toBe("event_x");
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
    const { initSendQueue, sendToGateway, maxQueueSize } = await getModule();

    // Pre-populate the disk file with exactly maxQueueSize lines so that the
    // very next sendToGateway call triggers eviction without a 10000-message loop.
    const queuePath = join(TEST_DIR, "send-queue.jsonl");
    const preLines = Array.from({ length: maxQueueSize }, (_, i) =>
      JSON.stringify({ type: "old", index: i }),
    );
    writeFileSync(queuePath, preLines.join("\n") + "\n", "utf-8");

    initSendQueue(TEST_DIR); // restores maxQueueSize messages from disk

    // This push should evict the oldest (index: 0) and trigger a full disk rewrite.
    sendToGateway({ type: "new", index: maxQueueSize });

    // Disk file must still contain exactly maxQueueSize lines.
    const diskContent = readFileSync(queuePath, "utf-8");
    const diskLines = diskContent.trim().split("\n").filter((l) => l.trim() !== "");
    expect(diskLines).toHaveLength(maxQueueSize);

    // The oldest message (index: 0) must be gone; the newest must be present.
    const parsed = diskLines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ type: "old", index: 1 });
    expect(parsed[maxQueueSize - 1]).toMatchObject({ type: "new", index: maxQueueSize });
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
