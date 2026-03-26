import { afterEach, describe, expect, it } from "vitest";

describe("config", () => {
  afterEach(() => {
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    delete process.env["COPILOTCLAW_PROFILE"];
  });

  it("getConfigFilePath returns default path without profile", async () => {
    const { getConfigFilePath } = await import("../../src/config.js");
    const path = getConfigFilePath();
    expect(path).toContain("config.json");
    expect(path).not.toContain("config-");
  });

  it("getConfigFilePath returns profile-suffixed path", async () => {
    const { getConfigFilePath } = await import("../../src/config.js");
    const path = getConfigFilePath("staging");
    expect(path).toContain("config-staging.json");
  });

  it("getConfigFilePath reads COPILOTCLAW_PROFILE env var", async () => {
    process.env["COPILOTCLAW_PROFILE"] = "prod";
    const { getConfigFilePath } = await import("../../src/config.js");
    const path = getConfigFilePath();
    expect(path).toContain("config-prod.json");
  });

  it("loadConfig returns empty config when file does not exist", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig("nonexistent-profile-" + Date.now());
    expect(config.upstream).toBeUndefined();
    expect(config.port).toBeUndefined();
  });

  it("env var COPILOTCLAW_UPSTREAM overrides config file", async () => {
    process.env["COPILOTCLAW_UPSTREAM"] = "file:///override";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig("nonexistent-profile-" + Date.now());
    expect(config.upstream).toBe("file:///override");
  });

  it("env var COPILOTCLAW_PORT overrides config file", async () => {
    process.env["COPILOTCLAW_PORT"] = "12345";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig("nonexistent-profile-" + Date.now());
    expect(config.port).toBe(12345);
  });

  it("loadConfig ignores invalid COPILOTCLAW_PORT (NaN)", async () => {
    process.env["COPILOTCLAW_PORT"] = "abc";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig("nonexistent-profile-" + Date.now());
    expect(config.port).toBeUndefined();
  });

  it("loadConfig ignores negative COPILOTCLAW_PORT", async () => {
    process.env["COPILOTCLAW_PORT"] = "-1";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig("nonexistent-profile-" + Date.now());
    expect(config.port).toBeUndefined();
  });

  it("resolvePort returns default when no config or env", async () => {
    const { resolvePort } = await import("../../src/config.js");
    const port = resolvePort("nonexistent-profile-" + Date.now());
    expect(port).toBe(19741);
  });

  it("resolvePort returns env var over config", async () => {
    process.env["COPILOTCLAW_PORT"] = "55555";
    const { resolvePort } = await import("../../src/config.js");
    const port = resolvePort("nonexistent-profile-" + Date.now());
    expect(port).toBe(55555);
  });

  it("resolvePort falls back to default for invalid env var", async () => {
    process.env["COPILOTCLAW_PORT"] = "notanumber";
    const { resolvePort } = await import("../../src/config.js");
    const port = resolvePort("nonexistent-profile-" + Date.now());
    expect(port).toBe(19741);
  });
});
