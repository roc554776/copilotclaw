import { useCallback, useRef, useState } from "react";
import {
  fetchOriginalPrompts,
  fetchSessionPrompt,
  fetchStatus,
  type OriginalPrompt,
  type SessionPrompt,
  type StatusResponse,
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
  const [sessionPrompts, setSessionPrompts] = useState<
    Array<{ sessionId: string; data: SessionPrompt }>
  >([]);

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
  }, []);

  usePolling(refresh, 5000);

  const loadingPromptsRef = useRef(new Set<string>());
  const loadSessionPrompt = useCallback(async (sessionId: string) => {
    if (loadingPromptsRef.current.has(sessionId)) return;
    loadingPromptsRef.current.add(sessionId);
    try {
      const data = await fetchSessionPrompt(sessionId);
      if (data) {
        setSessionPrompts((prev) => {
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

              {Object.entries(status.agent.sessions).length > 0 && (
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
                                System Prompt
                              </span>
                              <span>
                                <a
                                  href="#"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    loadSessionPrompt(
                                      sess.physicalSession!
                                        .sessionId,
                                    );
                                  }}
                                >
                                  View &rarr;
                                </a>
                              </span>
                            </div>
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
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                      </div>
                    ),
                  )}
                </div>
              )}
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

      {sessionPrompts.map((sp) => (
        <div key={sp.sessionId} style={sectionStyle}>
          <div style={titleStyle}>
            Session System Prompt ({sp.data.model})
          </div>
          <pre style={preStyle}>{sp.data.prompt}</pre>
        </div>
      ))}
    </div>
  );
}
