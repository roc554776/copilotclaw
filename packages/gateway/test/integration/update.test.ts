import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rewriteWorkspaceDeps } from "../../src/update.js";
import { getUpdateDir } from "../../src/workspace.js";

describe("getUpdateDir", () => {
  it("returns a path under ~/.copilotclaw/", () => {
    const dir = getUpdateDir();
    expect(dir).toContain(".copilotclaw");
    expect(dir).toContain("source");
  });

  it("is profile-independent", () => {
    const original = process.env["COPILOTCLAW_PROFILE"];
    process.env["COPILOTCLAW_PROFILE"] = "test-profile";
    try {
      const dir = getUpdateDir();
      expect(dir).not.toContain("test-profile");
      expect(dir).toContain("source");
    } finally {
      if (original !== undefined) {
        process.env["COPILOTCLAW_PROFILE"] = original;
      } else {
        delete process.env["COPILOTCLAW_PROFILE"];
      }
    }
  });
});

describe("rewriteWorkspaceDeps", () => {
  const testDir = join(tmpdir(), `copilotclaw-update-test-${Date.now()}`);
  const cliDir = join(testDir, "packages", "cli");
  const sourceRoot = testDir;

  beforeEach(() => {
    mkdirSync(cliDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("rewrites workspace:* to file: paths", () => {
    writeFileSync(join(cliDir, "package.json"), JSON.stringify({
      name: "copilotclaw",
      dependencies: {
        "@copilotclaw/gateway": "workspace:*",
        "@copilotclaw/agent": "workspace:*",
      },
    }));

    rewriteWorkspaceDeps(cliDir, sourceRoot);

    const result = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8")) as { dependencies: Record<string, string> };
    expect(result.dependencies["@copilotclaw/gateway"]).toBe(`file:${join(sourceRoot, "packages", "gateway")}`);
    expect(result.dependencies["@copilotclaw/agent"]).toBe(`file:${join(sourceRoot, "packages", "agent")}`);
  });

  it("leaves non-workspace dependencies untouched", () => {
    writeFileSync(join(cliDir, "package.json"), JSON.stringify({
      name: "copilotclaw",
      dependencies: {
        "@copilotclaw/gateway": "workspace:*",
        "some-other-package": "^1.0.0",
      },
    }));

    rewriteWorkspaceDeps(cliDir, sourceRoot);

    const result = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8")) as { dependencies: Record<string, string> };
    expect(result.dependencies["some-other-package"]).toBe("^1.0.0");
  });

  it("does not throw when dependencies is missing", () => {
    writeFileSync(join(cliDir, "package.json"), JSON.stringify({
      name: "copilotclaw",
    }));

    expect(() => rewriteWorkspaceDeps(cliDir, sourceRoot)).not.toThrow();
  });
});
