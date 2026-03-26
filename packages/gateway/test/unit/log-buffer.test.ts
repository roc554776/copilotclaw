import { describe, expect, it } from "vitest";
import { LogBuffer } from "../../src/log-buffer.js";

describe("LogBuffer", () => {
  it("adds and lists entries in reverse chronological order", () => {
    const buf = new LogBuffer();
    buf.add("gateway", "info", "first");
    buf.add("gateway", "error", "second");
    const entries = buf.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toBe("second");
    expect(entries[1]!.message).toBe("first");
  });

  it("respects max entries limit", () => {
    const buf = new LogBuffer(3);
    buf.add("gateway", "info", "a");
    buf.add("gateway", "info", "b");
    buf.add("gateway", "info", "c");
    buf.add("gateway", "info", "d");
    const entries = buf.list(10);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.message).toBe("d");
    expect(entries[2]!.message).toBe("b");
  });

  it("respects list limit parameter", () => {
    const buf = new LogBuffer();
    buf.add("gateway", "info", "a");
    buf.add("gateway", "info", "b");
    buf.add("gateway", "info", "c");
    const entries = buf.list(2);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toBe("c");
  });

  it("includes timestamp, source, and level", () => {
    const buf = new LogBuffer();
    buf.add("agent", "error", "something broke");
    const entry = buf.list(1)[0]!;
    expect(entry.timestamp).toBeTruthy();
    expect(entry.source).toBe("agent");
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("something broke");
  });
});
