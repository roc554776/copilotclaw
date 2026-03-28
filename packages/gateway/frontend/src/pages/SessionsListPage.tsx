import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchSessionEvents,
  fetchSessionIds,
  fetchStatus,
  type AgentSession,
  type PhysicalSession,
  type StatusResponse,
} from "../api";
import { SDK_SESSION_ID_SHORT, SESSION_ID_SHORT } from "../utils";

const CONCURRENCY_LIMIT = 5;

interface OrphanSummary {
  sid: string;
  eventCount: number;
  model: string;
}

async function fetchWithConcurrencyLimit<T>(
  items: string[],
  fn: (item: string) => Promise<T>,
  limit: number,
  signal: AbortSignal,
): Promise<(T | undefined)[]> {
  const results = new Array<T | undefined>(items.length).fill(undefined);
  let index = 0;

  async function next(): Promise<void> {
    while (index < items.length) {
      if (signal.aborted) return;
      const currentIndex = index++;
      const item = items[currentIndex]!;
      try {
        results[currentIndex] = await fn(item);
      } catch {
        /* leave as undefined */
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => next(),
  );
  await Promise.all(workers);
  return results;
}

function collectPhysicalSessionIds(session: AgentSession): Set<string> {
  const ids = new Set<string>();
  if (session.physicalSession?.sessionId) {
    ids.add(session.physicalSession.sessionId);
  }
  if (session.physicalSessionHistory) {
    for (const ps of session.physicalSessionHistory) {
      ids.add(ps.sessionId);
    }
  }
  return ids;
}

function PhysicalSessionCard({ ps, label }: { ps: PhysicalSession; label?: string }) {
  return (
    <a
      href={`/sessions/${encodeURIComponent(ps.sessionId)}/events`}
      style={{ textDecoration: "none", display: "block" }}
    >
      <div
        style={{
          padding: "0.4rem 0.6rem",
          border: "1px solid #21262d",
          borderRadius: "0.3rem",
          marginBottom: "0.3rem",
          marginLeft: "1.5rem",
          fontSize: "0.8rem",
        }}
      >
        {label && (
          <span style={{ color: "#8b949e", fontSize: "0.75rem", marginRight: "0.5rem" }}>
            {label}
          </span>
        )}
        <span style={{ color: "#58a6ff", fontWeight: 600 }}>
          {ps.sessionId.slice(0, SDK_SESSION_ID_SHORT)}
        </span>
        <span style={{ color: "#8b949e", marginLeft: "0.5rem" }}>
          {ps.model && <>Model: {ps.model} &middot; </>}
          State: {ps.currentState}
          {ps.totalInputTokens != null && (
            <> &middot; Tokens: {ps.totalInputTokens + (ps.totalOutputTokens ?? 0)}</>
          )}
        </span>
      </div>
    </a>
  );
}

export function SessionsListPage() {
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [orphans, setOrphans] = useState<OrphanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);

  const loadData = useCallback(async (signal: AbortSignal) => {
    try {
      const [statusData, physicalIds] = await Promise.all([
        fetchStatus(signal),
        fetchSessionIds(signal),
      ]);
      if (signal.aborted) return;

      setStatus(statusData);

      // Determine which physical session IDs are associated with abstract sessions
      const knownPhysicalIds = new Set<string>();
      if (statusData.agent?.sessions) {
        for (const session of Object.values(statusData.agent.sessions)) {
          for (const id of collectPhysicalSessionIds(session)) {
            knownPhysicalIds.add(id);
          }
        }
      }

      // Orphaned physical sessions = those not in any abstract session
      const orphanIds = physicalIds.filter((id) => !knownPhysicalIds.has(id));

      if (orphanIds.length > 0) {
        const results = await fetchWithConcurrencyLimit(
          orphanIds,
          async (sid) => {
            try {
              const events = await fetchSessionEvents(sid, signal);
              let model = "";
              for (const e of events) {
                if (
                  e.type === "session.model_change" &&
                  typeof (e.data as Record<string, unknown>)["newModel"] === "string"
                ) {
                  model = (e.data as Record<string, unknown>)["newModel"] as string;
                }
                if (
                  !model &&
                  e.type === "assistant.usage" &&
                  typeof (e.data as Record<string, unknown>)["model"] === "string"
                ) {
                  model = (e.data as Record<string, unknown>)["model"] as string;
                }
              }
              return { sid, eventCount: events.length, model };
            } catch {
              return { sid, eventCount: 0, model: "" };
            }
          },
          CONCURRENCY_LIMIT,
          signal,
        );
        if (signal.aborted) return;
        const valid: OrphanSummary[] = [];
        for (const r of results) {
          if (r !== undefined) valid.push(r);
        }
        setOrphans(valid);
      } else {
        setOrphans([]);
      }

      setError(null);
    } catch (e) {
      if (signal.aborted) return;
      setError(String(e));
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    loadData(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadData]);

  // Scroll focused abstract session into view (useLayoutEffect to act after DOM update)
  useLayoutEffect(() => {
    if (focusId && focusRef.current && !loading) {
      focusRef.current.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }
  }, [focusId, loading]);

  const sessions = status?.agent?.sessions ?? {};
  const sessionEntries = Object.entries(sessions);

  return (
    <div style={{ padding: "1rem", maxWidth: 800, margin: "0 auto" }}>
      <a
        href="/status"
        style={{ marginBottom: "1rem", display: "inline-block" }}
      >
        &larr; Back to System Status
      </a>
      <h1
        style={{
          fontSize: "1.2rem",
          color: "#58a6ff",
          marginBottom: "1rem",
        }}
      >
        Sessions
      </h1>

      {loading && (
        <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
          Loading...
        </div>
      )}
      {error && (
        <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
          Error: {error}
        </div>
      )}
      {!loading && sessionEntries.length === 0 && orphans.length === 0 && (
        <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
          No sessions found.
        </div>
      )}

      {sessionEntries.map(([abstractId, session]) => {
        const isFocused = focusId === abstractId;
        return (
          <div
            key={abstractId}
            ref={isFocused ? focusRef : undefined}
            data-testid={`abstract-session-${abstractId}`}
            style={{
              padding: "0.6rem",
              borderWidth: "2px",
              borderStyle: "solid",
              borderColor: isFocused ? "#58a6ff" : "#30363d",
              borderRadius: "0.4rem",
              marginBottom: "0.7rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ color: "#58a6ff", fontWeight: 600, fontSize: "0.9rem" }}>
                {abstractId.slice(0, SESSION_ID_SHORT)}
              </span>
              <span
                style={{
                  color: session.status === "active" ? "#3fb950" : "#8b949e",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                }}
              >
                {session.status}
              </span>
              {session.boundChannelId && (
                <span style={{ color: "#8b949e", fontSize: "0.8rem" }}>
                  Channel: {session.boundChannelId.slice(0, 8)}
                </span>
              )}
              {session.startedAt && (
                <span style={{ color: "#8b949e", fontSize: "0.75rem" }}>
                  Started: {new Date(session.startedAt).toLocaleString()}
                </span>
              )}
            </div>

            {/* Current physical session */}
            {session.physicalSession && (
              <div style={{ marginTop: "0.4rem" }}>
                <PhysicalSessionCard ps={session.physicalSession} label="current" />
              </div>
            )}

            {/* Physical session history */}
            {session.physicalSessionHistory && session.physicalSessionHistory.length > 0 && (
              <div style={{ marginTop: "0.2rem" }}>
                {session.physicalSessionHistory.map((ps) => (
                  <PhysicalSessionCard key={ps.sessionId} ps={ps} label="history" />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Orphaned physical sessions */}
      {orphans.length > 0 && (
        <>
          <h2
            style={{
              fontSize: "1rem",
              color: "#8b949e",
              marginTop: "1.5rem",
              marginBottom: "0.7rem",
            }}
          >
            Other sessions
          </h2>
          {orphans.map((o) => (
            <a
              key={o.sid}
              href={`/sessions/${encodeURIComponent(o.sid)}/events`}
              style={{ textDecoration: "none" }}
            >
              <div
                style={{
                  padding: "0.5rem",
                  border: "1px solid #21262d",
                  borderRadius: "0.3rem",
                  marginBottom: "0.5rem",
                }}
              >
                <div style={{ color: "#58a6ff", fontWeight: 600, fontSize: "0.85rem" }}>
                  {o.sid.slice(0, SDK_SESSION_ID_SHORT)}
                </div>
                <div style={{ color: "#8b949e", fontSize: "0.8rem", marginTop: "0.2rem" }}>
                  {o.model && <>Model: {o.model} &middot; </>}
                  {o.eventCount} events
                </div>
              </div>
            </a>
          ))}
        </>
      )}
    </div>
  );
}
