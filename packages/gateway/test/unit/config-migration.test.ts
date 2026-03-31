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

    it("preserves all existing fields during migration from v0", () => {
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
      // v0→v1→v2: auth.* moved to auth.github.*
      expect(config["auth"]).toEqual({ github: { type: "gh-auth", user: "test-user" } });
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
    });

    it("handles empty config (v0)", () => {
      const { config, migrated } = migrateConfig({});
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
    });

    it("migrates v1 auth to auth.github (v1→v2)", () => {
      const { config, migrated } = migrateConfig({
        configVersion: 1,
        auth: { type: "pat", tokenEnv: "MY_TOKEN" },
      });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      expect(config["auth"]).toEqual({ github: { type: "pat", tokenEnv: "MY_TOKEN" } });
    });

    it("migrates v1 without auth (v1→v2, no auth field)", () => {
      const { config, migrated } = migrateConfig({ configVersion: 1, port: 19741 });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      expect(config["auth"]).toBeUndefined();
      expect(config["port"]).toBe(19741);
    });

    it("does not double-wrap already-nested auth.github at v1 (v1→v2)", () => {
      const { config, migrated } = migrateConfig({
        configVersion: 1,
        auth: { github: { type: "gh-auth", user: "already-nested" } },
      });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      // auth.github should NOT be double-wrapped
      expect(config["auth"]).toEqual({ github: { type: "gh-auth", user: "already-nested" } });
    });

    it("migrates v2 to v3 (configVersion bump only)", () => {
      const { config, migrated } = migrateConfig({
        configVersion: 2,
        port: 19741,
        auth: { github: { type: "gh-auth" } },
      });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      expect(config["port"]).toBe(19741);
      expect(config["auth"]).toEqual({ github: { type: "gh-auth" } });
    });

    it("preserves otel config during v2→v3 migration", () => {
      const { config, migrated } = migrateConfig({
        configVersion: 2,
        otel: { endpoints: ["http://localhost:4318"] },
      });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      expect(config["otel"]).toEqual({ endpoints: ["http://localhost:4318"] });
    });

    it("does not migrate when configVersion is above latest (future version)", () => {
      const { config, migrated } = migrateConfig({ configVersion: 99, port: 19741 });
      expect(migrated).toBe(false);
      expect(config["configVersion"]).toBe(99);
      expect(config["port"]).toBe(19741);
    });

    it("migrates cron enabled:false to disabled:true (v4→v5)", () => {
      const { config, migrated } = migrateConfig({
        configVersion: 4,
        cron: [
          { id: "a", channelId: "ch1", intervalMs: 1000, message: "test", enabled: false },
          { id: "b", channelId: "ch2", intervalMs: 2000, message: "test2", enabled: true },
          { id: "c", channelId: "ch3", intervalMs: 3000, message: "test3" },
        ],
      });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      const cron = config["cron"] as Array<Record<string, unknown>>;
      // enabled:false → disabled:true
      expect(cron[0]!["disabled"]).toBe(true);
      expect(cron[0]!["enabled"]).toBeUndefined();
      // enabled:true → no disabled field
      expect(cron[1]!["disabled"]).toBeUndefined();
      expect(cron[1]!["enabled"]).toBeUndefined();
      // no enabled → no disabled field
      expect(cron[2]!["disabled"]).toBeUndefined();
      expect(cron[2]!["enabled"]).toBeUndefined();
    });

    it("migrates v4→v5 without cron field", () => {
      const { config, migrated } = migrateConfig({ configVersion: 4, port: 19741 });
      expect(migrated).toBe(true);
      expect(config["configVersion"]).toBe(LATEST_CONFIG_VERSION);
      expect(config["cron"]).toBeUndefined();
    });
  });

  describe("loadConfig migration write-back", () => {
    it("writes back migrated config to disk on load", () => {
      const profile = `migration-wb-${Date.now()}`;
      // Ensure directory exists, then write a v0 config directly (no configVersion)
      ensureConfigFile(profile);
      const filePath = getConfigFilePath(profile);
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
