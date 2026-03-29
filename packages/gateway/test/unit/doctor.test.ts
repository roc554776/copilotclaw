import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigFilePath, saveConfig } from "../../src/config.js";
import { checkAuth, checkConfig, checkWorkspace, checkZeroPremium, runDoctor } from "../../src/doctor.js";
import { ensureWorkspaceReady } from "../../src/setup.js";
import { ensureWorkspace, getDataDir, getWorkspaceRoot } from "../../src/workspace.js";

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
    delete process.env["COPILOTCLAW_MODEL"];
    delete process.env["COPILOTCLAW_ZERO_PREMIUM"];
    delete process.env["COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS"];
  });

  describe("checkWorkspace", () => {
    it("returns fail when workspace does not exist", () => {
      process.env["COPILOTCLAW_PROFILE"] = `nonexistent-${Date.now()}`;
      const result = checkWorkspace();
      expect(result.result).toBe("fail");
      expect(result.fixable).toBe(true);
    });

    it("returns pass when workspace is fully set up", () => {
      ensureWorkspace();
      ensureWorkspaceReady(getWorkspaceRoot());
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
      writeFileSync(getConfigFilePath(), JSON.stringify({ configVersion: 1, port: -1 }), "utf-8");
      const result = checkConfig();
      expect(result.result).toBe("warn");
    });

    it("auto-migrates config with missing configVersion and returns pass", () => {
      saveConfig({});
      writeFileSync(getConfigFilePath(), JSON.stringify({ port: 19741 }), "utf-8");
      const result = checkConfig();
      expect(result.result).toBe("pass");
      // Verify the file was migrated
      const onDisk = JSON.parse(readFileSync(getConfigFilePath(), "utf-8")) as Record<string, unknown>;
      expect(onDisk["configVersion"]).toBe(4);
    });

    it("auto-migrates config with outdated configVersion and returns pass", () => {
      saveConfig({});
      writeFileSync(getConfigFilePath(), JSON.stringify({ configVersion: 0, port: 19741 }), "utf-8");
      const result = checkConfig();
      expect(result.result).toBe("pass");
      const onDisk = JSON.parse(readFileSync(getConfigFilePath(), "utf-8")) as Record<string, unknown>;
      expect(onDisk["configVersion"]).toBe(4);
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
      writeFileSync(getConfigFilePath(), JSON.stringify({ configVersion: 1, port: 99999 }), "utf-8");
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

  describe("checkAuth", () => {
    it("returns pass when auth is not configured", () => {
      saveConfig({});
      const result = checkAuth();
      expect(result.result).toBe("pass");
      expect(result.message).toContain("not configured");
    });

    it("returns fail when pat tokenEnv is not set", () => {
      delete process.env["NONEXISTENT_TOKEN_VAR"];
      saveConfig({ auth: { github: { type: "pat", tokenEnv: "NONEXISTENT_TOKEN_VAR" } } });
      const result = checkAuth();
      expect(result.result).toBe("fail");
      expect(result.message).toContain("NONEXISTENT_TOKEN_VAR");
    });

    it("returns pass when pat tokenEnv is set", () => {
      process.env["TEST_AUTH_TOKEN"] = "github_pat_test";
      saveConfig({ auth: { github: { type: "pat", tokenEnv: "TEST_AUTH_TOKEN" } } });
      const result = checkAuth();
      expect(result.result).toBe("pass");
      delete process.env["TEST_AUTH_TOKEN"];
    });

    it("returns fail when pat has no token source", () => {
      saveConfig({ auth: { github: { type: "pat" } } });
      const result = checkAuth();
      expect(result.result).toBe("fail");
      expect(result.message).toContain("no tokenEnv");
    });

    it("returns pass for gh-auth with valid tokenCommand", () => {
      saveConfig({ auth: { github: { type: "gh-auth", tokenCommand: "echo test-token" } } });
      const result = checkAuth();
      expect(result.result).toBe("pass");
      expect(result.message).toContain("command");
    });

    it("returns fail for gh-auth with invalid tokenCommand", () => {
      saveConfig({ auth: { github: { type: "gh-auth", tokenCommand: "nonexistent-binary-xyz" } } });
      const result = checkAuth();
      expect(result.result).toBe("fail");
      expect(result.message).toContain("failed");
    });
  });

  describe("runDoctor", () => {
    it("runs all checks and returns true when no failures", async () => {
      ensureWorkspace();
      ensureWorkspaceReady(getWorkspaceRoot());
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
      expect(existsSync(getWorkspaceRoot())).toBe(true);
      errSpy.mockRestore();
    });

    it("outputs plain text without color codes", async () => {
      ensureWorkspace();
      ensureWorkspaceReady(getWorkspaceRoot());
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
