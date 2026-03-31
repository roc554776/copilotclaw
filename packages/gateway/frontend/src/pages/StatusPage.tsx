import { useCallback, useRef, useState } from "react";
import {
  fetchModels,
  fetchOriginalPrompts,
  fetchEffectivePrompt,
  fetchQuota,
  fetchStatus,
  fetchTokenUsage,
  type EffectivePrompt,
  type ModelsResponse,
  type OriginalPrompt,
  type QuotaResponse,
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
    Array<{ sessionId: string; data: EffectivePrompt | null }>
  >([]);
  const [tokenUsage5h, setTokenUsage5h] = useState<TokenUsageEntry[]>([]);
  const [tokenUsagePeriods, setTokenUsagePeriods] = useState<Array<{ label: string; data: TokenUsageEntry[] }>>([]);
  const [modelMultipliers, setModelMultipliers] = useState<Record<string, number>>({});
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const [githubQuotaExpanded, setGithubQuotaExpanded] = useState(false);
  const [githubModelsExpanded, setGithubModelsExpanded] = useState(false);

  const toggleSession = (id: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
        setModelsData(models);
      }
    } catch {
      /* ignore */
    }
    try {
      const q = await fetchQuota();
      setQuota(q);
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
      setEffectivePrompts((prev) => {
        if (prev.some((sp) => sp.sessionId === sessionId)) return prev;
        return [...prev, { sessionId, data }];
      });
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
          {/* Gateway */}
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

          {/* Agent */}
          {status.agent ? (
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
          ) : (
            <div style={sectionStyle}>
              <div style={titleStyle}>Agent</div>
              <div style={rowStyle}>
                <span style={labelStyle}>Not running</span>
              </div>
            </div>
          )}

          {/* Config */}
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

          {/* Quota */}
          <div style={sectionStyle}>
            <div style={titleStyle}>Premium Requests</div>

            {/* SDK (Copilot) */}
            <div style={{ fontSize: "0.75rem", color: "#58a6ff", marginBottom: "0.3rem" }}>SDK (Copilot)</div>
            {(() => {
              const snapshots = quota?.quotaSnapshots ?? {};
              const keys = Object.keys(snapshots);
              if (keys.length === 0) return <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>No data available.</div>;
              return keys.map((key) => {
                const q = snapshots[key]!;
                const used = q.usedRequests ?? 0;
                const total = q.entitlementRequests ?? 0;
                return (
                  <div key={key}>
                    <div style={rowStyle}>
                      <span style={labelStyle}>{key}</span>
                      <span>{total - used} / {total}</span>
                    </div>
                    {(q.overage ?? 0) > 0 && (
                      <div style={rowStyle}>
                        <span style={labelStyle}>Overage</span>
                        <span>{q.overage}</span>
                      </div>
                    )}
                  </div>
                );
              });
            })()}

            {/* GitHub API Usage */}
            <div style={{ marginTop: "0.5rem" }}>
              <div
                style={{ fontSize: "0.75rem", color: "#58a6ff", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.3rem" }}
                onClick={() => setGithubQuotaExpanded((p) => !p)}
              >
                GitHub API Usage {githubQuotaExpanded ? "\u25BE" : "\u25B8"}
              </div>
              {githubQuotaExpanded && (
                quota?.githubUsage === null || quota?.githubUsage === undefined ? (
                  <div style={{ color: "#8b949e", fontSize: "0.85rem", marginTop: "0.3rem" }}>GitHub API: unavailable</div>
                ) : (
                  <div style={{ marginTop: "0.3rem" }}>
                    <div style={{ ...rowStyle, fontSize: "0.8rem" }}>
                      <span style={labelStyle}>Billing period</span>
                      <span>{quota.githubUsage.timePeriod.year}-{String(quota.githubUsage.timePeriod.month).padStart(2, "0")}</span>
                    </div>
                    {quota.githubUsage.usageItems.length === 0 ? (
                      <div style={{ color: "#8b949e", fontSize: "0.8rem" }}>No usage items.</div>
                    ) : (
                      quota.githubUsage.usageItems.map((item, idx) => (
                        <div key={idx} style={{ ...rowStyle, fontSize: "0.8rem" }}>
                          <span style={labelStyle}>{item.model}</span>
                          <span>qty: {item.grossQuantity} @ ${item.pricePerUnit}/unit</span>
                        </div>
                      ))
                    )}
                  </div>
                )
              )}
            </div>
          </div>

          {/* Models */}
          <div style={sectionStyle}>
            <div style={titleStyle}>Available Models</div>

            {/* SDK (Copilot) */}
            <div style={{ fontSize: "0.75rem", color: "#58a6ff", marginBottom: "0.3rem" }}>SDK (Copilot)</div>
            {modelsData && modelsData.models.length > 0 ? (
              modelsData.models.map((m) => (
                <div key={m.id} style={rowStyle}>
                  <span style={labelStyle}>{m.id}</span>
                  <span>x{m.billing?.multiplier ?? "?"}</span>
                </div>
              ))
            ) : (
              <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>No data available.</div>
            )}

            {/* GitHub Models Catalog */}
            <div style={{ marginTop: "0.5rem" }}>
              <div
                style={{ fontSize: "0.75rem", color: "#58a6ff", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.3rem" }}
                onClick={() => setGithubModelsExpanded((p) => !p)}
              >
                GitHub Models Catalog {githubModelsExpanded ? "\u25BE" : "\u25B8"}
              </div>
              {githubModelsExpanded && (
                modelsData?.githubModels === null || modelsData?.githubModels === undefined ? (
                  <div style={{ color: "#8b949e", fontSize: "0.85rem", marginTop: "0.3rem" }}>GitHub API: unavailable</div>
                ) : (
                  <div style={{ marginTop: "0.3rem" }}>
                    <div style={{ color: "#8b949e", fontSize: "0.75rem", marginBottom: "0.3rem" }}>
                      Multipliers not available from this source.
                    </div>
                    {modelsData.githubModels.length === 0 ? (
                      <div style={{ color: "#8b949e", fontSize: "0.8rem" }}>No models.</div>
                    ) : (
                      modelsData.githubModels.map((m) => (
                        <div key={m.id} style={{ ...rowStyle, fontSize: "0.8rem" }}>
                          <span style={labelStyle}>{m.name}{m.publisher ? ` (${m.publisher})` : ""}</span>
                          <span style={{ color: "#8b949e", fontSize: "0.75rem" }}>{m.id}</span>
                        </div>
                      ))
                    )}
                  </div>
                )
              )}
            </div>
          </div>
        </>
      )}

      {/* Original System Prompts */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Original System Prompts (from Copilot SDK)</div>
        {originalPrompts.length === 0 ? (
          <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
            No prompts captured yet. Prompts are captured when a physical session starts.
          </div>
        ) : (
          originalPrompts.map((p) => {
            const key = `${p.model}-${p.capturedAt}`;
            const isExpanded = expandedPrompts.has(key);
            return (
              <div key={key} style={{ marginTop: "0.3rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "0.85rem", color: "#8b949e" }}>
                    {p.model} <span style={{ fontSize: "0.75rem" }}>({p.capturedAt})</span>
                  </span>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setExpandedPrompts((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key); else next.add(key);
                        return next;
                      });
                    }}
                    style={{ fontSize: "0.75rem", cursor: "pointer" }}
                  >
                    {isExpanded ? "Hide \u25BE" : "View \u25B8"}
                  </a>
                </div>
                {isExpanded && <pre style={preStyle}>{p.prompt}</pre>}
              </div>
            );
          })
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
                        {p.data.map((u) => `${u.model}: ${(u.inputTokens + u.outputTokens).toLocaleString()}`).join(", ") || "\u2014"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
      </div>

      {/* Sessions (LAST) */}
      {status?.agent && (
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
                      ? ` \u2192 ch:${sess.boundChannelId.slice(0, SESSION_ID_SHORT)}`
                      : ""}
                  </span>
                  <span>
                    {sess.status}{" "}
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); toggleSession(id); }}
                      style={{ cursor: "pointer", marginLeft: "0.5rem" }}
                    >
                      {expandedSessions.has(id) ? "Hide \u25BE" : "View \u25B8"}
                    </a>
                  </span>
                </div>
                {expandedSessions.has(id) && (
                  <>
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
                            {(() => {
                              const loaded = effectivePrompts.find((sp) => sp.sessionId === sess.physicalSession!.sessionId);
                              if (loaded === undefined) {
                                return <a href="#" onClick={(e) => { e.preventDefault(); loadEffectivePrompt(sess.physicalSession!.sessionId); }}>View &rarr;</a>;
                              }
                              if (loaded.data === null) {
                                return <span style={{ color: "#8b949e" }}>Not available</span>;
                              }
                              return <a href="#" onClick={(e) => { e.preventDefault(); setEffectivePrompts((prev) => prev.filter((sp) => sp.sessionId !== sess.physicalSession!.sessionId)); }}>Hide</a>;
                            })()}
                          </span>
                        </div>
                        {effectivePrompts
                          .filter((sp) => sp.sessionId === sess.physicalSession!.sessionId && sp.data !== null)
                          .map((sp) => (
                            <div key={sp.sessionId} style={{ marginTop: "0.5rem" }}>
                              <pre style={preStyle}>{sp.data!.prompt}</pre>
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
                                    {(() => {
                                      const loaded = effectivePrompts.find((sp) => sp.sessionId === hps.sessionId);
                                      if (loaded === undefined) {
                                        return <a href="#" onClick={(e) => { e.preventDefault(); loadEffectivePrompt(hps.sessionId); }}>View &rarr;</a>;
                                      }
                                      if (loaded.data === null) {
                                        return <span style={{ color: "#8b949e" }}>Not available</span>;
                                      }
                                      return <a href="#" onClick={(e) => { e.preventDefault(); setEffectivePrompts((prev) => prev.filter((sp) => sp.sessionId !== hps.sessionId)); }}>Hide</a>;
                                    })()}
                                  </span>
                                </div>
                                {effectivePrompts
                                  .filter((sp) => sp.sessionId === hps.sessionId && sp.data !== null)
                                  .map((sp) => (
                                    <div key={sp.sessionId} style={{ marginTop: "0.5rem" }}>
                                      <pre style={preStyle}>{sp.data!.prompt}</pre>
                                    </div>
                                  ))}
                              </div>
                            ),
                          )}
                        </div>
                      )}
                  </>
                )}
              </div>
            ),
          )}
        </div>
      )}

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
