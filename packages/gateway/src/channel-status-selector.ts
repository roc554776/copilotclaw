import type { AbstractSession } from "./session-orchestrator.js";

export type DerivedChannelStatus =
  | "client-not-started"
  | "no-physical-session-initial"
  | "no-physical-session-after-stop"
  | "idle-no-trigger"
  | "pending-trigger"
  | "running";

export interface SelectDerivedChannelStatusInput {
  session: Pick<
    AbstractSession,
    "status" | "copilotSessionId" | "physicalSession" | "physicalSessionHistory"
  >;
  hasPending: boolean;
  /** scope 外（CopilotClient 観測経路が未実装のため常に true を渡す想定） */
  clientStarted?: boolean;
}

export function selectDerivedChannelStatus(
  input: SelectDerivedChannelStatusInput,
): DerivedChannelStatus {
  const { session, hasPending, clientStarted = true } = input;

  // client-not-started は scope 外（観測経路未実装）
  if (!clientStarted) return "client-not-started";

  // physical session がない場合は initial か after-stop
  if (session.copilotSessionId === undefined && session.physicalSession === undefined) {
    if (session.physicalSessionHistory.length > 0) return "no-physical-session-after-stop";
    return "no-physical-session-initial";
  }

  // running 系: notified / processing
  if (session.status === "notified" || session.status === "processing") {
    return "running";
  }

  // idle/waiting/starting/suspended で pending があれば pending-trigger
  // waitingOnWaitTool フラグが未実装のため、waiting 全体を以下の分岐に含める
  if (hasPending) return "pending-trigger";

  return "idle-no-trigger";
}
