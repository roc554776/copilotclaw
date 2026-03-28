/**
 * OpenTelemetry setup module for the agent process.
 *
 * NOTE: This module is intentionally duplicated from @copilotclaw/gateway
 * (packages/gateway/src/otel.ts) to keep the two process packages fully
 * self-contained without a shared dependency. If you change this file,
 * apply the same change to the gateway copy.
 */

import { logs } from "@opentelemetry/api-logs";
import { metrics } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

import type { Logger as OtelLoggerApi } from "@opentelemetry/api-logs";

let loggerProvider: LoggerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let initialized = false;

/**
 * Initialize OpenTelemetry with OTLP exporters.
 * Call once at startup. If endpoints is empty, no exporters are registered.
 */
export function initOtel(options: {
  endpoints: string[];
  serviceName?: string;
  serviceVersion?: string;
}): void {
  if (initialized) return;
  initialized = true;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: options.serviceName ?? "copilotclaw-agent",
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "unknown",
  });

  loggerProvider = new LoggerProvider({ resource });

  for (const endpoint of options.endpoints) {
    const logExporter = new OTLPLogExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/logs`,
    });
    loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));
  }

  logs.setGlobalLoggerProvider(loggerProvider);

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
