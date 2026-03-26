import { afterEach, describe, expect, it } from "vitest";
import { getAgentSocketPath } from "../../src/ipc-paths.js";

describe("IPC paths", () => {
  afterEach(() => {
    delete process.env["COPILOTCLAW_PROFILE"];
  });

  it("returns default socket path without profile", () => {
    const path = getAgentSocketPath();
    expect(path).toContain("copilotclaw-agent.sock");
    expect(path).not.toContain("copilotclaw-agent-");
  });

  it("returns profile-suffixed socket path with explicit profile", () => {
    const path = getAgentSocketPath("staging");
    expect(path).toContain("copilotclaw-agent-staging.sock");
  });

  it("reads COPILOTCLAW_PROFILE env var", () => {
    process.env["COPILOTCLAW_PROFILE"] = "dev";
    const path = getAgentSocketPath();
    expect(path).toContain("copilotclaw-agent-dev.sock");
  });
});
