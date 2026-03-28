import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchSessionEvents, fetchStatus, type SessionEvent } from "../api";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { usePolling } from "../hooks/usePolling";
import { SESSION_ID_SHORT } from "../utils";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

export function SessionEventsPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [abstractSessionId, setAbstractSessionId] = useState<string | null>(null);

  const { containerRef, handleScroll } =
    useAutoScroll<HTMLDivElement>([events.length]);

  // Find which abstract session owns this physical session
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    fetchStatus(controller.signal)
      .then((status) => {
        if (controller.signal.aborted || !status.agent?.sessions) return;
        for (const [absId, session] of Object.entries(status.agent.sessions)) {
          if (session.physicalSession?.sessionId === sessionId) {
            setAbstractSessionId(absId);
            return;
          }
          if (session.physicalSessionHistory) {
            for (const ps of session.physicalSessionHistory) {
              if (ps.sessionId === sessionId) {
                setAbstractSessionId(absId);
                return;
              }
            }
          }
        }
        // Not found in any abstract session
        setAbstractSessionId(null);
      })
      .catch(() => {
        /* ignore */
      });
    return () => controller.abort();
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const allEvents = await fetchSessionEvents(sessionId);
      setEvents((prev) => {
        if (allEvents.length === prev.length) return prev;
        if (allEvents.length > prev.length) {
          const newSlice = allEvents.slice(prev.length);
          return [...prev, ...newSlice];
        }
        return allEvents;
      });
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  usePolling(refresh, 2000);

  const sessionsLink = abstractSessionId
    ? `/sessions?focus=${encodeURIComponent(abstractSessionId)}`
    : "/sessions";

  return (
    <div style={{ padding: "1rem" }}>
      <div style={{ marginBottom: "1rem", display: "flex", gap: "1rem" }}>
        <a href="/status" style={{ display: "inline-block" }}>
          &larr; Back to System Status
        </a>
        <a href={sessionsLink} style={{ display: "inline-block" }}>
          &larr; Back to Sessions
        </a>
      </div>
      <h1
        style={{
          fontSize: "1rem",
          color: "#58a6ff",
          marginBottom: "0.5rem",
        }}
      >
        Session Events
        <span
          style={{
            color: "#8b949e",
            fontSize: "0.8rem",
            marginLeft: "1rem",
          }}
        >
          ({events.length} events)
        </span>
      </h1>

      <div
        style={{
          marginBottom: "1rem",
          display: "flex",
          gap: "1rem",
          alignItems: "center",
        }}
      >
        <button
          onClick={refresh}
          style={{
            background: "#21262d",
            color: "#c9d1d9",
            border: "1px solid #30363d",
            padding: "0.3rem 0.8rem",
            borderRadius: "0.3rem",
            cursor: "pointer",
            fontSize: "0.8rem",
          }}
        >
          Refresh
        </button>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-testid="events-container"
        style={{
          maxHeight: "calc(100vh - 10rem)",
          overflowY: "auto",
          border: "1px solid #30363d",
          borderRadius: "0.5rem",
          padding: "0.5rem",
        }}
      >
        {events.map((e, i) => (
          <div
            key={`${e.timestamp}-${e.type}-${i}`}
            style={{
              padding: "0.3rem 0.5rem",
              borderBottom: "1px solid #21262d",
              fontSize: "0.8rem",
            }}
          >
            <span style={{ color: "#58a6ff", fontWeight: 600 }}>
              {e.type}
            </span>
            <span style={{ color: "#8b949e", marginLeft: "0.5rem" }}>
              {formatTime(e.timestamp)}
            </span>
            {e.parentId && (
              <span style={{ color: "#8b949e", marginLeft: "0.5rem" }}>
                [parent: {e.parentId.slice(0, SESSION_ID_SHORT)}]
              </span>
            )}
            <div
              style={{
                color: "#7d8590",
                marginTop: "0.2rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {JSON.stringify(e.data, null, 2)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
