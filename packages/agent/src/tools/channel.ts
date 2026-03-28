import { defineTool } from "@github/copilot-sdk";

const WAIT_TOOL_NAME = "copilotclaw_wait";

const DEFAULT_KEEPALIVE_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

const WAIT_INSTRUCTION =
  `\n\n---\n` +
  `[SYSTEM] Required workflow: (A) Call copilotclaw_send_message with your complete reply, ` +
  `then (B) call ${WAIT_TOOL_NAME} to wait for the next message. ` +
  `You MUST call copilotclaw_send_message BEFORE ${WAIT_TOOL_NAME}. ` +
  `The user CANNOT see your text output — only messages sent via copilotclaw_send_message reach them. ` +
  `Do NOT stop without calling ${WAIT_TOOL_NAME}.`;

const SWALLOWED_MESSAGE_INSTRUCTION =
  `[SYSTEM] CRITICAL: You received user message(s) but called ${WAIT_TOOL_NAME} ` +
  `without sending a reply via copilotclaw_send_message. The user received NOTHING. ` +
  `You MUST call copilotclaw_send_message with your response NOW, then call ${WAIT_TOOL_NAME}.`;

const KEEPALIVE_INSTRUCTION = `[SYSTEM] No user message received (keepalive cycle). Call ${WAIT_TOOL_NAME} immediately to continue waiting. Do NOT stop.`;

export type AgentStatusChange = "waiting" | "processing";

export interface SubagentCompletionInfo {
  toolCallId: string;
  agentName: string;
  status: "completed" | "failed";
  error?: string | undefined;
  model?: string | undefined;
  totalToolCalls?: number | undefined;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
}

export interface ChannelToolDeps {
  gatewayBaseUrl: string;
  channelId: string;
  pollIntervalMs?: number;
  keepaliveTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  abortSignal?: AbortSignal;
  onStatusChange?: (status: AgentStatusChange) => void;
  /** Drain all pending subagent completion events. Returns and clears the queue. */
  drainSubagentCompletions?: () => SubagentCompletionInfo[];
}

interface NextInputResponse {
  id: string;
  message: string;
}

interface MessageResponse {
  id: string;
  channelId: string;
  sender: "user" | "agent";
  message: string;
  createdAt: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

async function pollNextInputs(deps: ChannelToolDeps): Promise<NextInputResponse[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const interval = deps.pollIntervalMs ?? 5000;
  const keepaliveTimeout = deps.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;
  const signal = deps.abortSignal;
  const fetchOpts: RequestInit = { method: "POST" };
  if (signal !== undefined) fetchOpts.signal = signal;
  const startTime = Date.now();

  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() - startTime >= keepaliveTimeout) return [];
    const res = await fetchFn(
      `${deps.gatewayBaseUrl}/api/channels/${deps.channelId}/messages/pending`,
      fetchOpts,
    );
    if (res.status === 200) {
      const data = await res.json() as NextInputResponse[];
      return data;
    }
    await sleep(interval, signal);
  }
}

function combineMessages(inputs: NextInputResponse[]): string {
  return inputs.map((i) => i.message).join("\n\n");
}

