import { tmpdir } from "node:os";
import { join } from "node:path";

export function getAgentSocketPath(channelId: string): string {
  return join(tmpdir(), `copilotclaw-agent-${channelId}.sock`);
}
