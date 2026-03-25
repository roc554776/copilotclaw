import { describe, expect, it, beforeEach } from "vitest";
import { Store } from "../../src/store.js";

describe("Store", () => {
  let store: Store;
  let channelId: string;

  beforeEach(() => {
    store = new Store();
    channelId = store.createChannel().id;
  });

  describe("createChannel", () => {
    it("returns a Channel with id and createdAt", () => {
      const ch = store.createChannel();
      expect(ch.id).toBeTruthy();
      expect(ch.createdAt).toBeTruthy();
    });

    it("generates unique channel ids", () => {
      const a = store.createChannel();
      const b = store.createChannel();
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("listChannels", () => {
    it("returns channels sorted by createdAt", () => {
      const channels = store.listChannels();
      expect(channels.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("addMessage", () => {
    it("returns a Message with id, channelId, sender, and createdAt", () => {
      const msg = store.addMessage(channelId, "user", "hello");
      expect(msg).toBeDefined();
      expect(msg!.id).toBeTruthy();
      expect(msg!.channelId).toBe(channelId);
      expect(msg!.sender).toBe("user");
      expect(msg!.message).toBe("hello");
    });

    it("returns undefined for non-existent channel", () => {
      expect(store.addMessage("nonexistent", "user", "hello")).toBeUndefined();
    });

    it("generates unique ids", () => {
      const a = store.addMessage(channelId, "user", "a");
      const b = store.addMessage(channelId, "user", "b");
      expect(a!.id).not.toBe(b!.id);
    });

    it("adds user messages to pending queue", () => {
      store.addMessage(channelId, "user", "pending msg");
      expect(store.hasPending(channelId)).toBe(true);
    });

    it("does not add agent messages to pending queue", () => {
      store.addMessage(channelId, "agent", "agent msg");
      expect(store.hasPending(channelId)).toBe(false);
    });
  });

  describe("drainPending", () => {
    it("returns empty array when queue is empty", () => {
      expect(store.drainPending(channelId)).toEqual([]);
    });

    it("returns all pending user messages in FIFO order", () => {
      store.addMessage(channelId, "user", "first");
      store.addMessage(channelId, "user", "second");
      store.addMessage(channelId, "user", "third");

      const drained = store.drainPending(channelId);
      expect(drained).toHaveLength(3);
      expect(drained[0]?.message).toBe("first");
      expect(drained[1]?.message).toBe("second");
      expect(drained[2]?.message).toBe("third");
    });

    it("drains each message only once", () => {
      store.addMessage(channelId, "user", "once");
      store.drainPending(channelId);
      expect(store.drainPending(channelId)).toEqual([]);
    });

    it("keeps channels independent", () => {
      const ch2 = store.createChannel().id;
      store.addMessage(channelId, "user", "ch1-msg");
      store.addMessage(ch2, "user", "ch2-msg");

      const drained1 = store.drainPending(channelId);
      expect(drained1).toHaveLength(1);
      expect(drained1[0]?.message).toBe("ch1-msg");

      const drained2 = store.drainPending(ch2);
      expect(drained2).toHaveLength(1);
      expect(drained2[0]?.message).toBe("ch2-msg");
    });

    it("does not drain agent messages", () => {
      store.addMessage(channelId, "agent", "not pending");
      store.addMessage(channelId, "user", "pending");
      const drained = store.drainPending(channelId);
      expect(drained).toHaveLength(1);
      expect(drained[0]?.sender).toBe("user");
    });
  });

  describe("peekOldestPending", () => {
    it("returns undefined when no pending messages", () => {
      expect(store.peekOldestPending(channelId)).toBeUndefined();
    });

    it("returns the oldest pending user message without removing it", () => {
      store.addMessage(channelId, "user", "oldest");
      store.addMessage(channelId, "user", "newer");
      const peeked = store.peekOldestPending(channelId);
      expect(peeked?.message).toBe("oldest");
      // Still in queue
      expect(store.hasPending(channelId)).toBe(true);
    });
  });

  describe("flushPending", () => {
    it("removes all pending messages and returns count", () => {
      store.addMessage(channelId, "user", "a");
      store.addMessage(channelId, "user", "b");
      const count = store.flushPending(channelId);
      expect(count).toBe(2);
      expect(store.hasPending(channelId)).toBe(false);
    });
  });

  describe("listMessages", () => {
    it("returns empty array when no messages", () => {
      expect(store.listMessages(channelId)).toEqual([]);
    });

    it("includes both user and agent messages", () => {
      store.addMessage(channelId, "user", "hello");
      store.addMessage(channelId, "agent", "hi back");
      const msgs = store.listMessages(channelId, 10);
      expect(msgs).toHaveLength(2);
    });

    it("respects limit and returns latest messages first", () => {
      store.addMessage(channelId, "user", "msg-1");
      store.addMessage(channelId, "agent", "msg-2");
      store.addMessage(channelId, "user", "msg-3");
      store.addMessage(channelId, "agent", "msg-4");
      store.addMessage(channelId, "user", "msg-5");

      const msgs = store.listMessages(channelId, 3);
      expect(msgs).toHaveLength(3);
      expect(msgs[0]?.message).toBe("msg-5");
      expect(msgs[2]?.message).toBe("msg-3");
    });

    it("returns empty for non-existent channel", () => {
      expect(store.listMessages("nonexistent")).toEqual([]);
    });
  });

  describe("pendingCounts", () => {
    it("returns counts for all channels", () => {
      const ch2 = store.createChannel().id;
      store.addMessage(channelId, "user", "a");
      store.addMessage(channelId, "user", "b");
      store.addMessage(ch2, "user", "c");
      const counts = store.pendingCounts();
      expect(counts[channelId]).toBe(2);
      expect(counts[ch2]).toBe(1);
    });
  });
});
