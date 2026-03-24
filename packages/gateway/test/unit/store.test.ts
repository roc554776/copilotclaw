import { describe, expect, it, beforeEach } from "vitest";
import { Store } from "../../src/store.js";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  describe("addInput", () => {
    it("returns a UserInput with id, message, and createdAt", () => {
      const input = store.addInput("hello");
      expect(input.id).toBeTruthy();
      expect(input.message).toBe("hello");
      expect(input.createdAt).toBeTruthy();
      expect(input.reply).toBeUndefined();
    });

    it("generates unique ids", () => {
      const a = store.addInput("a");
      const b = store.addInput("b");
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("findNextInput", () => {
    it("returns undefined when queue is empty", () => {
      expect(store.findNextInput()).toBeUndefined();
    });

    it("returns inputs in FIFO order", () => {
      store.addInput("first");
      store.addInput("second");
      store.addInput("third");

      expect(store.findNextInput()?.message).toBe("first");
      expect(store.findNextInput()?.message).toBe("second");
      expect(store.findNextInput()?.message).toBe("third");
      expect(store.findNextInput()).toBeUndefined();
    });

    it("dequeues each input only once", () => {
      store.addInput("once");
      store.findNextInput();
      expect(store.findNextInput()).toBeUndefined();
    });
  });

  describe("addReply", () => {
    it("attaches a reply to an existing input", () => {
      const input = store.addInput("question");
      const updated = store.addReply(input.id, "answer");
      expect(updated?.reply?.message).toBe("answer");
      expect(updated?.reply?.createdAt).toBeTruthy();
    });

    it("returns undefined for non-existent input id", () => {
      expect(store.addReply("nonexistent", "reply")).toBeUndefined();
    });
  });

  describe("listAll", () => {
    it("returns empty array when no inputs", () => {
      expect(store.listAll()).toEqual([]);
    });

    it("returns all inputs sorted by createdAt", () => {
      store.addInput("a");
      store.addInput("b");
      const all = store.listAll();
      expect(all).toHaveLength(2);
      expect(all[0]?.message).toBe("a");
      expect(all[1]?.message).toBe("b");
    });

    it("includes replies when present", () => {
      const input = store.addInput("q");
      store.addReply(input.id, "a");
      const all = store.listAll();
      expect(all[0]?.reply?.message).toBe("a");
    });
  });
});
