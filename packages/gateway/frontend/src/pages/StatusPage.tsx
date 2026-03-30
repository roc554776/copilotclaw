import { useCallback, useRef, useState } from "react";
import {
  fetchModels,
  fetchOriginalPrompts,
  fetchEffectivePrompt,
  fetchStatus,
  fetchTokenUsage,
  type EffectivePrompt,
  type OriginalPrompt,
  type StatusResponse,
  type TokenUsageEntry,
} from "../api";
import { usePolling } from "../hooks/usePolling";
import { elapsed, SESSION_ID_SHORT, SDK_SESSION_ID_SHORT } from "../utils";

const sectionStyle: React.CSSProperties = {
  marginBottom: "1rem",
  padding: "0.75rem",
  border: "1px solid #30363d",
  borderRadius: "0.5rem",
};
const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: "0.5rem",
  color: "#8b949e",
  fontSize: "0.85rem",
  textTransform: "uppercase",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "0.2rem 0",
  fontSize: "0.85rem",
};
const labelStyle: React.CSSProperties = { color: "#8b949e" };
const preStyle: React.CSSProperties = {
  background: "#161b22",
  padding: "0.75rem",
  borderRadius: "0.5rem",
  overflowX: "auto",
  fontSize: "0.8rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 400,
  overflowY: "auto",
};

function CumulativeTokens({
  sess,
}: {
  sess: {
    cumulativeInputTokens?: number;
    cumulativeOutputTokens?: number;
    physicalSession?: {
      totalInputTokens?: number;
      totalOutputTokens?: number;
    };
  };
}) {
  if (
    sess.cumulativeInputTokens == null &&
    sess.cumulativeOutputTokens == null
  )
    return null;
  const cIn =
    (sess.cumulativeInputTokens ?? 0) +
    (sess.physicalSession?.totalInputTokens ?? 0);
  const cOut =
    (sess.cumulativeOutputTokens ?? 0) +
    (sess.physicalSession?.totalOutputTokens ?? 0);
  if (cIn === 0 && cOut === 0) return null;
  return (
    <div
      style={{
        marginLeft: "1rem",
        fontSize: "0.8rem",
        color: "#8b949e",
      }}
    >
      <div style={rowStyle}>
        <span style={labelStyle}>Cumulative tokens</span>
        <span>
          in: {cIn} / out: {cOut} / total: {cIn + cOut}
        </span>
      </div>
    </div>
  );
}

