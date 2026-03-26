import { describe, expect, it } from "vitest";
import { shouldRebuild } from "../../src/update.js";

describe("shouldRebuild", () => {
  it("returns sha-changed when SHAs differ with no upstream", () => {
    expect(shouldRebuild("aaa", "bbb", undefined)).toBe("sha-changed");
  });

  it("returns sha-changed when SHAs differ with https upstream", () => {
    expect(shouldRebuild("aaa", "bbb", "https://github.com/org/repo.git")).toBe("sha-changed");
  });

  it("returns sha-changed when SHAs differ with file:// upstream", () => {
    expect(shouldRebuild("aaa", "bbb", "file:///path/to/repo")).toBe("sha-changed");
  });

  it("returns up-to-date when SHAs match with no upstream", () => {
    expect(shouldRebuild("aaa", "aaa", undefined)).toBe("up-to-date");
  });

  it("returns up-to-date when SHAs match with https upstream", () => {
    expect(shouldRebuild("aaa", "aaa", "https://github.com/org/repo.git")).toBe("up-to-date");
  });

  it("returns file-upstream-rebuild when SHAs match with file:// upstream", () => {
    expect(shouldRebuild("aaa", "aaa", "file:///path/to/repo")).toBe("file-upstream-rebuild");
  });
});
