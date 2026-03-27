import { afterEach, describe, expect, it } from "vitest";
import { getDataDir, getStoreDbPath, getStoreFilePath, getWorkspaceRoot } from "../../src/workspace.js";

describe("workspace paths", () => {
  afterEach(() => {
    delete process.env["COPILOTCLAW_PROFILE"];
  });

  it("getWorkspaceRoot returns workspace subdir under state dir for no profile", () => {
    const root = getWorkspaceRoot();
    expect(root).toMatch(/\.copilotclaw[/\\]workspace$/);
    expect(root).not.toContain(".copilotclaw-");
  });

  it("getDataDir returns data subdir under state dir (not workspace)", () => {
    const dataDir = getDataDir();
    expect(dataDir).toContain(".copilotclaw");
    expect(dataDir).toContain("data");
    expect(dataDir).not.toContain("workspace");
  });

  it("getStoreDbPath returns a SQLite DB path under data dir", () => {
    const storePath = getStoreDbPath();
    expect(storePath).toContain("store.db");
    expect(storePath).toContain("data");
  });

  it("getStoreFilePath returns legacy JSON file path under data dir", () => {
    const storePath = getStoreFilePath();
    expect(storePath).toContain("store.json");
    expect(storePath).toContain("data");
  });

  it("getWorkspaceRoot with profile returns workspace under profile state dir", () => {
    const root = getWorkspaceRoot("staging");
    expect(root).toContain(".copilotclaw-staging");
    expect(root).toMatch(/workspace$/);
  });

  it("getWorkspaceRoot reads COPILOTCLAW_PROFILE env var", () => {
    process.env["COPILOTCLAW_PROFILE"] = "dev";
    const root = getWorkspaceRoot();
    expect(root).toContain(".copilotclaw-dev");
    expect(root).toMatch(/workspace$/);
  });

  it("explicit profile parameter overrides env var", () => {
    process.env["COPILOTCLAW_PROFILE"] = "dev";
    const root = getWorkspaceRoot("prod");
    expect(root).toContain(".copilotclaw-prod");
    expect(root).not.toContain(".copilotclaw-dev");
  });

  it("getDataDir with profile returns profile-scoped data dir", () => {
    const dataDir = getDataDir("test");
    expect(dataDir).toContain(".copilotclaw-test");
    expect(dataDir).toContain("data");
  });

  it("getStoreFilePath with profile returns profile-scoped store path", () => {
    const storePath = getStoreFilePath("test");
    expect(storePath).toContain(".copilotclaw-test");
    expect(storePath).toContain("store.json");
  });
});
