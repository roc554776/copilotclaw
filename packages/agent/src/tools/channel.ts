import { defineTool } from "@github/copilot-sdk";
import { requestFromGateway, sendToGateway, streamEvents } from "../ipc-server.js";

const WAIT_TOOL_NAME = "copilotclaw_wait";

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

export interface ChannelToolDeps {
  channelId: string;
  /** Keepalive timeout in milliseconds. Sent from gateway via config. */
  keepaliveTimeoutMs: number;
  abortSignal?: AbortSignal;
  onStatusChange?: (status: AgentStatusChange) => void;
  /** Structured log function (error level). Falls back to structured JSON on console.error. */
  logError?: (message: string) => void;
}

interface NextInputResponse {
  id: string;
  sender: string;
  message: string;
}

interface MessageResponse {
  id: string;
  channelId: string;
  sender: "user" | "agent" | "cron" | "system";
  message: string;
  createdAt: string;
}

/** Drain pending messages via IPC. Returns messages or empty array. */
async function drainPendingViaIpc(channelId: string): Promise<NextInputResponse[]> {
  try {
    const data = await requestFromGateway({ type: "drain_pending", channelId });
    if (Array.isArray(data)) return data as NextInputResponse[];
  } catch {
    // IPC error — treat as no messages
  }
  return [];
}

/** Wait for agent_notify from gateway, with keepalive timeout.
 *  Returns true if notified, false on timeout or abort. */
function waitForPendingNotify(channelId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }

    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const timer = setTimeout(() => { settle(false); }, timeoutMs);
    timer.unref();

    const onNotify = (msg: Record<string, unknown>) => {
      if (msg["channelId"] === channelId) {
        settle(true);
      }
    };

    const onAbort = () => { settle(false); };

    streamEvents.on("agent_notify", onNotify);
    signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup(): void {
      clearTimeout(timer);
      streamEvents.removeListener("agent_notify", onNotify);
      signal?.removeEventListener("abort", onAbort);
    }
  });
}

/** Poll for inputs via IPC: drain, if empty wait for notify, drain again.
 *  Returns messages or empty array (on keepalive timeout). */
async function pollNextInputs(channelId: string, keepaliveTimeoutMs: number, signal?: AbortSignal): Promise<NextInputResponse[]> {
  if (signal?.aborted) return [];

  // First attempt: drain immediately
  const immediate = await drainPendingViaIpc(channelId);
  if (immediate.length > 0) return immediate;

  // No messages — wait for push notification or timeout
  const notified = await waitForPendingNotify(channelId, keepaliveTimeoutMs, signal);
  if (!notified) return []; // timeout or abort

  // Notified — drain again
  return drainPendingViaIpc(channelId);
}

function combineMessages(inputs: NextInputResponse[]): string {
  return inputs.map((i) => {
    if (i.sender === "cron") return `[CRON TASK] ${i.message}`;
    if (i.sender === "system") return `[SYSTEM EVENT] ${i.message}`;
    return i.message;
  }).join("\n\n");
}

export function createChannelTools(deps: ChannelToolDeps) {
  const logError = deps.logError ?? ((message: string) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", component: "agent", msg: message }));
  });

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
      sendToGateway({ type: "channel_message", channelId: deps.channelId, sender: "agent", message: args.message });
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
          logError("swallowed message detected — forcing reply reminder");
          deps.onStatusChange?.("processing");
          return { userMessage: SWALLOWED_MESSAGE_INSTRUCTION };
        }

        deps.onStatusChange?.("waiting");
        const keepaliveTimeout = deps.keepaliveTimeoutMs;
        const inputs = await pollNextInputs(deps.channelId, keepaliveTimeout, deps.abortSignal);

        if (inputs.length === 0) {
          return { userMessage: KEEPALIVE_INSTRUCTION };
        }
        deps.onStatusChange?.("processing");
        pendingReplyExpected = true;
        const combined = combineMessages(inputs);
        return { userMessage: combined + WAIT_INSTRUCTION };
      } catch (err: unknown) {
        // Log to system log only — agent must not see this error.
        // AbortError (from shutdown) is also caught here intentionally —
        // the session loop's shouldStop() check handles clean shutdown.
        // Re-throwing any error would kill the physical session (deadlock).
        logError(`wait internal error (suppressed): ${err instanceof Error ? err.message : String(err)}`);
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
      const limit = args.limit ?? 5;
      try {
        const data = await requestFromGateway({ type: "list_messages", channelId: deps.channelId, limit });
        return { messages: Array.isArray(data) ? data as MessageResponse[] : [] };
      } catch (err: unknown) {
        throw new Error(`list_messages failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    skipPermission: true,
  });

  return { sendMessage, wait, listMessages };
}
