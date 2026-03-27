import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveToken, type AuthConfig } from "../src/token-resolver.js";

describe("resolveToken", () => {
  describe("type: pat with tokenEnv", () => {
    it("resolves token from environment variable", () => {
      vi.stubEnv("TEST_PAT_TOKEN", "github_pat_test123");
      const token = resolveToken({ type: "pat", tokenEnv: "TEST_PAT_TOKEN" });
      expect(token).toBe("github_pat_test123");
      vi.unstubAllEnvs();
    });

    it("throws when environment variable is not set", () => {
      delete process.env["TEST_MISSING_TOKEN"];
      expect(() => resolveToken({ type: "pat", tokenEnv: "TEST_MISSING_TOKEN" }))
        .toThrow('auth.tokenEnv "TEST_MISSING_TOKEN" is not set or empty');
    });

    it("throws when environment variable is empty", () => {
      vi.stubEnv("TEST_EMPTY_TOKEN", "");
      expect(() => resolveToken({ type: "pat", tokenEnv: "TEST_EMPTY_TOKEN" }))
        .toThrow("is not set or empty");
      vi.unstubAllEnvs();
    });
  });

  describe("type: pat with tokenFile", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "token-resolver-test-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("resolves token from file", () => {
      const tokenFile = join(tempDir, "token.txt");
      writeFileSync(tokenFile, "github_pat_file123\n", "utf-8");
      const token = resolveToken({ type: "pat", tokenFile });
      expect(token).toBe("github_pat_file123");
    });

    it("throws when file does not exist", () => {
      const tokenFile = join(tempDir, "nonexistent.txt");
      expect(() => resolveToken({ type: "pat", tokenFile }))
        .toThrow("not found");
    });

    it("throws when file is empty", () => {
      const tokenFile = join(tempDir, "empty.txt");
      writeFileSync(tokenFile, "", "utf-8");
      expect(() => resolveToken({ type: "pat", tokenFile }))
        .toThrow("is empty");
    });
  });

  describe("type: pat without tokenEnv/tokenFile/tokenCommand", () => {
    it("throws when no token source is configured", () => {
      expect(() => resolveToken({ type: "pat" }))
        .toThrow("requires tokenEnv, tokenFile, or tokenCommand");
    });
  });

  describe("type: gh-auth", () => {
    it("calls gh auth token without args by default", () => {
      // This test will fail if gh is not installed, which is acceptable
      // since gh is a prerequisite. Skip if gh is unavailable.
      try {
        const token = resolveToken({ type: "gh-auth" });
        expect(token.length).toBeGreaterThan(0);
      } catch (err: unknown) {
        // gh not installed or not authenticated — skip
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT") || msg.includes("gh auth token failed")) {
          return; // gh not available, acceptable skip
        }
        throw err;
      }
    });
  });

  describe("tokenCommand override", () => {
    it("tokenCommand takes precedence over type-specific resolution", () => {
      const token = resolveToken({ type: "pat", tokenCommand: "echo test-token-123" });
      expect(token).toBe("test-token-123");
    });

    it("throws when tokenCommand returns empty output", () => {
      expect(() => resolveToken({ type: "pat", tokenCommand: "echo" }))
        .toThrow("returned empty output");
    });

    it("throws when tokenCommand is empty string", () => {
      expect(() => resolveToken({ type: "pat", tokenCommand: "" }))
        .toThrow("tokenCommand is empty");
    });
  });

  describe("unsupported type", () => {
    it("throws for unknown auth type", () => {
      expect(() => resolveToken({ type: "unknown" as AuthConfig["type"] }))
        .toThrow("unsupported auth type");
    });
  });
});
