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
    "status" | "physicalSessionId" | "physicalSession" | "physicalSessionHistory" | "hasHadPhysicalSession" | "waitingOnWaitTool"
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

  // physical session がない場合は initial か after-stop。
  // ただし status が waiting/notified/processing/idle のいずれかであれば physical session は
  // 存在しているはずなので（broadcast タイミング競合で physicalSession がまだ set されていない
  // 瞬間がありえる）、absent と誤判定しない。
  const physicalSessionAbsent =
    session.physicalSession === undefined &&
    session.physicalSessionId === undefined &&
    (session.status === "new" || session.status === "starting" || session.status === "suspended");
  if (physicalSessionAbsent) {
    // hasHadPhysicalSession is the accurate flag; physicalSessionHistory.length > 0 was an approximation
    if (session.hasHadPhysicalSession) return "no-physical-session-after-stop";
    return "no-physical-session-initial";
  }

  // running 系: notified / processing
  if (session.status === "notified" || session.status === "processing") {
    return "running";
  }

  // idle/waiting/starting/suspended で pending があれば pending-trigger
  if (hasPending) return "pending-trigger";

  return "idle-no-trigger";
}
