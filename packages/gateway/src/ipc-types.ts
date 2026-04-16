/**
 * Typed discriminated union for IPC messages sent gateway → agent.
 *
 * These types replace ad-hoc JSON objects in agent-manager.ts.
 * The agent side mirrors this in packages/agent/src/ipc-types.ts.
 *
 * Design intent: agent is thin — it receives typed requests and returns typed responses.
 * All logic lives in the gateway.
 *
 * See docs/proposals/state-management-architecture.md
 * "gateway-agent process 境界を跨ぐ event" for the design contract.
 */

/** Events sent from gateway to agent over the IPC stream. */
export type GatewayToAgentEvent =
  | { type: "start_physical_session"; sessionId: string; physicalSessionId?: string | undefined; model?: string | undefined }
  | { type: "stop_physical_session"; sessionId: string }
  | { type: "disconnect_physical_session"; sessionId: string }
  | { type: "agent_notify"; sessionId: string }
  | { type: "config"; config: Record<string, unknown> }
  | { type: "message_acknowledged"; queueId: string }
  /** Gateway requests a report of all running physical sessions (reconcile coordinator). */
  | { type: "request_running_sessions" };
