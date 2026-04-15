import { describe, expect, it, beforeEach, vi } from "vitest";
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

    it("uses default limit of 5 when not specified", () => {
      for (let i = 0; i < 10; i++) {
        store.addMessage(channelId, "user", `msg-${i}`);
      }
      const msgs = store.listMessages(channelId);
      expect(msgs).toHaveLength(5);
    });

    it("falls back to 5 for invalid limit values", () => {
      for (let i = 0; i < 10; i++) {
        store.addMessage(channelId, "user", `msg-${i}`);
      }
      expect(store.listMessages(channelId, NaN)).toHaveLength(5);
      expect(store.listMessages(channelId, 0)).toHaveLength(5);
      expect(store.listMessages(channelId, -1)).toHaveLength(5);
    });

    it("returns messages before a given cursor message ID", () => {
      store.addMessage(channelId, "user", "msg-1");
      store.addMessage(channelId, "user", "msg-2");
      const pivot = store.addMessage(channelId, "user", "msg-3")!;
      store.addMessage(channelId, "user", "msg-4");
      store.addMessage(channelId, "user", "msg-5");

      const msgs = store.listMessages(channelId, 10, pivot.id);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]?.message).toBe("msg-2");
      expect(msgs[1]?.message).toBe("msg-1");
    });

    it("returns empty when before cursor has no older messages", () => {
      const first = store.addMessage(channelId, "user", "msg-1")!;
      store.addMessage(channelId, "user", "msg-2");

      const msgs = store.listMessages(channelId, 10, first.id);
      expect(msgs).toHaveLength(0);
    });

    it("respects limit with before cursor", () => {
      for (let i = 0; i < 10; i++) {
        store.addMessage(channelId, "user", `msg-${i}`);
      }
      const allMsgs = store.listMessages(channelId, 10);
      // allMsgs[4] is the 5th newest — 5 messages are older
      const pivotId = allMsgs[4]!.id;
      const msgs = store.listMessages(channelId, 3, pivotId);
      expect(msgs).toHaveLength(3);
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

  describe("channel archiving", () => {
    it("archiveChannel sets archivedAt", () => {
      const ok = store.archiveChannel(channelId);
      expect(ok).toBe(true);
      const ch = store.getChannel(channelId);
      expect(ch?.archivedAt).toBeTruthy();
    });

    it("archiveChannel returns false for already archived channel", () => {
      store.archiveChannel(channelId);
      const ok = store.archiveChannel(channelId);
      expect(ok).toBe(false);
    });

    it("archiveChannel returns false for nonexistent channel", () => {
      const ok = store.archiveChannel("nonexistent");
      expect(ok).toBe(false);
    });

    it("unarchiveChannel clears archivedAt", () => {
      store.archiveChannel(channelId);
      const ok = store.unarchiveChannel(channelId);
      expect(ok).toBe(true);
      const ch = store.getChannel(channelId);
      expect(ch?.archivedAt).toBeNull();
    });

    it("unarchiveChannel returns false for non-archived channel", () => {
      const ok = store.unarchiveChannel(channelId);
      expect(ok).toBe(false);
    });

    it("listChannels excludes archived by default", () => {
      const ch2 = store.createChannel().id;
      store.archiveChannel(channelId);
      const list = store.listChannels();
      expect(list.map((c) => c.id)).toEqual([ch2]);
    });

    it("listChannels with includeArchived returns all", () => {
      const ch2 = store.createChannel().id;
      store.archiveChannel(channelId);
      const list = store.listChannels({ includeArchived: true });
      expect(list.map((c) => c.id)).toEqual([channelId, ch2]);
    });

    it("archived channels still accessible via getChannel", () => {
      store.archiveChannel(channelId);
      const ch = store.getChannel(channelId);
      expect(ch).toBeDefined();
      expect(ch?.id).toBe(channelId);
    });

    it("system messages added to pending queue", () => {
      store.addMessage(channelId, "system", "[SUBAGENT COMPLETED] worker completed");
      const pending = store.drainPending(channelId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.sender).toBe("system");
      expect(pending[0]!.message).toContain("SUBAGENT COMPLETED");
    });

    it("messages on archived channels are preserved", () => {
      store.addMessage(channelId, "user", "hello");
      store.archiveChannel(channelId);
      const msgs = store.listMessages(channelId);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.message).toBe("hello");
    });
  });

  describe("cron messages", () => {
    it("adds cron messages to pending queue", () => {
      store.addMessage(channelId, "cron", "[cron:test] do something");
      const pending = store.drainPending(channelId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.sender).toBe("cron");
      expect(pending[0]!.message).toBe("[cron:test] do something");
    });

    it("hasPendingCronMessage detects pending cron message by prefix", () => {
      store.addMessage(channelId, "cron", "[cron:daily] report");
      expect(store.hasPendingCronMessage(channelId, "[cron:daily]")).toBe(true);
      expect(store.hasPendingCronMessage(channelId, "[cron:other]")).toBe(false);
    });

    it("hasPendingCronMessage returns false after drain", () => {
      store.addMessage(channelId, "cron", "[cron:daily] report");
      store.drainPending(channelId);
      expect(store.hasPendingCronMessage(channelId, "[cron:daily]")).toBe(false);
    });

    it("does not add agent messages to pending queue", () => {
      store.addMessage(channelId, "agent", "reply");
      expect(store.hasPending(channelId)).toBe(false);
    });

    it("hasPendingCronMessage is not confused by system messages coexisting with cron", () => {
      store.addMessage(channelId, "system", "[SUBAGENT COMPLETED] worker completed");
      // System message is pending, but cron dedup should NOT match it
      expect(store.hasPendingCronMessage(channelId, "[cron:daily]")).toBe(false);

      // Now add an actual cron message — dedup should detect it
      store.addMessage(channelId, "cron", "[cron:daily] report");
      expect(store.hasPendingCronMessage(channelId, "[cron:daily]")).toBe(true);

      // Drain and verify both were pending
      const drained = store.drainPending(channelId);
      expect(drained).toHaveLength(2);
      expect(drained.map((m) => m.sender).sort()).toEqual(["cron", "system"]);
    });
  });

  describe("channel model setting", () => {
    it("new channel has no model set by default", () => {
      const ch = store.createChannel();
      // createChannel returns the in-memory object, getChannel returns from DB
      const fromDb = store.getChannel(ch.id);
      expect(fromDb?.model).toBeNull();
    });

    it("updateChannelModel sets and gets model", () => {
      const ok = store.updateChannelModel(channelId, "gpt-4.1");
      expect(ok).toBe(true);
      const ch = store.getChannel(channelId);
      expect(ch?.model).toBe("gpt-4.1");
    });

    it("updateChannelModel clears model with null", () => {
      store.updateChannelModel(channelId, "gpt-4.1");
      store.updateChannelModel(channelId, null);
      const ch = store.getChannel(channelId);
      expect(ch?.model).toBeNull();
    });

    it("updateChannelModel returns false for nonexistent channel", () => {
      const ok = store.updateChannelModel("nonexistent", "gpt-4.1");
      expect(ok).toBe(false);
    });

    it("listChannels includes model field", () => {
      store.updateChannelModel(channelId, "gpt-4.1");
      const channels = store.listChannels();
      const ch = channels.find((c) => c.id === channelId);
      expect(ch?.model).toBe("gpt-4.1");
    });
  });

  describe("draft save", () => {
    it("saves and retrieves draft", () => {
      store.saveDraft(channelId, "hello draft");
      const ch = store.getChannel(channelId);
      expect(ch?.draft).toBe("hello draft");
    });

    it("clears draft with null", () => {
      store.saveDraft(channelId, "some text");
      store.saveDraft(channelId, null);
      const ch = store.getChannel(channelId);
      expect(ch?.draft).toBeNull();
    });

    it("clears draft with empty string", () => {
      store.saveDraft(channelId, "some text");
      store.saveDraft(channelId, "");
      const ch = store.getChannel(channelId);
      expect(ch?.draft).toBeNull();
    });

    it("returns false for nonexistent channel", () => {
      expect(store.saveDraft("nonexistent", "text")).toBe(false);
    });

    it("draft is included in listChannels", () => {
      store.saveDraft(channelId, "my draft");
      const channels = store.listChannels();
      const ch = channels.find((c) => c.id === channelId);
      expect(ch?.draft).toBe("my draft");
    });
  });

  describe("channel list change hook", () => {
    it("calls callback when createChannel succeeds", () => {
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      store.createChannel();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("calls callback when archiveChannel succeeds", () => {
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      const result = store.archiveChannel(channelId);
      expect(result).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does NOT call callback when archiveChannel fails (non-existent id)", () => {
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      const result = store.archiveChannel("nonexistent-id");
      expect(result).toBe(false);
      expect(cb).not.toHaveBeenCalled();
    });

    it("calls callback when unarchiveChannel succeeds", () => {
      const cb = vi.fn();
      store.archiveChannel(channelId); // first archive
      store.setOnChannelListChange(cb);
      const result = store.unarchiveChannel(channelId);
      expect(result).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does NOT call callback when unarchiveChannel fails (not archived)", () => {
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      // channelId is not archived, so unarchive should fail
      const result = store.unarchiveChannel(channelId);
      expect(result).toBe(false);
      expect(cb).not.toHaveBeenCalled();
    });

    it("calls callback when updateChannelModel succeeds", () => {
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      const result = store.updateChannelModel(channelId, "claude-3-5-sonnet");
      expect(result).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does NOT call callback when updateChannelModel fails (non-existent id)", () => {
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      const result = store.updateChannelModel("nonexistent-id", "claude-3-5-sonnet");
      expect(result).toBe(false);
      expect(cb).not.toHaveBeenCalled();
    });

    it("does NOT call callback when saveDraft is called (draft does not affect channel list)", () => {
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      store.saveDraft(channelId, "draft text");
      expect(cb).not.toHaveBeenCalled();
    });

    it("throws in callback does not propagate to createChannel caller", () => {
      store.setOnChannelListChange(() => { throw new Error("callback boom"); });
      let result: ReturnType<typeof store.createChannel> | undefined;
      expect(() => { result = store.createChannel(); }).not.toThrow();
      expect(result).toBeDefined();
      expect(result!.id).toBeTruthy();
    });

    it("throws in callback does not propagate to archiveChannel caller", () => {
      store.setOnChannelListChange(() => { throw new Error("callback boom"); });
      expect(() => { store.archiveChannel(channelId); }).not.toThrow();
    });

    it("throws in callback does not propagate to unarchiveChannel caller", () => {
      store.archiveChannel(channelId);
      store.setOnChannelListChange(() => { throw new Error("callback boom"); });
      expect(() => { store.unarchiveChannel(channelId); }).not.toThrow();
    });

    it("throws in callback does not propagate to updateChannelModel caller", () => {
      store.setOnChannelListChange(() => { throw new Error("callback boom"); });
      expect(() => { store.updateChannelModel(channelId, "gpt-4.1"); }).not.toThrow();
    });

    it("does NOT call callback on second archiveChannel when already archived", () => {
      const ch = store.createChannel();
      const cb = vi.fn();
      store.setOnChannelListChange(cb);
      store.archiveChannel(ch.id); // succeeds → cb count = 1
      expect(cb).toHaveBeenCalledTimes(1);
      store.archiveChannel(ch.id); // no-op (already archived) → cb count unchanged
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});
