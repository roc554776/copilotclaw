import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findAvailablePort, isPortAvailable } from "../../src/setup.js";

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
