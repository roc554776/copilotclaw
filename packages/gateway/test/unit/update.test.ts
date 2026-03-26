import { describe, expect, it } from "vitest";
import { parseTgzFilename } from "../../src/update.js";
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

describe("parseTgzFilename", () => {
  it("extracts tgz filename from single-line output", () => {
    expect(parseTgzFilename("copilotclaw-0.12.0.tgz")).toBe("copilotclaw-0.12.0.tgz");
  });

  it("extracts tgz filename from multi-line output", () => {
    const output = "npm notice\nnpm notice package: copilotclaw@0.12.0\ncopilotclaw-0.12.0.tgz";
    expect(parseTgzFilename(output)).toBe("copilotclaw-0.12.0.tgz");
  });

  it("handles trailing newline", () => {
    expect(parseTgzFilename("copilotclaw-0.12.0.tgz\n")).toBe("copilotclaw-0.12.0.tgz");
  });

  it("handles output with leading whitespace", () => {
    expect(parseTgzFilename("  copilotclaw-0.12.0.tgz  ")).toBe("copilotclaw-0.12.0.tgz");
  });

  it("returns undefined for empty output", () => {
    expect(parseTgzFilename("")).toBeUndefined();
  });

  it("returns undefined for output with no tgz file", () => {
    expect(parseTgzFilename("npm notice\nsome other output")).toBeUndefined();
  });
});
