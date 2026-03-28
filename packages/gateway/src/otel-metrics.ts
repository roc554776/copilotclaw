/**
 * Application-level OTel metrics for copilotclaw.
 *
 * Provides gauges for session counts and counters for token usage.
 * All metrics use the "copilotclaw." namespace prefix.
 */

import { getMeter } from "./otel.js";

import type { Counter, ObservableGauge } from "@opentelemetry/api";

let sessionsActiveGauge: ObservableGauge | undefined;
let sessionsSuspendedGauge: ObservableGauge | undefined;
let tokensInputCounter: Counter | undefined;
let tokensOutputCounter: Counter | undefined;

/** Current values for observable gauges (set externally). */
let activeSessionCount = 0;
let suspendedSessionCount = 0;

/** Initialize metrics instruments. Call once after initOtel(). */
export function initMetrics(): void {
  const meter = getMeter("copilotclaw");

  sessionsActiveGauge = meter.createObservableGauge("copilotclaw.sessions.active", {
    description: "Count of active sessions",
  });
  sessionsActiveGauge.addCallback((result) => {
    result.observe(activeSessionCount);
  });

  sessionsSuspendedGauge = meter.createObservableGauge("copilotclaw.sessions.suspended", {
    description: "Count of suspended sessions",
  });
  sessionsSuspendedGauge.addCallback((result) => {
    result.observe(suspendedSessionCount);
  });

  tokensInputCounter = meter.createCounter("copilotclaw.tokens.input", {
    description: "Total input tokens",
  });

  tokensOutputCounter = meter.createCounter("copilotclaw.tokens.output", {
    description: "Total output tokens",
  });
}

/** Update session count gauges. */
export function updateSessionCounts(active: number, suspended: number): void {
  activeSessionCount = active;
  suspendedSessionCount = suspended;
}

/** Record token usage. */
export function recordTokens(input: number, output: number): void {
  tokensInputCounter?.add(input);
  tokensOutputCounter?.add(output);
}
