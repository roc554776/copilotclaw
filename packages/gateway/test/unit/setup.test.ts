import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAvailablePort, isPortAvailable, seedWorkspaceBootstrapFiles } from "../../src/setup.js";

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
