import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/store.js";

function tempPath(): string {
  return join(tmpdir(), `copilotclaw-test-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const p of cleanupPaths) {
    try { unlinkSync(p); } catch {}
    try { unlinkSync(`${p}.tmp`); } catch {}
  }
  cleanupPaths.length = 0;
  vi.restoreAllMocks();
});

describe("Store persistence", () => {
  it("saves and restores channels", () => {
    const path = tempPath();
    cleanupPaths.push(path);

    const store = new Store({ persistPath: path });
    const ch = store.createChannel();

    const store2 = new Store({ persistPath: path });
    const channels = store2.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe(ch.id);
  });

  it("saves and restores messages", () => {
    const path = tempPath();
    cleanupPaths.push(path);

    const store = new Store({ persistPath: path });
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "hello");
    store.addMessage(ch.id, "agent", "hi back");

    const store2 = new Store({ persistPath: path });
    const msgs = store2.listMessages(ch.id, 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.message).toBe("hi back");
    expect(msgs[1]!.message).toBe("hello");
  });

  it("saves and restores pending queue", () => {
    const path = tempPath();
    cleanupPaths.push(path);

    const store = new Store({ persistPath: path });
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "pending msg");

    const store2 = new Store({ persistPath: path });
    expect(store2.hasPending(ch.id)).toBe(true);
    const drained = store2.drainPending(ch.id);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.message).toBe("pending msg");
  });

  it("persists drain operation (pending removed after reload)", () => {
    const path = tempPath();
    cleanupPaths.push(path);

    const store = new Store({ persistPath: path });
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "will be drained");
    store.drainPending(ch.id);

    const store2 = new Store({ persistPath: path });
    expect(store2.hasPending(ch.id)).toBe(false);
  });

  it("works without persistPath (in-memory only)", () => {
    const store = new Store();
    const ch = store.createChannel();
    store.addMessage(ch.id, "user", "ephemeral");
    expect(store.listMessages(ch.id, 10)).toHaveLength(1);
  });

  it("handles missing file gracefully", () => {
    const path = tempPath();
    // Don't create the file — Store should start fresh
    const store = new Store({ persistPath: path });
    expect(store.listChannels()).toEqual([]);
    cleanupPaths.push(path);
  });

  it("handles corrupt file gracefully and logs a warning", () => {
    const path = tempPath();
    cleanupPaths.push(path);
    writeFileSync(path, "not valid json{{{", "utf-8");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new Store({ persistPath: path });
    expect(store.listChannels()).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(path));
  });

  it("uses atomic write (no leftover .tmp file after save)", () => {
    const path = tempPath();
    cleanupPaths.push(path);

    const store = new Store({ persistPath: path });
    store.createChannel();

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
