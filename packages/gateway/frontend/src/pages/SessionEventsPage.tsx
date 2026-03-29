import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchSessionEventsPaginated, fetchStatus, type SessionEvent } from "../api";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { usePolling } from "../hooks/usePolling";
import { SESSION_ID_SHORT } from "../utils";

const EVENTS_PAGE_SIZE = 50;

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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderEvents, setHasOlderEvents] = useState(true);
  const loadingOlderRef = useRef(false);

  const eventsRef = useRef<SessionEvent[]>([]);
  eventsRef.current = events;

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
        setAbstractSessionId(null);
      })
      .catch(() => {
        /* ignore */
      });
    return () => controller.abort();
  }, [sessionId]);

  // Initial load: fetch latest N events
  useEffect(() => {
    if (!sessionId) return;
    fetchSessionEventsPaginated(sessionId, EVENTS_PAGE_SIZE)
      .then((latest) => {
        setEvents(latest);
        setHasOlderEvents(latest.length >= EVENTS_PAGE_SIZE);
      })
      .catch(() => { /* ignore */ });
  }, [sessionId]);

  // Auto-refresh: poll for new events (append only)
  const refreshNewEvents = useCallback(async () => {
    if (!sessionId) return;
    const current = eventsRef.current;
    if (current.length === 0) return;
    const newestId = current[current.length - 1]!.id;
    if (newestId === undefined) return;
    try {
      const newer = await fetchSessionEventsPaginated(sessionId, EVENTS_PAGE_SIZE, { after: newestId });
      if (newer.length > 0) {
        setEvents((prev) => {
          const existingIds = new Set(prev.map((e) => e.id).filter((id) => id !== undefined));
          const unique = newer.filter((e) => e.id === undefined || !existingIds.has(e.id));
          return unique.length > 0 ? [...prev, ...unique] : prev;
        });
      }
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  usePolling(refreshNewEvents, 2000);

  // Load older events when scrolling up
  const loadOlderEvents = useCallback(async () => {
    if (!sessionId || loadingOlderRef.current || !hasOlderEvents) return;
    const oldest = eventsRef.current[0];
    if (!oldest?.id) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const el = containerRef.current;
      const prevScrollHeight = el?.scrollHeight ?? 0;

      const older = await fetchSessionEventsPaginated(sessionId, EVENTS_PAGE_SIZE, { before: oldest.id });
      if (older.length === 0) {
        setHasOlderEvents(false);
      } else {
        setEvents((prev) => [...older, ...prev]);
        setHasOlderEvents(older.length >= EVENTS_PAGE_SIZE);
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop = el.scrollHeight - prevScrollHeight;
          }
        });
      }
    } catch {
      /* ignore */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [sessionId, hasOlderEvents]);

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
          ({events.length} events loaded)
        </span>
      </h1>

      <div
        ref={containerRef}
        onScroll={(e) => {
          handleScroll();
          const el = e.currentTarget;
          if (el.scrollTop < 100 && hasOlderEvents && !loadingOlder) {
            loadOlderEvents();
          }
        }}
        data-testid="events-container"
        style={{
          maxHeight: "calc(100dvh - 8rem)",
          overflowY: "auto",
          border: "1px solid #30363d",
          borderRadius: "0.5rem",
          padding: "0.5rem",
        }}
      >
        {loadingOlder && (
          <div style={{ color: "#8b949e", textAlign: "center", padding: "0.5rem" }}>
            Loading older events...
          </div>
        )}
        {events.map((e, i) => (
          <div
            key={e.id ?? `${e.timestamp}-${e.type}-${i}`}
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
