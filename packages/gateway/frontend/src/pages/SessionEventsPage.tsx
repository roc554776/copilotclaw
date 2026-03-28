import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchSessionEvents, type SessionEvent } from "../api";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { usePolling } from "../hooks/usePolling";

export function SessionEventsPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [nested, setNested] = useState(false);
  const lastEventCountRef = useRef(0);

  const { containerRef, handleScroll } = useAutoScroll<HTMLDivElement>([events.length]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const newEvents = await fetchSessionEvents(sessionId);
      setEvents(newEvents);
      lastEventCountRef.current = newEvents.length;
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  usePolling(refresh, 2000);

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString();
    } catch {
      return iso;
    }
  };

  const renderFlat = () =>
    events.map((e, i) => (
      <div
        key={i}
        style={{
          padding: "0.3rem 0.5rem",
          borderBottom: "1px solid #21262d",
          fontSize: "0.8rem",
        }}
      >
        <span style={{ color: "#58a6ff", fontWeight: 600 }}>{e.type}</span>
        <span style={{ color: "#8b949e", marginLeft: "0.5rem" }}>{formatTime(e.timestamp)}</span>
        {e.parentId && (
          <span style={{ color: "#8b949e", marginLeft: "0.5rem" }}>
            [parent: {e.parentId.slice(0, 8)}]
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
    ));

  const renderNested = () => {
    const byParent = new Map<string, SessionEvent[]>();
    const roots: SessionEvent[] = [];

    for (const e of events) {
      if (e.parentId) {
        const list = byParent.get(e.parentId) ?? [];
        list.push(e);
        byParent.set(e.parentId, list);
      } else {
        roots.push(e);
      }
    }

    const renderNode = (e: SessionEvent, idx: number): React.ReactNode => {
      const toolCallId = (e.data as Record<string, unknown>)["toolCallId"] as string | undefined;
      const sid = (e.data as Record<string, unknown>)["sessionId"] as string | undefined;
      const children = byParent.get(toolCallId ?? "") ?? byParent.get(sid ?? "") ?? [];

      return (
        <div
          key={idx}
          style={{
            padding: "0.3rem 0.5rem",
            borderBottom: "1px solid #21262d",
            fontSize: "0.8rem",
          }}
        >
          <span style={{ color: "#58a6ff", fontWeight: 600 }}>{e.type}</span>
          <span style={{ color: "#8b949e", marginLeft: "0.5rem" }}>
            {formatTime(e.timestamp)}
          </span>
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
          {children.length > 0 && (
            <div
              style={{
                marginLeft: "1.5rem",
                borderLeft: "2px solid #30363d",
                paddingLeft: "0.5rem",
              }}
            >
              {children.map((child, ci) => renderNode(child, ci))}
            </div>
          )}
        </div>
      );
    };

    return roots.map((e, i) => renderNode(e, i));
  };

  return (
    <div style={{ padding: "1rem" }}>
      <a href="/status" style={{ marginBottom: "1rem", display: "inline-block" }}>
        &larr; Back to System Status
      </a>
      <h1 style={{ fontSize: "1rem", color: "#58a6ff", marginBottom: "0.5rem" }}>
        Session Events
        <span style={{ color: "#8b949e", fontSize: "0.8rem", marginLeft: "1rem" }}>
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
        <label style={{ fontSize: "0.85rem", color: "#8b949e" }}>
          <input
            type="checkbox"
            checked={nested}
            onChange={(e) => setNested(e.target.checked)}
          />{" "}
          Nested view (parent-child)
        </label>
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
        {nested ? renderNested() : renderFlat()}
      </div>
    </div>
  );
}
