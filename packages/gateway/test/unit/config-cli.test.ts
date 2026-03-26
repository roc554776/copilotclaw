import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We test configGet and configSet by mocking the config module's file path.
// Since config.ts uses homedir() for BASE_DIR, we mock the relevant functions
// and test the exported configGet/configSet functions directly.

// Instead of mocking the module, we test the logic by calling the exported
// functions from config-cli.ts and verifying the results via config.ts functions.

import { configGet, configSet } from "../../src/config-cli.js";
import { loadConfig, loadFileConfig, saveConfig } from "../../src/config.js";

describe("config CLI", () => {
  const testDir = join(tmpdir(), `copilotclaw-config-cli-test-${Date.now()}`);
  const testProfile = `test-cli-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    // Use a unique profile to isolate test config files
    process.env["COPILOTCLAW_PROFILE"] = testProfile;
  });

  afterEach(() => {
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    delete process.env["COPILOTCLAW_PROFILE"];
  });

  describe("configSet", () => {
    it("sets upstream value in config file", () => {
      // First create the config file
      saveConfig({});
      configSet("upstream", "file:///test/repo");
      const config = loadFileConfig();
      expect(config.upstream).toBe("file:///test/repo");
    });

    it("sets port value as number in config file", () => {
      saveConfig({});
      configSet("port", "12345");
      const config = loadFileConfig();
      expect(config.port).toBe(12345);
    });

    it("preserves existing values when setting a new key", () => {
      saveConfig({ upstream: "file:///existing" });
      configSet("port", "9999");
      const config = loadFileConfig();
      expect(config.upstream).toBe("file:///existing");
      expect(config.port).toBe(9999);
    });

    it("exits with error for unknown key", () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      try {
        configSet("unknown", "value");
      } catch {
        // expected
      }
      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });

    it("exits with error for invalid port value", () => {
      saveConfig({});
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      try {
        configSet("port", "abc");
      } catch {
        // expected
      }
      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });

  describe("configGet", () => {
    it("prints value to stdout", () => {
      saveConfig({ upstream: "file:///my/repo" });
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      configGet("upstream");
      expect(spy).toHaveBeenCalledWith("file:///my/repo");
      spy.mockRestore();
    });

    it("prints port value", () => {
      saveConfig({ port: 12345 });
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      configGet("port");
      expect(spy).toHaveBeenCalledWith("12345");
      spy.mockRestore();
    });

    it("shows env var override warning when env is set", () => {
      saveConfig({ upstream: "file:///config" });
      process.env["COPILOTCLAW_UPSTREAM"] = "file:///env";
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      configGet("upstream");
      expect(logSpy).toHaveBeenCalledWith("file:///env");
      const overrideMsg = errSpy.mock.calls.find((c) => String(c[0]).includes("overridden"));
      expect(overrideMsg).toBeTruthy();
      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("shows (not set) for missing value", () => {
      saveConfig({});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      configGet("upstream");
      const notSetMsg = errSpy.mock.calls.find((c) => String(c[0]).includes("not set"));
      expect(notSetMsg).toBeTruthy();
      errSpy.mockRestore();
    });

    it("exits with error for unknown key", () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      try {
        configGet("unknown");
      } catch {
        // expected
      }
      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });
});
