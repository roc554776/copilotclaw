import { afterEach, describe, expect, it } from "vitest";
import { initOtel, shutdownOtel } from "../../src/otel.js";
import { initMetrics, updateSessionCounts, recordTokens, resetMetrics } from "../../src/otel-metrics.js";

describe("otel-metrics", () => {
  afterEach(async () => {
    resetMetrics();
    await shutdownOtel();
  });

  it("initMetrics does not throw after initOtel", () => {
    initOtel({ endpoints: [] });
    expect(() => initMetrics()).not.toThrow();
  });

  it("initMetrics is idempotent (no callback accumulation)", () => {
    initOtel({ endpoints: [] });
    expect(() => {
      initMetrics();
      initMetrics();
    }).not.toThrow();
  });

  it("updateSessionCounts does not throw", () => {
    initOtel({ endpoints: [] });
    initMetrics();
    expect(() => updateSessionCounts(5, 3)).not.toThrow();
  });

  it("recordTokens does not throw", () => {
    initOtel({ endpoints: [] });
    initMetrics();
    expect(() => recordTokens(100, 50)).not.toThrow();
  });

  it("recordTokens is safe before initMetrics (counters undefined)", () => {
    expect(() => recordTokens(100, 50)).not.toThrow();
  });

  it("resetMetrics allows re-initialization", async () => {
    initOtel({ endpoints: [] });
    initMetrics();
    resetMetrics();
    await shutdownOtel();
    initOtel({ endpoints: [] });
    expect(() => initMetrics()).not.toThrow();
  });
});
