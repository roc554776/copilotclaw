import { afterEach, describe, expect, it } from "vitest";
import { initOtel, getLogger, getMeter, shutdownOtel } from "../../src/otel.js";

describe("otel", () => {
  afterEach(async () => {
    await shutdownOtel();
  });

  it("initializes without endpoints (no-op mode)", () => {
    expect(() => initOtel({ endpoints: [] })).not.toThrow();
  });

  it("getLogger returns a logger after initialization", () => {
    initOtel({ endpoints: [] });
    const logger = getLogger("test-component");
    expect(logger).toBeDefined();
    expect(typeof logger.emit).toBe("function");
  });

  it("getMeter returns a meter after initialization", () => {
    initOtel({ endpoints: [] });
    const meter = getMeter("test-component");
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe("function");
    expect(typeof meter.createObservableGauge).toBe("function");
  });

  it("shutdownOtel completes without error", async () => {
    initOtel({ endpoints: [] });
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });

  it("handles double initialization gracefully", () => {
    initOtel({ endpoints: [] });
    expect(() => initOtel({ endpoints: [] })).not.toThrow();
  });

  it("initializes with endpoints (exporters configured)", () => {
    // This won't actually connect but should not throw
    expect(() => initOtel({ endpoints: ["http://localhost:4318"] })).not.toThrow();
  });

  it("handles shutdown without prior initialization", async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });

  it("can re-initialize after shutdown", async () => {
    initOtel({ endpoints: [] });
    await shutdownOtel();
    expect(() => initOtel({ endpoints: [] })).not.toThrow();
    const logger = getLogger("reinitialized");
    expect(logger).toBeDefined();
  });
});
