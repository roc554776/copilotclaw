import { describe, expect, it } from "vitest";
import { getUpdateDir } from "../../src/workspace.js";

describe("update infrastructure", () => {
  it("getUpdateDir returns a path under ~/.copilotclaw/", () => {
    const dir = getUpdateDir();
    expect(dir).toContain(".copilotclaw");
    expect(dir).toContain("source");
  });

  it("getUpdateDir is profile-independent", () => {
    const original = process.env["COPILOTCLAW_PROFILE"];
    process.env["COPILOTCLAW_PROFILE"] = "test-profile";
    try {
      const dir = getUpdateDir();
      // Should NOT contain the profile name — source dir is shared
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
