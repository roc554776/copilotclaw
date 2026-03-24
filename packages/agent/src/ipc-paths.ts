import { tmpdir } from "node:os";
import { join } from "node:path";

export function getAgentSocketPath(): string {
  return join(tmpdir(), "copilotclaw-agent.sock");
}
