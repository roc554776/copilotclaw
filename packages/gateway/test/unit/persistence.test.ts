import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/store.js";

describe("Store persistence (SQLite)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-persist-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function dbPath(): string {
    return join(tmpDir, "store.db");
  }

  it("saves and restores channels", () => {
    const store = new Store({ persistPath: dbPath() });
    const ch = store.createChannel();
    store.close();

    const store2 = new Store({ persistPath: dbPath() });
    const channels = store2.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe(ch.id);
    store2.close();
  });

  it("saves and restores messages", () => {
    const store = new Store({ persistPath: dbPath() });
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "hello");
    store.addMessage(ch.id, "agent", "hi back");
    store.close();

    const store2 = new Store({ persistPath: dbPath() });
    const msgs = store2.listMessages(ch.id, 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.message).toBe("hi back");
    expect(msgs[1]!.message).toBe("hello");
    store2.close();
  });

  it("saves and restores pending queue", () => {
    const store = new Store({ persistPath: dbPath() });
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "pending msg");
    store.close();

    const store2 = new Store({ persistPath: dbPath() });
    expect(store2.hasPending(ch.id)).toBe(true);
    const drained = store2.drainPending(ch.id);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.message).toBe("pending msg");
    store2.close();
  });

  it("persists drain operation (pending removed after reload)", () => {
    const store = new Store({ persistPath: dbPath() });
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "will be drained");
    store.drainPending(ch.id);
    store.close();

    const store2 = new Store({ persistPath: dbPath() });
    expect(store2.hasPending(ch.id)).toBe(false);
    store2.close();
  });

  it("works without persistPath (in-memory only)", () => {
    const store = new Store();
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "ephemeral");
    expect(store.listMessages(ch.id, 10)).toHaveLength(1);
  });

  it("handles missing file gracefully", () => {
    const store = new Store({ persistPath: dbPath() });
    expect(store.listChannels()).toEqual([]);
    store.close();
  });

  it("creates SQLite database file on first write", () => {
    const path = dbPath();
    const store = new Store({ persistPath: path });
    store.createChannel();
    expect(existsSync(path)).toBe(true);
    store.close();
  });

  it("migrates data from legacy JSON store", () => {
    // Create a legacy JSON store file
    const jsonPath = join(tmpDir, "store.json");
    writeFileSync(jsonPath, JSON.stringify({
      channels: [{ id: "ch-legacy", createdAt: "2026-03-27T00:00:00Z" }],
      messages: { "ch-legacy": [{ id: "msg-1", channelId: "ch-legacy", sender: "user", message: "legacy hello", createdAt: "2026-03-27T00:00:01Z" }] },
      pendingQueues: { "ch-legacy": ["msg-1"] },
    }), "utf-8");

    const store = new Store({ persistPath: dbPath(), legacyJsonPath: jsonPath });
    const channels = store.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-legacy");

    const msgs = store.listMessages("ch-legacy", 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.message).toBe("legacy hello");

    expect(store.hasPending("ch-legacy")).toBe(true);
    store.close();
  });

  it("does not re-migrate if DB already has data", () => {
    const jsonPath = join(tmpDir, "store.json");
    writeFileSync(jsonPath, JSON.stringify({
      channels: [{ id: "ch-old", createdAt: "2026-03-27T00:00:00Z" }],
      messages: {},
      pendingQueues: {},
    }), "utf-8");

    // First load: migrates
    const store = new Store({ persistPath: dbPath(), legacyJsonPath: jsonPath });
    expect(store.listChannels()).toHaveLength(1);
    // Add another channel after migration
    store.createChannel();
    store.close();

    // Second load: should not re-migrate (DB already has channels)
    const store2 = new Store({ persistPath: dbPath(), legacyJsonPath: jsonPath });
    expect(store2.listChannels()).toHaveLength(2); // migrated + new
    store2.close();
  });
});
