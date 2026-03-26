import { describe, expect, it } from "vitest";
import { getDataDir, getStoreFilePath, getWorkspaceRoot } from "../../src/workspace.js";

describe("workspace paths", () => {
  it("getWorkspaceRoot returns a path under home directory", () => {
    const root = getWorkspaceRoot();
    expect(root).toContain(".copilotclaw");
  });

  it("getDataDir returns a path under workspace root", () => {
    const dataDir = getDataDir();
    expect(dataDir).toContain(".copilotclaw");
    expect(dataDir).toContain("data");
  });

  it("getStoreFilePath returns a JSON file path under data dir", () => {
    const storePath = getStoreFilePath();
    expect(storePath).toContain("store.json");
    expect(storePath).toContain("data");
  });
});
