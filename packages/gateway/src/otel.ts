/**
 * OpenTelemetry setup module.
 *
 * Initializes OTel SDK with OTLP exporters for logs and metrics.
 * When no endpoints are configured, OTel export is disabled but the API
 * remains available for internal structured logging.
 *
 * NOTE: This module is only used by the gateway package. The agent package
 * receives OTel configuration from the gateway via /api/status and initializes
 * its own OTel setup independently.
 */

import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { metrics } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

import type { Logger as OtelLoggerApi } from "@opentelemetry/api-logs";
import type { Meter } from "@opentelemetry/api";

let loggerProvider: LoggerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let initialized = false;

/**
 * Initialize OpenTelemetry with OTLP exporters.
 * Call once at startup. If endpoints is empty, no exporters are registered
 * but the API is still usable (noop exporters).
 */
export function initOtel(options: {
  endpoints: string[];
  serviceName?: string;
  serviceVersion?: string;
}): void {
  if (initialized) return;
  initialized = true;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: options.serviceName ?? "copilotclaw",
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "unknown",
  });

  // Logger provider
  loggerProvider = new LoggerProvider({ resource });

  for (const endpoint of options.endpoints) {
    const logExporter = new OTLPLogExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/logs`,
    });
    loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
  }

  logs.setGlobalLoggerProvider(loggerProvider);

  // Meter provider
  const metricReaders = options.endpoints.map((endpoint) => {
    const metricExporter = new OTLPMetricExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/metrics`,
    });
    return new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 30_000,
    });
  });

  const meterOpts: { resource: Resource; readers?: PeriodicExportingMetricReader[] } = { resource };
  if (metricReaders.length > 0) {
    meterOpts.readers = metricReaders;
  }
  meterProvider = new MeterProvider(meterOpts);

  metrics.setGlobalMeterProvider(meterProvider);
}

/** Get an OTel logger for a specific component. */
export function getLogger(component: string): OtelLoggerApi {
  return logs.getLoggerProvider().getLogger(component);
}

/** Get an OTel meter for a specific component. */
export function getMeter(component: string): Meter {
  return metrics.getMeterProvider().getMeter(component);
}

/** Map structured log levels to OTel SeverityNumber. */
export function severityFromLevel(level: "info" | "warn" | "error"): SeverityNumber {
  if (level === "error") return SeverityNumber.ERROR;
  if (level === "warn") return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}

/** Graceful shutdown of OTel providers. */
export async function shutdownOtel(): Promise<void> {
  const promises: Promise<void>[] = [];
  if (loggerProvider !== undefined) {
    promises.push(loggerProvider.shutdown());
  }
  if (meterProvider !== undefined) {
    promises.push(meterProvider.shutdown());
  }
  await Promise.allSettled(promises);
  initialized = false;
  loggerProvider = undefined;
  meterProvider = undefined;
}
