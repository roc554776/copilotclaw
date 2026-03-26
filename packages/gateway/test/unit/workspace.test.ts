import { afterEach, describe, expect, it, vi } from "vitest";
import { getDataDir, getStoreFilePath, getWorkspaceRoot } from "../../src/workspace.js";

describe("workspace paths", () => {
  afterEach(() => {
    delete process.env["COPILOTCLAW_PROFILE"];
  });

  it("getWorkspaceRoot returns a path under home directory", () => {
    const root = getWorkspaceRoot();
    expect(root).toContain(".copilotclaw");
    expect(root).not.toContain("workspace-");
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

  it("getWorkspaceRoot with explicit profile returns profile-suffixed path", () => {
    const root = getWorkspaceRoot("staging");
    expect(root).toContain("workspace-staging");
  });

  it("getWorkspaceRoot reads COPILOTCLAW_PROFILE env var", () => {
    process.env["COPILOTCLAW_PROFILE"] = "dev";
    const root = getWorkspaceRoot();
    expect(root).toContain("workspace-dev");
  });

  it("explicit profile parameter overrides env var", () => {
    process.env["COPILOTCLAW_PROFILE"] = "dev";
    const root = getWorkspaceRoot("prod");
    expect(root).toContain("workspace-prod");
    expect(root).not.toContain("workspace-dev");
  });

  it("getDataDir with profile returns profile-scoped data dir", () => {
    const dataDir = getDataDir("test");
    expect(dataDir).toContain("workspace-test");
    expect(dataDir).toContain("data");
  });

  it("getStoreFilePath with profile returns profile-scoped store path", () => {
    const storePath = getStoreFilePath("test");
    expect(storePath).toContain("workspace-test");
    expect(storePath).toContain("store.json");
  });
});
