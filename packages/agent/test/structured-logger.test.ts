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

  it("does not throw on write failure", () => {
    const logger = new StructuredLogger(tempDir, "agent");
    expect(() => logger.info("should not crash")).not.toThrow();
  });
});
