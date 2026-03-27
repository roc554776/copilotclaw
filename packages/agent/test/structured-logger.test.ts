import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger, type StructuredLogEntry } from "../src/structured-logger.js";

describe("StructuredLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "structured-logger-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes JSON lines to the log file", () => {
    const logPath = join(tempDir, "test.log");
    const logger = new StructuredLogger(logPath, "agent");

    logger.info("session started");
    logger.error("session failed");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const entry0 = JSON.parse(lines[0]!) as StructuredLogEntry;
    expect(entry0.level).toBe("info");
    expect(entry0.component).toBe("agent");
    expect(entry0.msg).toBe("session started");
    expect(entry0.ts).toBeTruthy();

    const entry1 = JSON.parse(lines[1]!) as StructuredLogEntry;
    expect(entry1.level).toBe("error");
    expect(entry1.msg).toBe("session failed");
  });

  it("includes optional data field when provided", () => {
    const logPath = join(tempDir, "test.log");
    const logger = new StructuredLogger(logPath, "agent");

    logger.info("session started", { sessionId: "abc-123", channelId: "ch-1" });

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as StructuredLogEntry;
    expect(entry.data).toEqual({ sessionId: "abc-123", channelId: "ch-1" });
  });

  it("appends to existing file", () => {
    const logPath = join(tempDir, "test.log");
    const logger1 = new StructuredLogger(logPath, "agent");
    logger1.info("first");

    const logger2 = new StructuredLogger(logPath, "agent");
    logger2.info("second");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("creates parent directories if needed", () => {
    const logPath = join(tempDir, "nested", "dir", "test.log");
    const logger = new StructuredLogger(logPath, "agent");

    logger.info("test");

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("test");
  });

  it("does not throw on write failure", () => {
    const logger = new StructuredLogger(tempDir, "agent");
    expect(() => logger.info("should not crash")).not.toThrow();
  });
});
