import type { ServerResponse } from "node:http";
import { SESSION_REPLAY_LIMIT, SessionEventStore } from "./session-event-store.js";
import { formatSessionSseFrame } from "./sse-broadcaster.js";

/**
 * Replays missed session events directly to a newly reconnecting SSE client.
 * Writes events with id > afterId from the SessionEventStore directly to `res`,
 * bypassing the broadcaster so only this specific client receives the catch-up data.
 * Returns the number of events replayed.
 *
 * Exported so integration tests can import and exercise the exact same code path,
 * eliminating the risk of test/implementation drift.
 */
export function replaySessionEventsAfter(
  res: ServerResponse,
  sessionId: string,
  afterId: number,
  sessionEventStore: SessionEventStore,
): number {
  try {
    if (!Number.isFinite(afterId)) return 0;
    const events = sessionEventStore.listEventsAfterId(sessionId, afterId);
    for (const event of events) {
      res.write(formatSessionSseFrame({ type: "session_event_appended", event }));
    }
    if (events.length >= SESSION_REPLAY_LIMIT) {
      console.warn(`[session-replay] limit reached for session ${sessionId}, afterId=${afterId}, replayed=${events.length}`);
    }
    return events.length;
  } catch (err) {
    console.error("Failed to replay session events", err);
    return 0;
  }
}
