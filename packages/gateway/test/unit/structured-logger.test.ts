import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger, type StructuredLogEntry } from "../../src/structured-logger.js";

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
    const logger = new StructuredLogger(logPath, "gateway");

    logger.info("server started");
    logger.error("connection failed");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const entry0 = JSON.parse(lines[0]!) as StructuredLogEntry;
    expect(entry0.level).toBe("info");
    expect(entry0.component).toBe("gateway");
    expect(entry0.msg).toBe("server started");
    expect(entry0.ts).toBeTruthy();
    expect(entry0.data).toBeUndefined();

    const entry1 = JSON.parse(lines[1]!) as StructuredLogEntry;
    expect(entry1.level).toBe("error");
    expect(entry1.msg).toBe("connection failed");
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
    const logger1 = new StructuredLogger(logPath, "gateway");
    logger1.info("first");

    const logger2 = new StructuredLogger(logPath, "gateway");
    logger2.info("second");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("creates parent directories if needed", () => {
    const logPath = join(tempDir, "nested", "dir", "test.log");
    const logger = new StructuredLogger(logPath, "gateway");

    logger.info("test");

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("test");
  });

  it("does not throw on write failure", () => {
    // Use a directory path as log file — appendFileSync will fail
    const logger = new StructuredLogger(tempDir, "gateway");
    expect(() => logger.info("should not crash")).not.toThrow();
  });

  it("emits to OTel logger bridge when provided", () => {
    const logPath = join(tempDir, "otel-test.log");
    const emitted: Array<Record<string, unknown>> = [];
    const mockOtelLogger = {
      emit(record: Record<string, unknown>) {
        emitted.push(record);
      },
    };

    const logger = new StructuredLogger(logPath, "gateway", mockOtelLogger);
    logger.info("test info message", { key: "value" });
    logger.error("test error message");

    // Verify file output still works
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    // Verify OTel bridge received the log records
    expect(emitted).toHaveLength(2);

    expect(emitted[0]!.severityNumber).toBe(9); // INFO
    expect(emitted[0]!.severityText).toBe("INFO");
    expect(emitted[0]!.body).toBe("test info message");
    expect(emitted[0]!.attributes).toEqual({ component: "gateway", key: "value" });

    expect(emitted[1]!.severityNumber).toBe(17); // ERROR
    expect(emitted[1]!.severityText).toBe("ERROR");
    expect(emitted[1]!.body).toBe("test error message");
    expect(emitted[1]!.attributes).toEqual({ component: "gateway" });
  });

  it("does not crash when OTel bridge throws", () => {
    const logPath = join(tempDir, "otel-error-test.log");
    const failingBridge = {
      emit() {
        throw new Error("OTel export failed");
      },
    };

    const logger = new StructuredLogger(logPath, "gateway", failingBridge);
    expect(() => logger.info("should not crash")).not.toThrow();

    // File output should still work despite OTel failure
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("should not crash");
  });

  it("works without OTel logger (backward compatibility)", () => {
    const logPath = join(tempDir, "no-otel.log");
    const logger = new StructuredLogger(logPath, "gateway");
    logger.info("no otel");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as StructuredLogEntry;
    expect(entry.msg).toBe("no otel");
  });
});
