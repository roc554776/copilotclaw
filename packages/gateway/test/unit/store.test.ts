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

  describe("addInput", () => {
    it("returns a UserInput with id, channelId, message, and createdAt", () => {
      const input = store.addInput(channelId, "hello");
      expect(input).toBeDefined();
      expect(input!.id).toBeTruthy();
      expect(input!.channelId).toBe(channelId);
      expect(input!.message).toBe("hello");
      expect(input!.reply).toBeUndefined();
    });

    it("returns undefined for non-existent channel", () => {
      expect(store.addInput("nonexistent", "hello")).toBeUndefined();
    });

    it("generates unique ids", () => {
      const a = store.addInput(channelId, "a");
      const b = store.addInput(channelId, "b");
      expect(a!.id).not.toBe(b!.id);
    });
  });

  describe("drainInputs", () => {
    it("returns empty array when queue is empty", () => {
      expect(store.drainInputs(channelId)).toEqual([]);
    });

    it("returns all queued inputs at once in FIFO order", () => {
      store.addInput(channelId, "first");
      store.addInput(channelId, "second");
      store.addInput(channelId, "third");

      const drained = store.drainInputs(channelId);
      expect(drained).toHaveLength(3);
      expect(drained[0]?.message).toBe("first");
      expect(drained[1]?.message).toBe("second");
      expect(drained[2]?.message).toBe("third");
    });

    it("drains each input only once", () => {
      store.addInput(channelId, "once");
      store.drainInputs(channelId);
      expect(store.drainInputs(channelId)).toEqual([]);
    });

    it("keeps channels independent", () => {
      const ch2 = store.createChannel().id;
      store.addInput(channelId, "ch1-msg");
      store.addInput(ch2, "ch2-msg");

      const drained1 = store.drainInputs(channelId);
      expect(drained1).toHaveLength(1);
      expect(drained1[0]?.message).toBe("ch1-msg");

      const drained2 = store.drainInputs(ch2);
      expect(drained2).toHaveLength(1);
      expect(drained2[0]?.message).toBe("ch2-msg");
    });
  });

  describe("addReply", () => {
    it("attaches a reply to an existing input", () => {
      const input = store.addInput(channelId, "question");
      const updated = store.addReply(input!.id, "answer");
      expect(updated?.reply?.message).toBe("answer");
      expect(updated?.reply?.createdAt).toBeTruthy();
    });

    it("returns undefined for non-existent input id", () => {
      expect(store.addReply("nonexistent", "reply")).toBeUndefined();
    });
  });

  describe("listInputs", () => {
    it("returns empty array when no inputs for channel", () => {
      expect(store.listInputs(channelId)).toEqual([]);
    });

    it("returns inputs for specific channel sorted by createdAt", () => {
      store.addInput(channelId, "a");
      store.addInput(channelId, "b");
      const all = store.listInputs(channelId);
      expect(all).toHaveLength(2);
      expect(all[0]?.message).toBe("a");
      expect(all[1]?.message).toBe("b");
    });

    it("does not return inputs from other channels", () => {
      const ch2 = store.createChannel().id;
      store.addInput(channelId, "ch1");
      store.addInput(ch2, "ch2");
      expect(store.listInputs(channelId)).toHaveLength(1);
      expect(store.listInputs(ch2)).toHaveLength(1);
    });
  });

  describe("addMessage", () => {
    it("adds a message with sender and returns it", () => {
      const msg = store.addMessage(channelId, "agent", "hello from agent");
      expect(msg).toBeDefined();
      expect(msg!.sender).toBe("agent");
      expect(msg!.message).toBe("hello from agent");
      expect(msg!.channelId).toBe(channelId);
    });

    it("returns undefined for non-existent channel", () => {
      expect(store.addMessage("nonexistent", "agent", "hi")).toBeUndefined();
    });
  });

  describe("listMessages", () => {
    it("returns empty array when no messages", () => {
      expect(store.listMessages(channelId)).toEqual([]);
    });

    it("includes user input messages automatically", () => {
      store.addInput(channelId, "user says hi");
      const msgs = store.listMessages(channelId);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.sender).toBe("user");
      expect(msgs[0]?.message).toBe("user says hi");
    });

    it("includes agent messages", () => {
      store.addMessage(channelId, "agent", "agent reply");
      const msgs = store.listMessages(channelId);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.sender).toBe("agent");
    });

    it("includes reply messages", () => {
      const input = store.addInput(channelId, "question");
      store.addReply(input!.id, "answer");
      const msgs = store.listMessages(channelId);
      expect(msgs).toHaveLength(2);
      // Latest first (reverse chronological)
      expect(msgs[0]?.sender).toBe("agent");
      expect(msgs[1]?.sender).toBe("user");
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
});
