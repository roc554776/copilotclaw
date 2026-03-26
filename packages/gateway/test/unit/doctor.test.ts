import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigFilePath, saveConfig } from "../../src/config.js";
import { checkConfig, checkWorkspace, checkZeroPremium, runDoctor } from "../../src/doctor.js";
import { ensureWorkspace, getDataDir } from "../../src/workspace.js";

describe("doctor", () => {
  beforeEach(() => {
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    process.env["COPILOTCLAW_PROFILE"] = `test-doctor-${Date.now()}`;
  });

  afterEach(() => {
    delete process.env["COPILOTCLAW_UPSTREAM"];
    delete process.env["COPILOTCLAW_PORT"];
    delete process.env["COPILOTCLAW_PROFILE"];
  });

  describe("checkWorkspace", () => {
    it("returns fail when workspace does not exist", () => {
      process.env["COPILOTCLAW_PROFILE"] = `nonexistent-${Date.now()}`;
      const result = checkWorkspace();
      expect(result.result).toBe("fail");
      expect(result.fixable).toBe(true);
    });

    it("returns pass when workspace exists", () => {
      ensureWorkspace();
      const result = checkWorkspace();
      expect(result.result).toBe("pass");
    });
  });

  describe("checkConfig", () => {
    it("returns warn when config file does not exist", () => {
      process.env["COPILOTCLAW_PROFILE"] = `nonexistent-${Date.now()}`;
      const result = checkConfig();
      expect(result.result).toBe("warn");
      expect(result.fixable).toBe(true);
    });

    it("returns pass for valid config", () => {
      saveConfig({ port: 19741 });
      const result = checkConfig();
      expect(result.result).toBe("pass");
    });

    it("returns warn for invalid port in config", () => {
      saveConfig({});
      writeFileSync(getConfigFilePath(), JSON.stringify({ port: -1 }), "utf-8");
      const result = checkConfig();
      expect(result.result).toBe("warn");
    });

    it("returns warn for malformed JSON config", () => {
      saveConfig({});
      writeFileSync(getConfigFilePath(), "not valid json{{{", "utf-8");
      const result = checkConfig();
      expect(result.result).toBe("warn");
      expect(result.message).toContain("malformed");
    });

    it("returns warn for port above 65535", () => {
      saveConfig({});
      writeFileSync(getConfigFilePath(), JSON.stringify({ port: 99999 }), "utf-8");
      const result = checkConfig();
      expect(result.result).toBe("warn");
    });
  });

  describe("checkZeroPremium", () => {
    it("returns pass when zeroPremium is disabled", () => {
      saveConfig({});
      const result = checkZeroPremium();
      expect(result.result).toBe("pass");
    });

    it("returns warn when zeroPremium is enabled with a premium model", () => {
      saveConfig({ zeroPremium: true, model: "gpt-4.1" });
      const result = checkZeroPremium();
      expect(result.result).toBe("warn");
    });

    it("returns pass when zeroPremium is enabled with a non-premium model", () => {
      saveConfig({ zeroPremium: true, model: "gpt-4.1-nano" });
      const result = checkZeroPremium();
      expect(result.result).toBe("pass");
    });

    it("returns pass when zeroPremium is enabled with no model specified", () => {
      saveConfig({ zeroPremium: true });
      const result = checkZeroPremium();
      expect(result.result).toBe("pass");
    });
  });

  describe("runDoctor", () => {
    it("runs all checks and returns true when no failures", async () => {
      ensureWorkspace();
      saveConfig({});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const ok = await runDoctor(false);
      expect(ok).toBe(true);
      errSpy.mockRestore();
    });

    it("returns false when there are failures", async () => {
      process.env["COPILOTCLAW_PROFILE"] = `nonexistent-${Date.now()}`;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const ok = await runDoctor(false);
      expect(ok).toBe(false);
      errSpy.mockRestore();
    });

    it("fixes workspace when --fix is used", async () => {
      process.env["COPILOTCLAW_PROFILE"] = `fixtest-${Date.now()}`;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await runDoctor(true);
      expect(existsSync(getDataDir())).toBe(true);
      errSpy.mockRestore();
    });

    it("outputs plain text without color codes", async () => {
      ensureWorkspace();
      saveConfig({});
      const calls: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        calls.push(String(args[0]));
      });
      await runDoctor(false);
      const ansiPattern = /\x1b\[/;
      for (const call of calls) {
        expect(ansiPattern.test(call)).toBe(false);
      }
      errSpy.mockRestore();
    });
  });
});
