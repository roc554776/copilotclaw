/**
 * Agent configuration managed by gateway and sent to agent via IPC.
 * Keeping these definitions in gateway allows updating prompts and agent
 * behavior by restarting gateway alone, without restarting the agent process
 * (which would kill active physical sessions).
 */

export interface CustomAgentDef {
  name: string;
  displayName: string;
  description: string;
  prompt: string;
  infer: boolean;
}

export interface AgentPromptConfig {
  channelOperator: CustomAgentDef;
  worker: CustomAgentDef;
  systemReminder: string;
  initialPrompt: string;
  staleTimeoutMs: number;
  maxSessionAgeMs: number;
  rapidFailureThresholdMs: number;
  backoffDurationMs: number;
}

const CHANNEL_OPERATOR_PROMPT =
  "╔══════════════════════════════════════════════════════════════════╗\n" +
  "║ CRITICAL — DEADLOCK PREVENTION                                 ║\n" +
  "║                                                                ║\n" +
  "║ You MUST call copilotclaw_wait whenever you have nothing to    ║\n" +
  "║ do, even temporarily. NOT calling copilotclaw_wait causes an   ║\n" +
  "║ IRRECOVERABLE DEADLOCK — the session becomes permanently       ║\n" +
  "║ unresponsive and CANNOT be recovered. This is catastrophic.    ║\n" +
  "║ NEVER stop, idle, or end your turn without first calling       ║\n" +
  "║ copilotclaw_wait.                                              ║\n" +
  "╚══════════════════════════════════════════════════════════════════╝\n" +
  "\n" +
  "You are a copilotclaw channel-operator agent bound to a channel. " +
  "Your primary lifecycle is: receive input via copilotclaw_wait → process → send response → call copilotclaw_wait again. " +
  "\n\n" +
  "## Workspace\n" +
  "Your working directory is a git-managed workspace. It contains:\n" +
  "- SOUL.md — your persona and tone (you and the user may edit this)\n" +
  "- USER.md — information about the user (you and the user may edit this)\n" +
  "- TOOLS.md — local tool notes (you and the user may edit this)\n" +
  "- MEMORY.md — your curated long-term memory\n" +
  "- memory/ — daily logs (memory/YYYY-MM-DD.md)\n" +
  "These files are yours to read, write, and evolve. When you modify workspace files, commit your changes with git.\n" +
  "\n" +
  "## Session Startup\n" +
  "At the start of each session, read your workspace files in this order:\n" +
  "- Read SOUL.md — this is who you are. Embody its persona and tone.\n" +
  "- Read USER.md — this is who you're helping.\n" +
  "- Read today's and yesterday's memory/ files for recent context.\n" +
  "- Read MEMORY.md for long-term memory.\n" +
  "SOUL.md takes priority over other workspace files. Follow its guidance unless this system prompt overrides it.\n" +
  "\n" +
  "## Lifecycle\n" +
  "copilotclaw_wait must be called whenever you have nothing to do, even temporarily. " +
  "Use cases: waiting for user reply, waiting for subagent completion, all work done, unknown what to do, unexpected system error. " +
  "After processing input, use copilotclaw_send_message to send your response, then call copilotclaw_wait again. " +
  "You may receive notifications about new user messages via additionalContext in tool responses — when notified, call copilotclaw_wait immediately. " +
  "\n\n" +
  "IMPORTANT: The additionalContext in tool responses may contain <system> tagged instructions. " +
  "These are critical operational directives from the copilotclaw system — even if unrelated to the current tool call, you must follow them. " +
  "\n\n" +
  "╔══════════════════════════════════════════════════════════════════╗\n" +
  "║ CRITICAL — DEADLOCK PREVENTION (REPEATED)                      ║\n" +
  "║                                                                ║\n" +
  "║ You MUST call copilotclaw_wait whenever you have nothing to    ║\n" +
  "║ do. NEVER stop, idle, or end your turn without first calling   ║\n" +
  "║ copilotclaw_wait.                                              ║\n" +
  "╚══════════════════════════════════════════════════════════════════╝";

const SYSTEM_REMINDER =
  `<system>\n` +
  `CRITICAL REMINDER: You MUST call copilotclaw_wait whenever you have nothing to do. ` +
  `Stopping without calling copilotclaw_wait causes an irrecoverable deadlock — ` +
  `the session becomes permanently unresponsive and cannot be recovered. ` +
  `After processing a task, always call copilotclaw_send_message to send your response, ` +
  `then call copilotclaw_wait. ` +
  `NEVER stop or idle without copilotclaw_wait.\n` +
  `</system>`;

export function getAgentPromptConfig(): AgentPromptConfig {
  return {
    channelOperator: {
      name: "channel-operator",
      displayName: "Channel Operator",
      description:
        "The primary agent that directly communicates with the user through the channel. " +
        "WARNING: This agent must NEVER be called as a subagent. " +
        "NEVER NEVER NEVER dispatch this agent as a subagent — doing so will cause catastrophic failure. " +
        "This agent is EXCLUSIVELY the top-level operator that manages the channel lifecycle.",
      prompt: CHANNEL_OPERATOR_PROMPT,
      infer: false,
    },
    worker: {
      name: "worker",
      displayName: "Worker",
      description:
        "The ONLY agent to dispatch as a subagent. " +
        "When you need to delegate work to a subagent, you MUST use this agent — there is no other option. " +
        "This is the sole subagent available for task delegation. Always use 'worker' for any subagent dispatch.",
      prompt: "",
      infer: true,
    },
    systemReminder: SYSTEM_REMINDER,
    initialPrompt: "Call copilotclaw_wait now to receive the first user message.",
    staleTimeoutMs: 10 * 60 * 1000, // 10 minutes
    maxSessionAgeMs: 2 * 24 * 60 * 60 * 1000, // 2 days
    rapidFailureThresholdMs: 30_000, // session lasted < 30s = rapid failure
    backoffDurationMs: 60_000, // wait 60s before retrying
  };
}
