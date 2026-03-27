import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_CONFIG_VERSION, ensureConfigFile, getConfigFilePath, loadConfig, migrateConfig, saveConfig } from "../../src/config.js";

describe("config migration", () => {
  afterEach(() => {
    delete process.env["COPILOTCLAW_PROFILE"];
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    delete process.env["COPILOTCLAW_MODEL"];
    delete process.env["COPILOTCLAW_ZERO_PREMIUM"];
    delete process.env["COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS"];
  });

  describe("migrateConfig", () => {
    it("migrates v0 (no configVersion) to latest", () => {
      const { config, migrated } = migrateConfig({ port: 19741 });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      expect(config["port"]).toBe(19741);
    });

    it("does not migrate when already at latest version", () => {
      const { config, migrated } = migrateConfig({ configVersion: LATEST_CONFIG_VERSION, port: 19741 });
      expect(migrated).toBe(false);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
    });

    it("preserves all existing fields during migration", () => {
      const original = {
        port: 12345,
        upstream: "https://example.com",
        model: "gpt-4.1",
        zeroPremium: true,
        debugMockCopilotUnsafeTools: false,
        auth: { type: "gh-auth", user: "test-user" },
      };
      const { config } = migrateConfig(original);
      expect(config["port"]).toBe(12345);
      expect(config["upstream"]).toBe("https://example.com");
      expect(config["model"]).toBe("gpt-4.1");
      expect(config["zeroPremium"]).toBe(true);
      expect(config["auth"]).toEqual({ type: "gh-auth", user: "test-user" });
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
    });

    it("handles empty config (v0)", () => {
      const { config, migrated } = migrateConfig({});
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
    });
  });

  describe("loadConfig migration write-back", () => {
    it("writes back migrated config to disk on load", () => {
      const profile = `migration-wb-${Date.now()}`;
      // Create a v0 config (no configVersion) via direct file write
      saveConfig({ port: 19741 }, profile);
      const filePath = getConfigFilePath(profile);
      // Overwrite with v0 format (no configVersion)
      writeFileSync(filePath, JSON.stringify({ port: 19741 }), "utf-8");

      // Load — should trigger migration and write back
      const config = loadConfig(profile);
      expect(config.port).toBe(19741);

      // Verify the file on disk now has configVersion
      const onDisk = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      expect(onDisk["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      expect(onDisk["port"]).toBe(19741);
    });
  });

  describe("saveConfig stamps configVersion", () => {
    it("always includes latest configVersion", () => {
      const profile = `save-cv-${Date.now()}`;
      saveConfig({ port: 12345 }, profile);

      const filePath = getConfigFilePath(profile);
      const onDisk = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      expect(onDisk["configVersion"]).toBe(LATEST_CONFIG_VERSION);
    });
  });

  describe("ensureConfigFile stamps configVersion", () => {
    it("creates config with configVersion", () => {
      const profile = `ensure-cv-${Date.now()}`;
      ensureConfigFile(profile);

      const filePath = getConfigFilePath(profile);
      const onDisk = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      expect(onDisk["configVersion"]).toBe(LATEST_CONFIG_VERSION);
    });
  });
});
