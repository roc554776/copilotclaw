import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StructuredLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  component: string;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Interface for an OpenTelemetry logger bridge.
 * Matches the subset of @opentelemetry/api-logs Logger used here,
 * so consumers can pass in the real OTel logger without this module
 * depending on @opentelemetry/api-logs directly.
 */
export interface OtelLoggerBridge {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  emit(record: Record<string, any>): void;
}

/** OTel SeverityNumber constants (avoid importing @opentelemetry/api-logs here). */
const SEVERITY_INFO = 9;
const SEVERITY_WARN = 13;
const SEVERITY_ERROR = 17;

/**
 * Minimal structured logger that writes JSON lines to a file.
 * Each log entry is a single JSON object on one line.
 * Optionally bridges to an OpenTelemetry logger for OTel signal export.
 *
 * NOTE: This class is intentionally duplicated in @copilotclaw/agent
 * (packages/agent/src/structured-logger.ts) to keep the two process
 * packages fully self-contained without a shared dependency. If you
 * change this file, apply the same change to the agent copy.
 */
export class StructuredLogger {
  private readonly filePath: string;
  private readonly component: string;
  private readonly otelLogger: OtelLoggerBridge | undefined;

  constructor(filePath: string, component: string, otelLogger?: OtelLoggerBridge) {
    this.filePath = filePath;
    this.component = component;
    this.otelLogger = otelLogger;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // Directory creation failure must not crash the process
    }
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", msg, data);
  }

  private write(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
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

    // Bridge to OTel if configured
    if (this.otelLogger !== undefined) {
      try {
        this.otelLogger.emit({
          severityNumber: level === "error" ? SEVERITY_ERROR : level === "warn" ? SEVERITY_WARN : SEVERITY_INFO,
          severityText: level.toUpperCase(),
          body: msg,
          attributes: data !== undefined ? { component: this.component, ...data } : { component: this.component },
        });
      } catch {
        // OTel emission failure must not crash the process
      }
    }
  }
}
