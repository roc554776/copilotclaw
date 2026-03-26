import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configGet, configSet, main } from "../../src/config-cli.js";
import { loadFileConfig, saveConfig } from "../../src/config.js";

describe("config CLI", () => {
  const testProfile = `test-cli-${Date.now()}`;

  beforeEach(() => {
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    process.env["COPILOTCLAW_PROFILE"] = testProfile;
  });

  afterEach(() => {
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    delete process.env["COPILOTCLAW_PROFILE"];
  });

  describe("configSet", () => {
    it("sets upstream value in config file", () => {
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

    it("creates config file if it does not exist", () => {
      // No saveConfig call — file doesn't exist yet
      configSet("upstream", "file:///new");
      const config = loadFileConfig();
      expect(config.upstream).toBe("file:///new");
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

    it("exits with error for port above 65535", () => {
      saveConfig({});
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      try {
        configSet("port", "99999");
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

  describe("main", () => {
    it("dispatches config get", () => {
      saveConfig({ upstream: "file:///test" });
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      main(["config", "get", "upstream"]);
      expect(spy).toHaveBeenCalledWith("file:///test");
      spy.mockRestore();
    });

    it("dispatches config set", () => {
      saveConfig({});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      main(["config", "set", "port", "8080"]);
      const config = loadFileConfig();
      expect(config.port).toBe(8080);
      errSpy.mockRestore();
    });

    it("exits with usage when subcommand is missing", () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        main(["config"]);
      } catch {
        // expected
      }
      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
      errSpy.mockRestore();
    });

    it("exits with usage when get has no key", () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        main(["config", "get"]);
      } catch {
        // expected
      }
      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
      errSpy.mockRestore();
    });
  });
});
