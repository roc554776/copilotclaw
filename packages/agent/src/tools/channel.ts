import { defineTool } from "@github/copilot-sdk";

const REPLY_TOOL_NAME = "copilotclaw_reply_and_receive_input";

const REPLY_INSTRUCTION = `\n\n[SYSTEM] You MUST use the ${REPLY_TOOL_NAME} tool to reply to the user. Do NOT respond with plain text.`;

export type AgentStatusChange = "waiting" | "processing";

export interface ChannelToolDeps {
  gatewayBaseUrl: string;
  channelId: string;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  abortSignal?: AbortSignal;
  onStatusChange?: (status: AgentStatusChange) => void;
}

interface NextInputResponse {
  id: string;
  message: string;
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
  const signal = deps.abortSignal;
  const fetchOpts: RequestInit = { method: "POST" };
  if (signal !== undefined) fetchOpts.signal = signal;

  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await fetchFn(
      `${deps.gatewayBaseUrl}/api/channels/${deps.channelId}/inputs/next`,
      fetchOpts,
    );
    if (res.status === 200) {
      const data = await res.json() as NextInputResponse[];
      return data;
    }
    await sleep(interval, signal);
  }
}

function combineMessages(inputs: NextInputResponse[]): { lastInputId: string; combined: string } {
  if (inputs.length === 0) {
    return { lastInputId: "", combined: "" };
  }
  const combined = inputs.map((i) => i.message).join("\n\n");
  return { lastInputId: inputs[inputs.length - 1]!.id, combined };
}

async function postReply(deps: ChannelToolDeps, inputId: string, message: string): Promise<void> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const opts: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputId, message }),
  };
  if (deps.abortSignal !== undefined) opts.signal = deps.abortSignal;
  const res = await fetchFn(`${deps.gatewayBaseUrl}/api/channels/${deps.channelId}/replies`, opts);
  if (!res.ok) {
    throw new Error(`reply failed: ${res.status} ${res.statusText}`);
  }
}

export function createChannelTools(deps: ChannelToolDeps) {
  let currentInputId: string | undefined;

  const receiveFirstInput = defineTool("copilotclaw_receive_first_input", {
    description: "Call this tool at session initialization to receive the first user input from the channel.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      deps.onStatusChange?.("waiting");
      const inputs = await pollNextInputs(deps);
      deps.onStatusChange?.("processing");
      const { lastInputId, combined } = combineMessages(inputs);
      currentInputId = lastInputId;
      return { userMessage: combined + REPLY_INSTRUCTION };
    },
    skipPermission: true,
  });

  const replyAndReceiveInput = defineTool(REPLY_TOOL_NAME, {
    description: "Reply to the user's message and wait for the next user input from the channel.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The reply message to send to the user" },
      },
      required: ["message"],
    },
    handler: async (args: { message: string }) => {
      if (currentInputId !== undefined) {
        await postReply(deps, currentInputId, args.message);
      }
      deps.onStatusChange?.("waiting");
      const inputs = await pollNextInputs(deps);
      deps.onStatusChange?.("processing");
      const { lastInputId, combined } = combineMessages(inputs);
      currentInputId = lastInputId;
      return { userMessage: combined + REPLY_INSTRUCTION };
    },
    skipPermission: true,
  });

  return { receiveFirstInput, replyAndReceiveInput };
}
