import { StructuredLogger } from "./structured-logger.js";

const MAX_LOG_ENTRIES = 200;

export interface LogEntry {
  timestamp: string;
  source: "gateway" | "agent";
  level: "info" | "error";
  message: string;
}

/**
 * In-memory ring buffer for gateway/agent logs.
 * Used by the dashboard to display recent operational logs.
 * Optionally writes structured JSON lines to a log file.
 */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly maxEntries: number;
  private structuredLogger: StructuredLogger | undefined;

  constructor(maxEntries = MAX_LOG_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** Enable structured log file output. Must be called before interceptConsole(). */
  enableFileOutput(logFilePath: string): void {
    this.structuredLogger = new StructuredLogger(logFilePath, "gateway");
  }

  add(source: "gateway" | "agent", level: "info" | "error", message: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      source,
      level,
      message,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    // Write to structured log file if enabled, preserving source distinction
    if (this.structuredLogger !== undefined) {
      const data = source !== "gateway" ? { source } : undefined;
      if (level === "error") {
        this.structuredLogger.error(message, data);
      } else {
        this.structuredLogger.info(message, data);
      }
    }
  }

  list(limit = 50): LogEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  /** Install as a console interceptor for gateway logs */
  interceptConsole(): void {
    const origLog = console.log.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
      origLog(...args);
      this.add("gateway", "info", args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      origError(...args);
      this.add("gateway", "error", args.map(String).join(" "));
    };
  }
}
