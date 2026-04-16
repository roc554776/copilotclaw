/**
 * Typed discriminated union for IPC messages sent agent → gateway.
 *
 * These types replace ad-hoc JSON objects in ipc-server.ts.
 * The gateway side mirrors this in packages/gateway/src/ipc-types.ts.
 *
 * Design intent: agent is thin — it receives typed requests and returns typed responses.
 * All logic lives in the gateway.
 *
 * See docs/proposals/state-management-architecture.md
 * "gateway-agent process 境界を跨ぐ event" for the design contract.
 */

/** Events received by agent from gateway over the IPC stream (gateway → agent). */
export type GatewayToAgentEvent =
  | { type: "start_physical_session"; sessionId: string; physicalSessionId?: string | undefined; model?: string | undefined }
  | { type: "stop_physical_session"; sessionId: string }
  | { type: "disconnect_physical_session"; sessionId: string }
  | { type: "agent_notify"; sessionId: string }
  | { type: "config"; config: Record<string, unknown> }
  | { type: "message_acknowledged"; queueId: string }
  /** Gateway requests a report of all running physical sessions (reconcile coordinator). */
  | { type: "request_running_sessions" };

/** Events sent from agent to gateway over the IPC stream (agent → gateway). */
export type AgentToGatewayEvent =
  | { type: "physical_session_started"; sessionId: string; copilotSessionId: string; model: string; _queueId?: string }
  | { type: "physical_session_ended"; sessionId: string; reason: "idle" | "error" | "aborted"; copilotSessionId: string; elapsedMs: number; error?: string; _queueId?: string }
  | { type: "session_event"; sessionId: string; copilotSessionId?: string; eventType: string; timestamp: string; data: Record<string, unknown>; parentId?: string; _queueId?: string }
  | { type: "channel_message"; sessionId: string; sender: string; message: string; _queueId?: string }
  | { type: "system_prompt_original"; model: string; prompt: string; capturedAt: string; _queueId?: string }
  | { type: "system_prompt_session"; sessionId: string; model: string; prompt: string; _queueId?: string }
  /** @deprecated Use running_sessions_report in response to request_running_sessions instead */
  | { type: "running_sessions"; sessions: Array<{ sessionId: string; status: string }>; _queueId?: string }
  /** Response to gateway's request_running_sessions — returns all non-suspended physical session IDs. */
  | { type: "running_sessions_report"; physicalSessionIds: string[] };
