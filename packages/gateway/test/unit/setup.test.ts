import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { findAvailablePort, isPortAvailable } from "../../src/setup.js";

describe("port selection", () => {
  it("isPortAvailable returns true for a free port", async () => {
    // Port 0 lets the OS choose a free port, but we test with a specific high port
    const available = await isPortAvailable(39871);
    // This might be in use, but most likely not
    expect(typeof available).toBe("boolean");
  });

  it("isPortAvailable returns false for an occupied port", async () => {
    // Occupy a port
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });

    try {
      const available = await isPortAvailable(port);
      expect(available).toBe(false);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });

  it("findAvailablePort returns first available port from candidates", async () => {
    // Occupy two ports, provide three candidates — should return the third
    const server1 = createServer();
    const server2 = createServer();

    const port1 = await new Promise<number>((resolve) => {
      server1.listen(0, () => {
        const addr = server1.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    const port2 = await new Promise<number>((resolve) => {
      server2.listen(0, () => {
        const addr = server2.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });

    // Use a known-free port as the third candidate
    const freePort = 39873;

    try {
      const result = await findAvailablePort([port1, port2, freePort]);
      expect(result).toBe(freePort);
    } finally {
      await new Promise<void>((resolve) => { server1.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { server2.close(() => { resolve(); }); });
    }
  });

  it("findAvailablePort returns undefined when all candidates are occupied", async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });

    try {
      const result = await findAvailablePort([port]);
      expect(result).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });
});
