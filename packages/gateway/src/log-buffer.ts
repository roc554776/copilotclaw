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
 */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_LOG_ENTRIES) {
    this.maxEntries = maxEntries;
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
