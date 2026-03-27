import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkspaceHealth, ensureWorkspaceReady, findAvailablePort, isPortAvailable, migrateWorkspaceFiles, seedWorkspaceBootstrapFiles } from "../../src/setup.js";

function listenOnRandomPort(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr !== null ? addr.port : 0 });
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => { server.close(() => { resolve(); }); });
}

describe("port selection", () => {
  it("isPortAvailable returns true for a port that was just released", async () => {
    // Bind a port, get its number, release it, then check availability
    const { server, port } = await listenOnRandomPort();
    await closeServer(server);
    const available = await isPortAvailable(port);
    expect(available).toBe(true);
  });

  it("isPortAvailable returns false for an occupied port", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const available = await isPortAvailable(port);
      expect(available).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("findAvailablePort returns first available port from candidates", async () => {
    const s1 = await listenOnRandomPort();
    const s2 = await listenOnRandomPort();
    // Get a free port by binding and releasing
    const s3 = await listenOnRandomPort();
    const freePort = s3.port;
    await closeServer(s3.server);

    try {
      const result = await findAvailablePort([s1.port, s2.port, freePort]);
      expect(result).toBe(freePort);
    } finally {
      await closeServer(s1.server);
      await closeServer(s2.server);
    }
  });

  it("findAvailablePort returns undefined when all candidates are occupied", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const result = await findAvailablePort([port]);
      expect(result).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });
});

describe("workspace bootstrap files", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-setup-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates SOUL.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md, and memory/ directory", () => {
    seedWorkspaceBootstrapFiles(tmpDir);

    expect(existsSync(join(tmpDir, "SOUL.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "USER.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "TOOLS.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "memory"))).toBe(true);
    expect(statSync(join(tmpDir, "memory")).isDirectory()).toBe(true);

    // SOUL.md should contain persona content
    const soul = readFileSync(join(tmpDir, "SOUL.md"), "utf-8");
    expect(soul).toContain("Who You Are");
    expect(soul).toContain("Core Truths");

    // AGENTS.md should contain session startup instructions
    const agents = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("Session Startup");
    expect(agents).toContain("SOUL.md");
  });

  it("does not overwrite existing files", () => {
    const customContent = "# My Custom SOUL";
    const soulPath = join(tmpDir, "SOUL.md");
    writeFileSync(soulPath, customContent, "utf-8");

    seedWorkspaceBootstrapFiles(tmpDir);

    // Should preserve the custom content
    expect(readFileSync(soulPath, "utf-8")).toBe(customContent);
    // But should still create other files
    expect(existsSync(join(tmpDir, "AGENTS.md"))).toBe(true);
  });
});

describe("workspace migration", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "copilotclaw-migrate-test-"));
    workspaceDir = join(stateDir, "workspace");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("migrates bootstrap files from state dir root to workspace/", () => {
    writeFileSync(join(stateDir, "SOUL.md"), "my soul", "utf-8");
    writeFileSync(join(stateDir, "AGENTS.md"), "my agents", "utf-8");

    migrateWorkspaceFiles(stateDir, workspaceDir);

    expect(existsSync(join(stateDir, "SOUL.md"))).toBe(false);
    expect(existsSync(join(stateDir, "AGENTS.md"))).toBe(false);
    expect(readFileSync(join(workspaceDir, "SOUL.md"), "utf-8")).toBe("my soul");
    expect(readFileSync(join(workspaceDir, "AGENTS.md"), "utf-8")).toBe("my agents");
  });

  it("migrates memory/ directory from state dir root to workspace/", () => {
    const memDir = join(stateDir, "memory");
    mkdirSync(memDir);
    writeFileSync(join(memDir, "2026-03-27.md"), "today's log", "utf-8");

    migrateWorkspaceFiles(stateDir, workspaceDir);

    expect(existsSync(join(stateDir, "memory"))).toBe(false);
    expect(readFileSync(join(workspaceDir, "memory", "2026-03-27.md"), "utf-8")).toBe("today's log");
  });

  it("does not overwrite files already in workspace/", () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(stateDir, "SOUL.md"), "old soul", "utf-8");
    writeFileSync(join(workspaceDir, "SOUL.md"), "new soul", "utf-8");

    migrateWorkspaceFiles(stateDir, workspaceDir);

    // Old file at state dir should remain (not moved because dest exists)
    expect(existsSync(join(stateDir, "SOUL.md"))).toBe(true);
    expect(readFileSync(join(workspaceDir, "SOUL.md"), "utf-8")).toBe("new soul");
  });

  it("is a no-op when stateDir equals workspaceRoot", () => {
    writeFileSync(join(stateDir, "SOUL.md"), "soul", "utf-8");

    migrateWorkspaceFiles(stateDir, stateDir);

    expect(readFileSync(join(stateDir, "SOUL.md"), "utf-8")).toBe("soul");
  });

  it("is a no-op when no bootstrap files exist at state dir root", () => {
    migrateWorkspaceFiles(stateDir, workspaceDir);

    expect(existsSync(workspaceDir)).toBe(false);
  });
});

describe("ensureWorkspaceReady", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-ensure-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates workspace dir, bootstrap files, memory/.gitkeep, and git repo", () => {
    ensureWorkspaceReady(tmpDir);

    expect(existsSync(join(tmpDir, "SOUL.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "USER.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "TOOLS.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "memory", ".gitkeep"))).toBe(true);
    expect(existsSync(join(tmpDir, ".git"))).toBe(true);
  });

  it("creates initial git commit with workspace files", () => {
    ensureWorkspaceReady(tmpDir);

    const log = spawnSync("git", ["log", "--oneline"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" });
    expect(log.status).toBe(0);
    expect(log.stdout).toContain("Initial workspace setup");
  });

  it("is idempotent — second call does not create duplicate commits", () => {
    ensureWorkspaceReady(tmpDir);
    ensureWorkspaceReady(tmpDir);

    const log = spawnSync("git", ["log", "--oneline"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" });
    expect(log.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("checkWorkspaceHealth", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilotclaw-health-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns no issues for a fully set up workspace", () => {
    ensureWorkspaceReady(tmpDir);
    const issues = checkWorkspaceHealth(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("reports missing files", () => {
    mkdirSync(tmpDir, { recursive: true });
    const issues = checkWorkspaceHealth(tmpDir);
    expect(issues.some((i) => i.includes("SOUL.md"))).toBe(true);
    expect(issues.some((i) => i.includes("memory/"))).toBe(true);
  });

  it("reports missing workspace directory", () => {
    const nonexistent = join(tmpDir, "nonexistent");
    const issues = checkWorkspaceHealth(nonexistent);
    expect(issues).toContain("workspace directory missing");
  });
});
