/**
 * message-sender.ts
 *
 * Helper for resolving MessageSenderMeta for agent-originated messages.
 * Exported as named functions so daemon.ts and tests can import directly.
 *
 * Intent: Centralise the sender-identification logic to prevent drift between
 * the assistant.message path (session_event) and the copilotclaw_send_message
 * path (tool_call). Both paths call resolveAgentSenderMeta with the same
 * interface, ensuring consistent classification.
 */

import type { MessageSenderMeta } from "./store.js";

export interface SubagentLookupInfo {
  agentName: string;
  agentDisplayName: string;
}

export interface SubagentResolver {
  getSubagentInfo?: (sessionId: string, toolCallId: string) => SubagentLookupInfo | undefined;
}

export interface ChannelOperatorMeta {
  agentName: string;
  agentDisplayName: string;
}

/**
 * Resolve MessageSenderMeta for an agent-originated message.
 *
 * - parentToolCallId === undefined → the message comes from the channel-operator (top-level agent)
 * - parentToolCallId present and found in orchestrator → the message comes from a named subagent
 * - parentToolCallId present but not found → unknown subagent fallback
 */
export function resolveAgentSenderMeta(
  sessionId: string,
  parentToolCallId: string | undefined,
  orchestrator: SubagentResolver,
  channelOperatorMeta: ChannelOperatorMeta,
): MessageSenderMeta {
  if (parentToolCallId === undefined) {
    return {
      agentId: channelOperatorMeta.agentName,
      agentDisplayName: channelOperatorMeta.agentDisplayName,
      agentRole: "channel-operator",
    };
  }
  const sub = orchestrator.getSubagentInfo?.(sessionId, parentToolCallId);
  if (sub !== undefined) {
    return {
      agentId: sub.agentName,
      agentDisplayName: sub.agentDisplayName,
      agentRole: "subagent",
    };
  }
  return {
    agentId: "unknown-subagent",
    agentDisplayName: "Subagent",
    agentRole: "subagent",
  };
}