export function createChannelTools(deps: ChannelToolDeps) {
  // Swallowed-message detection state.
  // Tracks whether wait returned user messages and whether
  // send_message was called before the next wait invocation.
  // When the LLM calls wait again without having called
  // send_message, the handler returns a forceful reminder instead of
  // polling — this is a deterministic safeguard against lost replies.
  let pendingReplyExpected = false;

  const sendMessage = defineTool("copilotclaw_send_message", {
    description: "Send a message to the channel. Use this to report progress or reply to the user. Returns immediately.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to send" },
      },
      required: ["message"],
    },
    handler: async (args: { message: string }) => {
      const fetchFn = deps.fetch ?? globalThis.fetch;
      const opts: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "agent", message: args.message }),
      };
      if (deps.abortSignal !== undefined) opts.signal = deps.abortSignal;
      const res = await fetchFn(`${deps.gatewayBaseUrl}/api/channels/${deps.channelId}/messages`, opts);
      if (!res.ok) {
        throw new Error(`send_message failed: ${res.status} ${res.statusText}`);
      }
      pendingReplyExpected = false;
      return { status: "sent" };
    },
    skipPermission: true,
  });

  const wait = defineTool(WAIT_TOOL_NAME, {
    description: "Wait for user input, subagent completion, or other events. Blocks until input arrives or keepalive timeout. Call this whenever you have nothing to do, even temporarily.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      // CRITICAL: This handler must NEVER throw. Any exception is caught and
      // returns the same response as a keepalive timeout. If this tool returns
      // an error, the agent's physical session stops, causing an irrecoverable
      // deadlock. The agent must not perceive that an error occurred.
      try {
        // Swallowed-message guard: if the previous wait returned user
        // messages but send_message was never called, the user got no reply.
        // Return immediately with a forceful reminder instead of polling.
        if (pendingReplyExpected) {
          console.error("[agent] swallowed message detected — forcing reply reminder");
          deps.onStatusChange?.("processing");
          return { userMessage: SWALLOWED_MESSAGE_INSTRUCTION };
        }

        deps.onStatusChange?.("waiting");
        const inputs = await pollNextInputs(deps);

        // Drain subagent completions that occurred while waiting
        const subagentCompletions = deps.drainSubagentCompletions?.() ?? [];
        const subagentNotice = subagentCompletions.length > 0
          ? "[SUBAGENT COMPLETED] " + subagentCompletions.map((c) =>
              `${c.agentName} ${c.status}${c.error ? ` (error: ${c.error})` : ""}` +
              `${c.totalTokens !== undefined ? ` [tokens: ${c.totalTokens}]` : ""}` +
              `${c.durationMs !== undefined ? ` [${c.durationMs}ms]` : ""}`
            ).join("; ")
          : "";

        if (inputs.length === 0) {
          if (subagentCompletions.length > 0) {
            // Subagent finished while no user message — return subagent info
            deps.onStatusChange?.("processing");
            return { userMessage: subagentNotice + WAIT_INSTRUCTION };
          }
          return { userMessage: KEEPALIVE_INSTRUCTION };
        }
        deps.onStatusChange?.("processing");
        pendingReplyExpected = true;
        const combined = combineMessages(inputs);
        return { userMessage: combined + "\n\n" + subagentNotice + WAIT_INSTRUCTION };
      } catch (err: unknown) {
        // Log to system log only — agent must not see this error.
        // AbortError (from shutdown) is also caught here intentionally —
        // the session loop's shouldStop() check handles clean shutdown.
        // Re-throwing any error would kill the physical session (deadlock).
        console.error("[agent] wait internal error (suppressed):", err);
        // Return keepalive-equivalent response — indistinguishable from timeout
        return { userMessage: KEEPALIVE_INSTRUCTION };
      }
    },
    skipPermission: true,
  });

  const listMessages = defineTool("copilotclaw_list_messages", {
    description: "List recent messages in the channel. Returns messages in reverse chronological order with sender information.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of messages to return (default: 5)" },
      },
      required: [],
    },
    handler: async (args: { limit?: number }) => {
      const fetchFn = deps.fetch ?? globalThis.fetch;
      const limit = args.limit ?? 5;
      const fetchOpts: RequestInit = {};
      if (deps.abortSignal !== undefined) fetchOpts.signal = deps.abortSignal;
      const res = await fetchFn(
        `${deps.gatewayBaseUrl}/api/channels/${deps.channelId}/messages?limit=${limit}`,
        fetchOpts,
      );
      if (!res.ok) {
        throw new Error(`list_messages failed: ${res.status} ${res.statusText}`);
      }
      const messages = await res.json() as MessageResponse[];
      return { messages };
    },
    skipPermission: true,
  });

  return { sendMessage, wait, listMessages };
}
