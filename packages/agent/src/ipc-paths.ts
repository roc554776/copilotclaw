import { tmpdir } from "node:os";
import { join } from "node:path";

function getProfileName(): string | undefined {
  return process.env["COPILOTCLAW_PROFILE"] || undefined;
}

export function getAgentSocketPath(profile?: string): string {
  const p = profile ?? getProfileName();
  if (p !== undefined) {
    return join(tmpdir(), `copilotclaw-agent-${p}.sock`);
  }
  return join(tmpdir(), "copilotclaw-agent.sock");
}
