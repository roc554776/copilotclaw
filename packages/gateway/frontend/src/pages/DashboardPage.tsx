import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createChannel,
  fetchChannels,
  fetchLogs,
  fetchMessages,
  fetchModels,
  fetchQuota,
  fetchStatus,
  sendMessage,
  type Channel,
  type LogEntry,
  type Message,
  type ModelsResponse,
  type QuotaResponse,
  type StatusResponse,
} from "../api";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { usePolling } from "../hooks/usePolling";

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [sessionStatus, setSessionStatus] = useState("--");
  const [gatewayVersion, setGatewayVersion] = useState("--");
  const [agentVersion, setAgentVersion] = useState("--");
  const [compatibility, setCompatibility] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [modalStatus, setModalStatus] = useState<StatusResponse | null>(null);
  const [modalQuota, setModalQuota] = useState<QuotaResponse | null>(null);
  const [modalModels, setModalModels] = useState<ModelsResponse | null>(null);
  const [logsVisible, setLogsVisible] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const evtSourceRef = useRef<EventSource | null>(null);
  const refreshStatusRef = useRef<() => void>(() => {});

  const activeChannelId = searchParams.get("channel") ?? channels[0]?.id;

  const { containerRef: chatRef, handleScroll: handleChatScroll } = useAutoScroll<HTMLDivElement>([
    messages,
  ]);

  // Load channels on mount
  useEffect(() => {
    fetchChannels()
      .then(setChannels)
      .catch(() => {});
  }, []);

  // Load messages when active channel changes
  const refreshMessages = useCallback(async () => {
    if (!activeChannelId) return;
    try {
      const msgs = await fetchMessages(activeChannelId, 500);
      // API returns reverse-chronological; reverse for display
      setMessages(msgs.slice().reverse());
    } catch {
      /* ignore */
    }
  }, [activeChannelId]);

  useEffect(() => {
    refreshMessages();
  }, [refreshMessages]);

  // SSE connection
  useEffect(() => {
    if (!activeChannelId) return;

    const source = new EventSource(`/api/events?channel=${encodeURIComponent(activeChannelId)}`);
    evtSourceRef.current = source;

    source.onopen = () => setSseConnected(true);
    source.onerror = () => setSseConnected(false);
    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as { type: string; data?: Record<string, unknown> };
        if (event.type === "new_message") {
          refreshMessages();
          refreshStatusRef.current();
        } else if (event.type === "status_update") {
          const d = event.data;
          if (d) {
            setGatewayVersion(String(d["gatewayVersion"] ?? "--"));
            setAgentVersion(String(d["agentVersion"] ?? "--"));
            setSessionStatus(String(d["sessionStatus"] ?? "--"));
            setCompatibility(String(d["compatibility"] ?? ""));
          }
        }
      } catch {
        /* ignore parse errors */
      }
    };

    return () => {
      source.close();
      evtSourceRef.current = null;
      setSseConnected(false);
    };
  }, [activeChannelId, refreshMessages]);

  // Poll status every 5 seconds
  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setGatewayVersion(data.gateway.version);
      if (data.agent) {
        setAgentVersion(data.agent.version ?? "--");
        const sessions = Object.values(data.agent.sessions);
        const bound = sessions.find((s) => s.boundChannelId === activeChannelId);
        setSessionStatus(
          bound ? bound.status : sessions.length > 0 ? "other channel" : "no session",
        );
      } else {
        setAgentVersion("--");
        setSessionStatus("no session");
      }
      setCompatibility(data.agentCompatibility);
    } catch {
      /* ignore */
    }
  }, [activeChannelId]);

  refreshStatusRef.current = refreshStatus;

  usePolling(refreshStatus, 5000);

  // Logs polling when visible
  const refreshLogs = useCallback(async () => {
    try {
      setLogs(await fetchLogs(100));
    } catch {
      /* ignore */
    }
  }, []);

  usePolling(refreshLogs, 3000, logsVisible);

  // Send message
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !activeChannelId) return;
    setSending(true);
    setInputText("");
    try {
      await sendMessage(activeChannelId, text);
      await refreshMessages();
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [inputText, activeChannelId, refreshMessages]);

  // Open status modal
  const openModal = useCallback(async () => {
    setShowModal(true);
    try {
      const [status, quota, models] = await Promise.all([
        fetchStatus(),
        fetchQuota(),
        fetchModels(),
      ]);
      setModalStatus(status);
      setModalQuota(quota);
      setModalModels(models);
    } catch {
      /* ignore */
    }
  }, []);

  // Create new channel
  const handleNewChannel = useCallback(async () => {
    try {
      const ch = await createChannel();
      setChannels((prev) => [...prev, ch]);
      setSearchParams({ channel: ch.id });
    } catch {
      /* ignore */
    }
  }, [setSearchParams]);

  const compatLabel = compatibility && compatibility !== "compatible" ? ` [${compatibility}]` : "";
  const isProcessing = sessionStatus === "processing";

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Status Bar */}
      <div
        style={{
          padding: "0.3rem 1rem",
          background: "#161b22",
          borderBottom: "1px solid #30363d",
          fontSize: "0.75rem",
          color: "#8b949e",
          cursor: "pointer",
          userSelect: "none",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
        onClick={openModal}
      >
        <span>
          <span
            role="status"
            aria-label={sseConnected ? "SSE connected" : "SSE disconnected"}
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              marginRight: "0.4rem",
              verticalAlign: "middle",
              background: sseConnected ? "#3fb950" : "#f85149",
            }}
          />
          gateway: v{gatewayVersion} | agent: v{agentVersion}
          {compatLabel} | session: {sessionStatus}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setLogsVisible((v) => !v);
          }}
          style={{
            background: "none",
            border: "1px solid #30363d",
            borderRadius: "0.3rem",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: "0.7rem",
            padding: "0.1rem 0.4rem",
          }}
        >
          Logs
        </button>
      </div>

      {/* Logs Panel */}
      {logsVisible && (
        <div
          style={{
            maxHeight: "40vh",
            background: "#0d1117",
            borderBottom: "1px solid #30363d",
            overflowY: "auto",
            fontFamily: "monospace",
            fontSize: "0.75rem",
            padding: "0.5rem",
          }}
        >
          {logs.map((entry, i) => (
            <div
              key={i}
              style={{
                padding: "0.1rem 0",
                color: entry.level === "error" ? "#f85149" : "#8b949e",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              <span style={{ color: "#484f58", marginRight: "0.5rem" }}>
                {entry.timestamp?.slice(11, 19)}
              </span>
              <span style={{ color: "#58a6ff", marginRight: "0.5rem" }}>[{entry.source}]</span>
              {entry.message}
            </div>
          ))}
        </div>
      )}

      {/* Status Modal */}
      {showModal && (
        <>
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              background: "rgba(0,0,0,0.6)",
              zIndex: 100,
            }}
            onClick={() => setShowModal(false)}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "0.75rem",
              padding: "1.5rem",
              minWidth: 400,
              maxWidth: 600,
              maxHeight: "80vh",
              overflowY: "auto",
              zIndex: 101,
              color: "#c9d1d9",
              fontSize: "0.85rem",
            }}
          >
            <button
              onClick={() => setShowModal(false)}
              aria-label="Close modal"
              style={{
                position: "absolute",
                top: "0.75rem",
                right: "1rem",
                background: "none",
                border: "none",
                color: "#8b949e",
                cursor: "pointer",
                fontSize: "1.2rem",
              }}
            >
              &times;
            </button>
            <h3 style={{ marginBottom: "1rem", fontSize: "1rem", color: "#58a6ff" }}>
              System Status{" "}
              <a
                href="/status"
                style={{ fontSize: "0.8rem", fontWeight: "normal", marginLeft: "0.5rem" }}
              >
                Open in new tab &rarr;
              </a>
            </h3>
            {modalStatus ? (
              <StatusModalContent
                status={modalStatus}
                quota={modalQuota}
                models={modalModels}
              />
            ) : (
              <div>Loading...</div>
            )}
          </div>
        </>
      )}

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: "0.25rem",
          padding: "0.5rem 1rem 0",
          background: "#161b22",
          borderBottom: "1px solid #30363d",
          alignItems: "center",
        }}
      >
        {channels.map((ch) => {
          const isActive = ch.id === activeChannelId;
          return (
            <a
              key={ch.id}
              href={`/?channel=${ch.id}`}
              onClick={(e) => {
                e.preventDefault();
                setSearchParams({ channel: ch.id });
              }}
              style={{
                padding: "0.4rem 0.75rem",
                borderRadius: "0.4rem 0.4rem 0 0",
                background: "#0d1117",
                color: isActive ? "#58a6ff" : "#8b949e",
                textDecoration: "none",
                fontSize: "0.85rem",
                border: isActive ? "1px solid #30363d" : "none",
                borderBottom: isActive ? "1px solid #0d1117" : "none",
                marginBottom: isActive ? -1 : 0,
              }}
            >
              {ch.id.slice(0, 8)}
            </a>
          );
        })}
        <button
          onClick={handleNewChannel}
          aria-label="Create new channel"
          style={{
            padding: "0.4rem 0.6rem",
            background: "none",
            border: "1px dashed #30363d",
            borderRadius: "0.4rem",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          +
        </button>
      </div>

      {/* Chat Messages */}
      <div
        ref={chatRef}
        onScroll={handleChatScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: "#484f58", textAlign: "center", marginTop: "2rem" }}>
            Send a message to start the conversation.
          </div>
        )}
        {messages.map((msg) => {
          const isUser = msg.sender === "user";
          return (
            <div
              key={msg.id}
              style={{
                display: "flex",
                flexDirection: "column",
                maxWidth: "70%",
                alignSelf: isUser ? "flex-end" : "flex-start",
                alignItems: isUser ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  padding: "0.6rem 1rem",
                  borderRadius: "1rem",
                  lineHeight: 1.4,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background: isUser ? "#238636" : "#21262d",
                  color: isUser ? "#fff" : "#c9d1d9",
                  borderBottomRightRadius: isUser ? "0.25rem" : undefined,
                  borderBottomLeftRadius: !isUser ? "0.25rem" : undefined,
                }}
              >
                {msg.message}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#484f58", marginTop: "0.2rem" }}>
                {msg.createdAt}
              </div>
            </div>
          );
        })}
        {isProcessing && (
          <div
            style={{
              alignSelf: "flex-start",
              display: "flex",
              gap: "0.3rem",
              padding: "0.6rem 1rem",
              background: "#21262d",
              borderRadius: "1rem",
              borderBottomLeftRadius: "0.25rem",
              alignItems: "center",
            }}
          >
            <span className="typing-dot" style={{ animationDelay: "0s" }} />
            <span className="typing-dot" style={{ animationDelay: "0.2s" }} />
            <span className="typing-dot" style={{ animationDelay: "0.4s" }} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          padding: "0.75rem 1rem",
          borderTop: "1px solid #30363d",
          background: "#161b22",
        }}
      >
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message..."
          rows={1}
          style={{
            flex: 1,
            padding: "0.5rem 0.75rem",
            background: "#0d1117",
            color: "#c9d1d9",
            border: "1px solid #30363d",
            borderRadius: "0.5rem",
            fontFamily: "inherit",
            fontSize: "0.9rem",
            resize: "none",
            outline: "none",
          }}
        />
        <button
          onClick={handleSend}
          disabled={sending}
          style={{
            padding: "0.5rem 1.25rem",
            background: "#238636",
            color: "#fff",
            border: "none",
            borderRadius: "0.5rem",
            cursor: sending ? "default" : "pointer",
            fontSize: "0.9rem",
            opacity: sending ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>

      {/* Typing dots animation */}
      <style>{`
        .typing-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #8b949e;
          animation: typing 1.4s infinite;
          display: inline-block;
        }
        @keyframes typing {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}

function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "--";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function StatusModalContent({
  status,
  quota,
  models,
}: {
  status: StatusResponse;
  quota: QuotaResponse | null;
  models: ModelsResponse | null;
}) {
  const sectionStyle: React.CSSProperties = { marginBottom: "1rem" };
  const titleStyle: React.CSSProperties = {
    fontWeight: 600,
    color: "#8b949e",
    marginBottom: "0.3rem",
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    padding: "0.2rem 0",
  };
  const labelStyle: React.CSSProperties = { color: "#8b949e" };

  return (
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
      </div>

      {/* Agent */}
      {status.agent ? (
        <>
          <div style={sectionStyle}>
            <div style={titleStyle}>Agent</div>
            <div style={rowStyle}>
              <span style={labelStyle}>Version</span>
              <span>{status.agent.version ?? "--"}</span>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Started</span>
              <span>{status.agent.startedAt ?? "--"}</span>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Compatibility</span>
              <span>{status.agentCompatibility}</span>
            </div>
          </div>

          {/* Sessions */}
          {Object.entries(status.agent.sessions).length > 0 && (
            <div style={sectionStyle}>
              <div style={titleStyle}>
                Sessions ({Object.keys(status.agent.sessions).length}){" "}
                <a
                  href="/sessions"
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontWeight: "normal" }}
                >
                  All physical sessions &rarr;
                </a>
              </div>
              {Object.entries(status.agent.sessions).map(([id, sess]) => (
                <div key={id} style={{ marginBottom: "0.5rem" }}>
                  <div style={rowStyle}>
                    <span style={labelStyle}>
                      {id.slice(0, 8)}
                      {sess.boundChannelId ? ` → ch:${sess.boundChannelId.slice(0, 8)}` : ""}
                    </span>
                    <span>{sess.status}</span>
                  </div>
                  {sess.startedAt && (
                    <div
                      style={{ marginLeft: "1rem", fontSize: "0.8rem", color: "#8b949e" }}
                    >
                      <div style={rowStyle}>
                        <span style={labelStyle}>Session started</span>
                        <span>
                          {sess.startedAt} ({elapsed(sess.startedAt)})
                        </span>
                      </div>
                    </div>
                  )}
                  {sess.physicalSession && (
                    <div
                      style={{ marginLeft: "1rem", fontSize: "0.8rem", color: "#8b949e" }}
                    >
                      <div style={rowStyle}>
                        <span style={labelStyle}>SDK Session</span>
                        <span>{sess.physicalSession.sessionId.slice(0, 12)}</span>
                      </div>
                      <div style={rowStyle}>
                        <span style={labelStyle}>Model</span>
                        <span>{sess.physicalSession.model}</span>
                      </div>
                      <div style={rowStyle}>
                        <span style={labelStyle}>State</span>
                        <span>{sess.physicalSession.currentState}</span>
                      </div>
                      {sess.physicalSession.currentTokens != null &&
                        sess.physicalSession.tokenLimit != null && (
                          <div style={rowStyle}>
                            <span style={labelStyle}>Context</span>
                            <span>
                              {sess.physicalSession.currentTokens} /{" "}
                              {sess.physicalSession.tokenLimit} (
                              {Math.round(
                                (sess.physicalSession.currentTokens /
                                  sess.physicalSession.tokenLimit) *
                                  100,
                              )}
                              %)
                            </span>
                          </div>
                        )}
                      {(sess.physicalSession.totalInputTokens != null ||
                        sess.physicalSession.totalOutputTokens != null) && (
                        <div style={rowStyle}>
                          <span style={labelStyle}>Tokens used</span>
                          <span>
                            in: {sess.physicalSession.totalInputTokens ?? 0} / out:{" "}
                            {sess.physicalSession.totalOutputTokens ?? 0} / total:{" "}
                            {(sess.physicalSession.totalInputTokens ?? 0) +
                              (sess.physicalSession.totalOutputTokens ?? 0)}
                          </span>
                        </div>
                      )}
                      <div style={rowStyle}>
                        <span style={labelStyle}>Started</span>
                        <span>
                          {sess.physicalSession.startedAt} ({elapsed(sess.physicalSession.startedAt)}
                          )
                        </span>
                      </div>
                      <div style={{ marginTop: "0.3rem" }}>
                        <a
                          href={`/sessions/${encodeURIComponent(sess.physicalSession.sessionId)}/events`}
                        >
                          View events &rarr;
                        </a>
                      </div>
                    </div>
                  )}
                  {/* Cumulative tokens */}
                  {(sess.cumulativeInputTokens != null ||
                    sess.cumulativeOutputTokens != null) && (() => {
                    const cIn =
                      (sess.cumulativeInputTokens ?? 0) +
                      (sess.physicalSession?.totalInputTokens ?? 0);
                    const cOut =
                      (sess.cumulativeOutputTokens ?? 0) +
                      (sess.physicalSession?.totalOutputTokens ?? 0);
                    return cIn > 0 || cOut > 0 ? (
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
                    ) : null;
                  })()}
                  {/* Physical session history */}
                  {sess.physicalSessionHistory && sess.physicalSessionHistory.length > 0 && (
                    <div
                      style={{
                        marginLeft: "1rem",
                        fontSize: "0.8rem",
                        marginTop: "0.3rem",
                      }}
                    >
                      <div style={{ color: "#8b949e", marginBottom: "0.3rem" }}>
                        Physical sessions ({sess.physicalSessionHistory.length})
                      </div>
                      {sess.physicalSessionHistory.map((hps) => (
                        <div
                          key={hps.sessionId}
                          style={{
                            marginBottom: "0.5rem",
                            padding: "0.3rem",
                            border: "1px solid #21262d",
                            borderRadius: "0.3rem",
                            color: "#8b949e",
                          }}
                        >
                          <div style={rowStyle}>
                            <span style={labelStyle}>SDK Session</span>
                            <span>{hps.sessionId.slice(0, 12)}</span>
                          </div>
                          <div style={rowStyle}>
                            <span style={labelStyle}>Model</span>
                            <span>{hps.model}</span>
                          </div>
                          <div style={rowStyle}>
                            <span style={labelStyle}>State</span>
                            <span>{hps.currentState || "stopped"}</span>
                          </div>
                          {(hps.totalInputTokens != null || hps.totalOutputTokens != null) && (
                            <div style={rowStyle}>
                              <span style={labelStyle}>Tokens</span>
                              <span>
                                in: {hps.totalInputTokens ?? 0} / out:{" "}
                                {hps.totalOutputTokens ?? 0}
                              </span>
                            </div>
                          )}
                          <div style={rowStyle}>
                            <span style={labelStyle}>Started</span>
                            <span>{hps.startedAt}</span>
                          </div>
                          <div style={rowStyle}>
                            <span style={labelStyle}>Events</span>
                            <span>
                              <a
                                href={`/sessions/${encodeURIComponent(hps.sessionId)}/events`}
                              >
                                View events &rarr;
                              </a>
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
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

      {/* Quota */}
      {(() => {
        const snapshots = quota?.quotaSnapshots ?? {};
        const keys = Object.keys(snapshots);
        if (keys.length === 0) return null;
        return (
          <div style={sectionStyle}>
            <div style={titleStyle}>Premium Requests</div>
            {keys.map((key) => {
              const q = snapshots[key]!;
              const used = q.usedRequests ?? 0;
              const total = q.entitlementRequests ?? 0;
              return (
                <div key={key}>
                  <div style={rowStyle}>
                    <span style={labelStyle}>{key}</span>
                    <span>
                      {total - used} / {total}
                    </span>
                  </div>
                  {(q.overage ?? 0) > 0 && (
                    <div style={rowStyle}>
                      <span style={labelStyle}>Overage</span>
                      <span>{q.overage}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Models */}
      {models && models.models.length > 0 && (
        <div style={sectionStyle}>
          <div style={titleStyle}>Available Models</div>
          {models.models.map((m) => (
            <div key={m.id} style={rowStyle}>
              <span style={labelStyle}>{m.id}</span>
              <span>x{m.billing?.multiplier ?? "?"}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
