import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StructuredLogEntry {
  ts: string;
  level: "info" | "error";
  component: string;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Minimal structured logger that writes JSON lines to a file.
 * Each log entry is a single JSON object on one line.
 * Designed for future OpenTelemetry log bridge compatibility.
 *
 * NOTE: This class is intentionally duplicated in @copilotclaw/agent
 * (packages/agent/src/structured-logger.ts) to keep the two process
 * packages fully self-contained without a shared dependency. If you
 * change this file, apply the same change to the agent copy.
 */
export class StructuredLogger {
  private readonly filePath: string;
  private readonly component: string;

  constructor(filePath: string, component: string) {
    this.filePath = filePath;
    this.component = component;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // Directory creation failure must not crash the process
    }
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", msg, data);
  }

  private write(level: "info" | "error", msg: string, data?: Record<string, unknown>): void {
    const entry: StructuredLogEntry = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...(data !== undefined ? { data } : {}),
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Logging failure must not crash the process
    }
  }
}
