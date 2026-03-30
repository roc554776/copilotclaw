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
  /** Dynamic list of custom agents. Agent passes these directly to SDK customAgents.
   *  The first entry with infer:false is used as the top-level agent. */
  customAgents: CustomAgentDef[];
  /** Name of the top-level agent to run (must match one of customAgents). */
  primaryAgentName: string;
  systemReminder: string;
  initialPrompt: string;
  staleTimeoutMs: number;
  maxSessionAgeMs: number;
  rapidFailureThresholdMs: number;
  backoffDurationMs: number;
  keepaliveTimeoutMs: number;
  /** Context usage percentage increment that triggers a system prompt reminder (0.0–1.0). */
  reminderThresholdPercent: number;
  /** System prompt section IDs to capture via transform callbacks.
   *  Agent iterates this list and registers a pass-through capture for each. */
  knownSections: string[];
  /** Max send queue size. Agent drops oldest messages when exceeded. */
  maxQueueSize: number;
  /** Extra options to pass to CopilotClient constructor (passthrough). */
  clientOptions?: Record<string, unknown>;
  /** Extra options to merge into createSession/resumeSession config (passthrough). */
  sessionConfigOverrides?: Record<string, unknown>;
  /** Dynamic tool definitions. Agent registers these with SDK defineTool and dispatches
   *  tool calls to gateway via RPC. copilotclaw_wait is always registered (built-in)
   *  and does not need to be listed here — it has a gateway-offline fallback.
   *  Each entry defines the tool's name, description, and JSON Schema parameters. */
  toolDefinitions?: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** If true, tool execution skips permission request (default: true). */
  skipPermission?: boolean;
}

interface ModelInfo {
  id: string;
  billing?: { multiplier?: number };
}

/** Resolve which model to use for a session, applying gateway-side policy.
 *  This runs on gateway so that updating the selection algorithm only requires gateway restart.
 *  @param modelsResponse - result from agent's models IPC RPC
 *  @param configModel - user-configured model (from config.json)
 *  @param zeroPremium - whether to restrict to non-premium models
 */
export function resolveModel(
  modelsResponse: Record<string, unknown> | null,
  configModel: string | null,
  zeroPremium: boolean,
): string | undefined {
  if (modelsResponse === null) return undefined; // agent unavailable, let agent fall back

  const models = modelsResponse["models"] as ModelInfo[] | undefined;
  if (!Array.isArray(models) || models.length === 0) return undefined;

  const sorted = [...models].sort((a, b) =>
    (a.billing?.multiplier ?? Infinity) - (b.billing?.multiplier ?? Infinity),
  );
  const nonPremium = sorted.filter((m) => m.billing?.multiplier === 0);

  if (zeroPremium) {
    if (nonPremium.length === 0) return undefined; // let agent throw
    if (configModel !== undefined && configModel !== null) {
      const modelInfo = models.find((m) => m.id === configModel);
      if (modelInfo !== undefined && modelInfo.billing?.multiplier !== 0) {
        return nonPremium[0]!.id; // override premium model
      }
      return configModel;
    }
    return nonPremium[0]!.id;
  }

  if (configModel !== undefined && configModel !== null) return configModel;

  return sorted[0]!.id;
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
  "## Cron Tasks\n" +
  "You may receive messages prefixed with [CRON TASK]. These are automated scheduled tasks, not user input. " +
  "When you receive a cron task, delegate it to a worker subagent and call copilotclaw_wait to continue waiting. " +
  "Do not process cron tasks yourself — always use a worker subagent.\n" +
  "\n" +
  "## Subagent Rules\n" +
  "When dispatching subagents, always use background mode. " +
  "Only use the 'worker' agent — never use any other agent type (explore, etc.). " +
  "After dispatching a subagent, call copilotclaw_wait immediately to wait for its completion.\n" +
  "\n" +
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
    customAgents: [
      {
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
      {
        name: "worker",
        displayName: "Worker",
        description:
          "The ONLY agent to dispatch as a subagent. " +
          "When you need to delegate work to a subagent, you MUST use this agent — there is no other option. " +
          "This is the sole subagent available for task delegation. Always use 'worker' for any subagent dispatch.",
        prompt: "",
        infer: true,
      },
    ],
    primaryAgentName: "channel-operator",
    systemReminder: SYSTEM_REMINDER,
    initialPrompt: "Call copilotclaw_wait now to receive the first user message.",
    staleTimeoutMs: 10 * 60 * 1000, // 10 minutes
    maxSessionAgeMs: 2 * 24 * 60 * 60 * 1000, // 2 days
    rapidFailureThresholdMs: 30_000, // session lasted < 30s = rapid failure
    backoffDurationMs: 60_000, // wait 60s before retrying
    keepaliveTimeoutMs: 25 * 60 * 1000, // 25 minutes
    reminderThresholdPercent: 0.10, // remind every 10% context usage increase
    knownSections: [
      "identity", "tone", "tool_efficiency", "environment_context",
      "code_change_rules", "guidelines", "safety", "tool_instructions",
      "custom_instructions", "last_instructions",
    ],
    maxQueueSize: 10_000,
    toolDefinitions: [
      {
        name: "copilotclaw_send_message",
        description: "Send a message to the channel. Use this to report progress or reply to the user. Returns immediately.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "The message to send" },
          },
          required: ["message"],
        },
      },
      {
        name: "copilotclaw_list_messages",
        description: "List recent messages in the channel. Returns messages in reverse chronological order with sender information.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of messages to return (default: 5)" },
          },
          required: [],
        },
      },
    ],
  };
}
