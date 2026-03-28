import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSessionEvents, fetchSessionIds } from "../api";
import { SDK_SESSION_ID_SHORT } from "../utils";

const CONCURRENCY_LIMIT = 5;

interface SessionSummary {
  sid: string;
  eventCount: number;
  firstTime: string | null;
  lastTime: string | null;
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

export function SessionsListPage() {
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadSessions = useCallback(async (signal: AbortSignal) => {
    try {
      const sessionIds = await fetchSessionIds();
      if (signal.aborted) return;
      if (sessionIds.length === 0) {
        setSummaries([]);
        setLoading(false);
        return;
      }

      const results = await fetchWithConcurrencyLimit(
        sessionIds,
        async (sid) => {
          try {
            const events = await fetchSessionEvents(sid);
            const first = events[0] ?? null;
            const last = events[events.length - 1] ?? null;
            let model = "";
            for (const e of events) {
              if (
                e.type === "session.model_change" &&
                typeof (e.data as Record<string, unknown>)[
                  "newModel"
                ] === "string"
              ) {
                model = (e.data as Record<string, unknown>)[
                  "newModel"
                ] as string;
              }
              if (
                !model &&
                e.type === "assistant.usage" &&
                typeof (e.data as Record<string, unknown>)[
                  "model"
                ] === "string"
              ) {
                model = (e.data as Record<string, unknown>)[
                  "model"
                ] as string;
              }
            }
            return {
              sid,
              eventCount: events.length,
              firstTime: first?.timestamp ?? null,
              lastTime: last?.timestamp ?? null,
              model,
            };
          } catch {
            return {
              sid,
              eventCount: 0,
              firstTime: null,
              lastTime: null,
              model: "",
            };
          }
        },
        CONCURRENCY_LIMIT,
        signal,
      );

      if (signal.aborted) return;

      const valid: SessionSummary[] = [];
      for (const r of results) {
        if (r !== undefined) valid.push(r);
      }
      valid.sort((a, b) =>
        (b.lastTime ?? "").localeCompare(a.lastTime ?? ""),
      );
      setSummaries(valid);
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
    loadSessions(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadSessions]);

  return (
    <div
      style={{ padding: "1rem", maxWidth: 800, margin: "0 auto" }}
    >
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
        Physical Sessions
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
      {!loading && summaries.length === 0 && (
        <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
          No physical sessions recorded.
        </div>
      )}

      {summaries.map((s) => (
        <a
          key={s.sid}
          href={`/sessions/${encodeURIComponent(s.sid)}/events`}
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
            <div
              style={{
                color: "#58a6ff",
                fontWeight: 600,
                fontSize: "0.85rem",
              }}
            >
              {s.sid.slice(0, SDK_SESSION_ID_SHORT)}
            </div>
            <div
              style={{
                color: "#8b949e",
                fontSize: "0.8rem",
                marginTop: "0.2rem",
              }}
            >
              {s.model && <>Model: {s.model} &middot; </>}
              {s.eventCount} events
              {s.firstTime && (
                <>
                  {" "}
                  &middot; Started:{" "}
                  {new Date(s.firstTime).toLocaleString()}
                </>
              )}
              {s.lastTime && (
                <>
                  {" "}
                  &middot; Last:{" "}
                  {new Date(s.lastTime).toLocaleString()}
                </>
              )}
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
