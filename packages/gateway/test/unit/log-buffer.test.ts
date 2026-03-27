import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LogBuffer } from "../../src/log-buffer.js";
import type { StructuredLogEntry } from "../../src/structured-logger.js";

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

  describe("file output", () => {
    let tempDir: string;

    afterEach(() => {
      if (tempDir !== undefined) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("writes structured JSON lines to log file when file output is enabled", () => {
      tempDir = mkdtempSync(join(tmpdir(), "logbuffer-file-test-"));
      const logPath = join(tempDir, "gateway.log");
      const buf = new LogBuffer();
      buf.enableFileOutput(logPath);

      buf.add("gateway", "info", "started");
      buf.add("gateway", "error", "failed");

      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);

      const entry0 = JSON.parse(lines[0]!) as StructuredLogEntry;
      expect(entry0.level).toBe("info");
      expect(entry0.component).toBe("gateway");
      expect(entry0.msg).toBe("started");

      const entry1 = JSON.parse(lines[1]!) as StructuredLogEntry;
      expect(entry1.level).toBe("error");
      expect(entry1.msg).toBe("failed");
    });

    it("does not write to file when file output is not enabled", () => {
      const buf = new LogBuffer();
      // No enableFileOutput called — should not throw
      expect(() => buf.add("gateway", "info", "test")).not.toThrow();
    });
  });
});
