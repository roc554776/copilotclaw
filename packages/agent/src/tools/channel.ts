import { defineTool } from "@github/copilot-sdk";

const REPLY_TOOL_NAME = "copilotclaw_reply_and_receive_input";

const REPLY_INSTRUCTION = `\n\n[SYSTEM] You MUST use the ${REPLY_TOOL_NAME} tool to reply to the user. Do NOT respond with plain text.`;

export interface ChannelToolDeps {
  gatewayBaseUrl: string;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface NextInputResponse {
  id: string;
  message: string;
}

async function pollNextInput(deps: ChannelToolDeps): Promise<NextInputResponse> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const interval = deps.pollIntervalMs ?? 5000;

  for (;;) {
    const res = await fetchFn(`${deps.gatewayBaseUrl}/api/inputs/next`, { method: "POST" });
    if (res.status === 200) {
      const data = await res.json() as NextInputResponse;
      return data;
    }
    await new Promise((r) => { setTimeout(r, interval); });
  }
}

async function postReply(deps: ChannelToolDeps, inputId: string, message: string): Promise<void> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  await fetchFn(`${deps.gatewayBaseUrl}/api/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputId, message }),
  });
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
      const input = await pollNextInput(deps);
      currentInputId = input.id;
      return { userMessage: input.message + REPLY_INSTRUCTION };
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
      const input = await pollNextInput(deps);
      currentInputId = input.id;
      return { userMessage: input.message + REPLY_INSTRUCTION };
    },
    skipPermission: true,
  });

  return { receiveFirstInput, replyAndReceiveInput };
}