export function StatusPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalPrompts, setOriginalPrompts] = useState<OriginalPrompt[]>(
    [],
  );
  const [effectivePrompts, setEffectivePrompts] = useState<
    Array<{ sessionId: string; data: EffectivePrompt }>
  >([]);
  const [tokenUsage5h, setTokenUsage5h] = useState<TokenUsageEntry[]>([]);
  const [tokenUsagePeriods, setTokenUsagePeriods] = useState<Array<{ label: string; data: TokenUsageEntry[] }>>([]);
  const [modelMultipliers, setModelMultipliers] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    try {
      const prompts = await fetchOriginalPrompts();
      setOriginalPrompts(prompts);
    } catch {
      /* ignore */
    }
    try {
      const usage = await fetchTokenUsage(5);
      setTokenUsage5h(usage);
    } catch {
      /* ignore */
    }
    try {
      const models = await fetchModels();
      if (models) {
        const m: Record<string, number> = {};
        for (const model of models.models) {
          m[model.id] = model.billing?.multiplier ?? 0;
        }
        setModelMultipliers(m);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Period breakdown: 1h, 6h, 24h, 7d — polled at 60s (changes slowly)
  const refreshPeriods = useCallback(async () => {
    try {
      const now = new Date();
      const periods = [
        { label: "1h", ms: 3600_000 },
        { label: "6h", ms: 6 * 3600_000 },
        { label: "24h", ms: 24 * 3600_000 },
        { label: "7d", ms: 7 * 24 * 3600_000 },
      ];
      const results = await Promise.all(
        periods.map(async (p) => {
          const from = new Date(now.getTime() - p.ms).toISOString();
          const data = await fetchTokenUsage(undefined, from, now.toISOString());
          return { label: p.label, data };
        }),
      );
      setTokenUsagePeriods(results);
    } catch {
      /* ignore */
    }
  }, []);

  usePolling(refresh, 5000);
  usePolling(refreshPeriods, 60000);

  const loadingPromptsRef = useRef(new Set<string>());
  const loadEffectivePrompt = useCallback(async (sessionId: string) => {
    if (loadingPromptsRef.current.has(sessionId)) return;
    loadingPromptsRef.current.add(sessionId);
    try {
      const data = await fetchEffectivePrompt(sessionId);
      if (data) {
        setEffectivePrompts((prev) => {
          if (prev.some((sp) => sp.sessionId === sessionId)) return prev;
          return [...prev, { sessionId, data }];
        });
      }
    } finally {
      loadingPromptsRef.current.delete(sessionId);
    }
  }, []);

  return (
    <div style={{ padding: "1rem", maxWidth: 800, margin: "0 auto" }}>
      <a href="/" style={{ marginBottom: "1rem", display: "inline-block" }}>
        &larr; Back to chat
      </a>
      <h1
        style={{
          fontSize: "1.2rem",
          color: "#58a6ff",
          marginBottom: "1rem",
        }}
      >
        System Status
      </h1>

      {error && (
        <div style={sectionStyle}>Error loading status: {error}</div>
      )}

      {status && (
        <>
          <div style={sectionStyle}>
            <div style={titleStyle}>Gateway</div>
            <div style={rowStyle}>
              <span style={labelStyle}>Status</span>
              <span>{status.gateway.status}</span>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Version</span>
              <span>{status.gateway.version}</span>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Profile</span>
              <span>{status.gateway.profile ?? "default"}</span>
            </div>
          </div>

          {status.agent ? (
            <>
              <div style={sectionStyle}>
                <div style={titleStyle}>Agent</div>
                <div style={rowStyle}>
                  <span style={labelStyle}>Version</span>
                  <span>{status.agent.version ?? "?"}</span>
                </div>
                <div style={rowStyle}>
                  <span style={labelStyle}>Started</span>
                  <span>{status.agent.startedAt ?? "?"}</span>
                </div>
                <div style={rowStyle}>
                  <span style={labelStyle}>Compatibility</span>
                  <span>{status.agentCompatibility}</span>
                </div>
              </div>

              <div style={sectionStyle}>
                  <div style={titleStyle}>
                    Sessions{" "}
                    <a
                      href="/sessions"
                      style={{
                        fontWeight: "normal",
                        textTransform: "none",
                      }}
                    >
                      All sessions &rarr;
                    </a>
                  </div>
                  {Object.entries(status.agent.sessions).length === 0 && (
                    <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
                      No active sessions.
                    </div>
                  )}
                  {Object.entries(status.agent.sessions).map(
                    ([id, sess]) => (
                      <div key={id} style={{ marginBottom: "0.5rem" }}>
                        <div style={rowStyle}>
                          <span style={labelStyle}>
                            {id.slice(0, SESSION_ID_SHORT)}
                            {sess.boundChannelId
                              ? ` → ch:${sess.boundChannelId.slice(0, SESSION_ID_SHORT)}`
                              : ""}
                          </span>
                          <span>{sess.status}</span>
                        </div>
                        {sess.startedAt && (
                          <div
                            style={{
                              marginLeft: "1rem",
                              fontSize: "0.8rem",
                              color: "#8b949e",
                            }}
                          >
                            <div style={rowStyle}>
                              <span style={labelStyle}>
                                Session started
                              </span>
                              <span>
                                {sess.startedAt} (
                                {elapsed(sess.startedAt)})
                              </span>
                            </div>
                          </div>
                        )}
                        {sess.physicalSession && (
                          <div
                            style={{
                              marginLeft: "1rem",
                              fontSize: "0.8rem",
                              color: "#8b949e",
                            }}
                          >
                            <div style={rowStyle}>
                              <span style={labelStyle}>
                                SDK Session
                              </span>
                              <span>
                                {sess.physicalSession.sessionId.slice(
                                  0,
                                  SDK_SESSION_ID_SHORT,
                                )}
                              </span>
                            </div>
                            <div style={rowStyle}>
                              <span style={labelStyle}>Model</span>
                              <span>
                                {sess.physicalSession.model}
                              </span>
                            </div>
                            <div style={rowStyle}>
                              <span style={labelStyle}>State</span>
                              <span>
                                {sess.physicalSession.currentState}
                              </span>
                            </div>
                            {sess.physicalSession.currentTokens !=
                              null &&
                              sess.physicalSession.tokenLimit !=
                                null && (
                                <div style={rowStyle}>
                                  <span style={labelStyle}>
                                    Context
                                  </span>
                                  <span>
                                    {
                                      sess.physicalSession
                                        .currentTokens
                                    }{" "}
                                    /{" "}
                                    {
                                      sess.physicalSession.tokenLimit
                                    }{" "}
                                    (
                                    {Math.round(
                                      (sess.physicalSession
                                        .currentTokens /
                                        sess.physicalSession
                                          .tokenLimit) *
                                        100,
                                    )}
                                    %)
                                  </span>
                                </div>
                              )}
                            {(sess.physicalSession
                              .totalInputTokens != null ||
                              sess.physicalSession
                                .totalOutputTokens != null) && (
                              <div style={rowStyle}>
                                <span style={labelStyle}>
                                  Tokens used
                                </span>
                                <span>
                                  in:{" "}
                                  {sess.physicalSession
                                    .totalInputTokens ?? 0}{" "}
                                  / out:{" "}
                                  {sess.physicalSession
                                    .totalOutputTokens ?? 0}{" "}
                                  / total:{" "}
                                  {(sess.physicalSession
                                    .totalInputTokens ?? 0) +
                                    (sess.physicalSession
                                      .totalOutputTokens ?? 0)}
                                </span>
                              </div>
                            )}
                            <div style={rowStyle}>
                              <span style={labelStyle}>Started</span>
                              <span>
                                {sess.physicalSession.startedAt} (
                                {elapsed(
                                  sess.physicalSession.startedAt,
                                )}
                                )
                              </span>
                            </div>
                            <div style={rowStyle}>
                              <span style={labelStyle}>Events</span>
                              <span>
                                <a
                                  href={`/sessions/${encodeURIComponent(sess.physicalSession.sessionId)}/events`}
                                >
                                  View events &rarr;
                                </a>
                              </span>
                            </div>
                            <div style={rowStyle}>
                              <span style={labelStyle}>
                                Effective Prompt
                              </span>
                              <span>
                                {effectivePrompts.some((sp) => sp.sessionId === sess.physicalSession!.sessionId) ? (
                                  <a
                                    href="#"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      setEffectivePrompts((prev) => prev.filter((sp) => sp.sessionId !== sess.physicalSession!.sessionId));
                                    }}
                                  >
                                    Hide
                                  </a>
                                ) : (
                                  <a
                                    href="#"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      loadEffectivePrompt(
                                        sess.physicalSession!
                                          .sessionId,
                                      );
                                    }}
                                  >
                                    View &rarr;
                                  </a>
                                )}
                              </span>
                            </div>
                            {effectivePrompts
                              .filter((sp) => sp.sessionId === sess.physicalSession!.sessionId)
                              .map((sp) => (
                                <div key={sp.sessionId} style={{ marginTop: "0.5rem" }}>
                                  <pre style={preStyle}>{sp.data.prompt}</pre>
                                </div>
                              ))}
                          </div>
                        )}
                        <CumulativeTokens sess={sess} />
                        {sess.physicalSessionHistory &&
                          sess.physicalSessionHistory.length > 0 && (
                            <div
                              style={{
                                marginLeft: "1rem",
                                fontSize: "0.8rem",
                                marginTop: "0.3rem",
                              }}
                            >
                              <div
                                style={{
                                  color: "#8b949e",
                                  marginBottom: "0.3rem",
                                }}
                              >
                                Physical sessions (
                                {sess.physicalSessionHistory.length})
                              </div>
                              {sess.physicalSessionHistory.map(
                                (hps) => (
                                  <div
                                    key={hps.sessionId}
                                    style={{
                                      margin: "0.3rem 0",
                                      padding: "0.3rem",
                                      border: "1px solid #21262d",
                                      borderRadius: "0.3rem",
                                      color: "#8b949e",
                                    }}
                                  >
                                    <div style={rowStyle}>
                                      <span style={labelStyle}>
                                        SDK Session
                                      </span>
                                      <span>
                                        {hps.sessionId.slice(
                                          0,
                                          SDK_SESSION_ID_SHORT,
                                        )}
                                      </span>
                                    </div>
                                    <div style={rowStyle}>
                                      <span style={labelStyle}>
                                        Model
                                      </span>
                                      <span>{hps.model}</span>
                                    </div>
                                    <div style={rowStyle}>
                                      <span style={labelStyle}>
                                        State
                                      </span>
                                      <span>
                                        {hps.currentState ||
                                          "stopped"}
                                      </span>
                                    </div>
                                    {(hps.totalInputTokens != null ||
                                      hps.totalOutputTokens !=
                                        null) && (
                                      <div style={rowStyle}>
                                        <span style={labelStyle}>
                                          Tokens
                                        </span>
                                        <span>
                                          in:{" "}
                                          {hps.totalInputTokens ??
                                            0}{" "}
                                          / out:{" "}
                                          {hps.totalOutputTokens ??
                                            0}
                                        </span>
                                      </div>
                                    )}
                                    <div style={rowStyle}>
                                      <span style={labelStyle}>
                                        Started
                                      </span>
                                      <span>{hps.startedAt}</span>
                                    </div>
                                    <div style={rowStyle}>
                                      <span style={labelStyle}>
                                        Events
                                      </span>
                                      <span>
                                        <a
                                          href={`/sessions/${encodeURIComponent(hps.sessionId)}/events`}
                                        >
                                          View events &rarr;
                                        </a>
                                      </span>
                                    </div>
                                    <div style={rowStyle}>
                                      <span style={labelStyle}>
                                        Effective Prompt
                                      </span>
                                      <span>
                                        {effectivePrompts.some((sp) => sp.sessionId === hps.sessionId) ? (
                                          <a
                                            href="#"
                                            onClick={(e) => {
                                              e.preventDefault();
                                              setEffectivePrompts((prev) => prev.filter((sp) => sp.sessionId !== hps.sessionId));
                                            }}
                                          >
                                            Hide
                                          </a>
                                        ) : (
                                          <a
                                            href="#"
                                            onClick={(e) => {
                                              e.preventDefault();
                                              loadEffectivePrompt(hps.sessionId);
                                            }}
                                          >
                                            View &rarr;
                                          </a>
                                        )}
                                      </span>
                                    </div>
                                    {effectivePrompts
                                      .filter((sp) => sp.sessionId === hps.sessionId)
                                      .map((sp) => (
                                        <div key={sp.sessionId} style={{ marginTop: "0.5rem" }}>
                                          <pre style={preStyle}>{sp.data.prompt}</pre>
                                        </div>
                                      ))}
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                      </div>
                    ),
                  )}
                </div>
            </>
          ) : (
            <div style={sectionStyle}>
              <div style={titleStyle}>Agent</div>
              <div style={rowStyle}>
                <span style={labelStyle}>Not running</span>
              </div>
            </div>
          )}

          {status.config && (
            <div style={sectionStyle}>
              <div style={titleStyle}>Config</div>
              <div style={rowStyle}>
                <span style={labelStyle}>Model</span>
                <span>{status.config.model ?? "(auto)"}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Zero Premium</span>
                <span>{String(status.config.zeroPremium)}</span>
              </div>
            </div>
          )}
        </>
      )}

      <div style={sectionStyle}>
        <div style={titleStyle}>
          Original System Prompts (from Copilot SDK)
        </div>
        {originalPrompts.length === 0 ? (
          <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
            No prompts captured yet. Prompts are captured when a physical session starts.
          </div>
        ) : (
          originalPrompts.map((p) => (
            <div
              key={`${p.model}-${p.capturedAt}`}
              style={{ marginTop: "0.5rem" }}
            >
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "#8b949e",
                  marginBottom: "0.3rem",
                }}
              >
                Model: {p.model} -- Captured: {p.capturedAt}
              </div>
              <pre style={preStyle}>{p.prompt}</pre>
            </div>
          ))
        )}
      </div>

      {/* Token Consumption */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Token Consumption</div>

        <div style={{ marginBottom: "1rem" }}>
          <div style={{ ...rowStyle, fontWeight: 600, marginBottom: "0.3rem" }}>
            <span style={labelStyle}>Last 5h — Consumption Index</span>
            <span>{computeIndex(tokenUsage5h, modelMultipliers).toLocaleString()}</span>
          </div>
          {tokenUsage5h.length > 0 ? (
            <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "#8b949e", textAlign: "left" }}>
                  <th style={{ padding: "0.2rem 0.5rem" }}>Model</th>
                  <th style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>Input</th>
                  <th style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>Output</th>
                  <th style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>Total</th>
                  <th style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>Multiplier</th>
                </tr>
              </thead>
              <tbody>
                {tokenUsage5h.map((u) => (
                  <tr key={u.model} style={{ borderTop: "1px solid #21262d" }}>
                    <td style={{ padding: "0.2rem 0.5rem", color: "#58a6ff" }}>{u.model}</td>
                    <td style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>{u.inputTokens.toLocaleString()}</td>
                    <td style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>{u.outputTokens.toLocaleString()}</td>
                    <td style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>{(u.inputTokens + u.outputTokens).toLocaleString()}</td>
                    <td style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>x{Math.max(modelMultipliers[u.model] ?? 0, 0.1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: "#8b949e", fontSize: "0.8rem" }}>No token usage data in the last 5 hours.</div>
          )}
        </div>

        <div>
            <div style={{ ...rowStyle, fontWeight: 600, marginBottom: "0.3rem" }}>
              <span style={labelStyle}>By Period</span>
            </div>
            <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "#8b949e", textAlign: "left" }}>
                  <th style={{ padding: "0.2rem 0.5rem" }}>Period</th>
                  <th style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>Index</th>
                  <th style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>Total Tokens</th>
                  <th style={{ padding: "0.2rem 0.5rem" }}>Models</th>
                </tr>
              </thead>
              <tbody>
                {tokenUsagePeriods.map((p) => {
                  const totalTokens = p.data.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
                  return (
                    <tr key={p.label} style={{ borderTop: "1px solid #21262d" }}>
                      <td style={{ padding: "0.2rem 0.5rem" }}>{p.label}</td>
                      <td style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>{computeIndex(p.data, modelMultipliers).toLocaleString()}</td>
                      <td style={{ padding: "0.2rem 0.5rem", textAlign: "right" }}>{totalTokens.toLocaleString()}</td>
                      <td style={{ padding: "0.2rem 0.5rem", color: "#8b949e" }}>
                        {p.data.map((u) => `${u.model}: ${(u.inputTokens + u.outputTokens).toLocaleString()}`).join(", ") || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
      </div>

    </div>
  );
}

/**
 * Token consumption index = SUM over models { MAX(billing.multiplier, 0.1) * totalTokens }
 * where totalTokens = inputTokens + outputTokens for each model.
 */
function computeIndex(usage: TokenUsageEntry[], multipliers: Record<string, number>): number {
  let index = 0;
  for (const u of usage) {
    const mult = Math.max(multipliers[u.model] ?? 0, 0.1);
    index += mult * (u.inputTokens + u.outputTokens);
  }
  return Math.round(index);
}
