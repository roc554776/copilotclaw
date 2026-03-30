import { defineTool } from "@github/copilot-sdk";
import { requestFromGateway, streamEvents } from "../ipc-server.js";

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

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  skipPermission?: boolean;
}

export interface ChannelToolDeps {
  channelId: string;
  /** Keepalive timeout in milliseconds. Sent from gateway via config. */
  keepaliveTimeoutMs: number;
  abortSignal?: AbortSignal;
  onStatusChange?: (status: AgentStatusChange) => void;
  /** Structured log function (error level). Falls back to structured JSON on console.error. */
  logError?: (message: string) => void;
  /** Dynamic tool definitions from gateway config. Agent registers these and dispatches
   *  tool calls to gateway via RPC. copilotclaw_wait is built-in and always present. */
  toolDefinitions?: ToolDefinition[];
}

interface NextInputResponse {
  id: string;
  sender: string;
  message: string;
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

/** Create a gateway-dispatched tool handler. Sends tool call to gateway via RPC,
 *  returns the result. On gateway disconnect, returns a graceful error message
 *  instead of throwing (to preserve physical session). */
function createGatewayToolHandler(
  toolName: string,
  channelId: string,
  logError: (message: string) => void,
): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args: Record<string, unknown>) => {
    try {
      const result = await requestFromGateway({
        type: "tool_call",
        toolName,
        channelId,
        args,
      });
      return result ?? { status: "ok" };
    } catch {
      // Gateway unreachable — return graceful error, NOT throw.
      // Throwing would risk killing the physical session.
      logError(`tool ${toolName}: gateway unreachable, returning graceful error`);
      return { error: "Gateway is not connected. The tool cannot be executed at this time." };
    }
  };
}

export function createChannelTools(deps: ChannelToolDeps) {
  const logError = deps.logError ?? ((message: string) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", component: "agent", msg: message }));
  });

  // Swallowed-message detection state.
  let pendingReplyExpected = false;

  // --- Built-in: copilotclaw_wait (always registered, has gateway-offline fallback) ---
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
        // Swallowed-message guard
        if (pendingReplyExpected) {
          logError("swallowed message detected — forcing reply reminder");
          deps.onStatusChange?.("processing");
          return { userMessage: SWALLOWED_MESSAGE_INSTRUCTION };
        }

        deps.onStatusChange?.("waiting");

        // Try gateway RPC first. If gateway handles wait, use its response.
        try {
          const gatewayResult = await requestFromGateway({
            type: "tool_call",
            toolName: WAIT_TOOL_NAME,
            channelId: deps.channelId,
            args: {},
          });
          if (gatewayResult !== null && gatewayResult !== undefined && typeof gatewayResult === "object") {
            const msg = gatewayResult as Record<string, unknown>;
            if (typeof msg["userMessage"] === "string") {
              if (msg["userMessage"] !== KEEPALIVE_INSTRUCTION) {
                deps.onStatusChange?.("processing");
                pendingReplyExpected = true;
              }
              return gatewayResult;
            }
          }
        } catch {
          // Gateway unreachable — fall through to built-in keepalive logic
        }

        // Fallback: agent-autonomous keepalive cycle (gateway offline)
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
        logError(`wait internal error (suppressed): ${err instanceof Error ? err.message : String(err)}`);
        return { userMessage: KEEPALIVE_INSTRUCTION };
      }
    },
    skipPermission: true,
  });

  // The conventional send-message tool name. When the dynamic tool list includes
  // this tool, its handler is wrapped to clear pendingReplyExpected so the
  // swallowed-message guard is not falsely triggered on the next wait call.
  const SEND_MESSAGE_TOOL_NAME = "copilotclaw_send_message";

  // --- Dynamic tools from gateway config ---
  const dynamicTools = (deps.toolDefinitions ?? []).map((def) => {
    // Skip copilotclaw_wait if listed in toolDefinitions (it's built-in)
    if (def.name === WAIT_TOOL_NAME) return null;

    const gatewayHandler = createGatewayToolHandler(def.name, deps.channelId, logError);

    // For the send-message tool: wrap the handler to clear pendingReplyExpected.
    // Without this, the swallowed-message guard fires on every second wait even
    // when the agent correctly replied — because the dynamic tool has no direct
    // access to the flag inside the wait closure.
    const handler = def.name === SEND_MESSAGE_TOOL_NAME
      ? async (args: Record<string, unknown>) => {
          const result = await gatewayHandler(args);
          pendingReplyExpected = false;
          return result;
        }
      : gatewayHandler;

    return defineTool(def.name, {
      description: def.description,
      parameters: def.parameters,
      handler,
      skipPermission: def.skipPermission ?? true,
    });
  }).filter((t): t is NonNullable<typeof t> => t !== null);

  return { tools: [wait, ...dynamicTools] };
}
