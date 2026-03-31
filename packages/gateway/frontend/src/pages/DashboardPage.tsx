import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  archiveChannel,
  createChannel,
  fetchChannels,
  fetchCronJobs,
  fetchLogs,
  fetchMessages,
  fetchModels,
  fetchQuota,
  fetchStatus,
  endTurnRun,
  reloadCron,
  saveCronJobs,
  saveDraft,
  sendMessage,
  stopSession,
  unarchiveChannel,
  updateChannelModel,
  type Channel,
  type CronJobInput,
  type CronJobStatus,
  type LogEntry,
  type Message,
  type ModelEntry,
  type ModelsResponse,
  type QuotaResponse,
  type StatusResponse,
} from "../api";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { usePolling } from "../hooks/usePolling";
import { elapsed, SESSION_ID_SHORT, SDK_SESSION_ID_SHORT } from "../utils";

/* M-2: Hoisted style objects for StatusModalContent */
const modalSectionStyle: React.CSSProperties = { marginBottom: "1rem" };
const modalTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  color: "#8b949e",
  marginBottom: "0.3rem",
};
const modalRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "0.2rem 0",
};
const modalLabelStyle: React.CSSProperties = { color: "#8b949e" };

const INITIAL_MESSAGE_LIMIT = 50;

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(true);
  const loadingOlderRef = useRef(false);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);

  // Debounced draft save: aggregate changes over 1 second, send only the final value
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSaveDraft = useMemo(() => {
    return (channelId: string, text: string) => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = null;
        saveDraft(channelId, text || null).catch(() => {});
      }, 1000);
    };
  }, []);
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [channelSettingsId, setChannelSettingsId] = useState<string | null>(null);
  const [channelSettingsModels, setChannelSettingsModels] = useState<ModelEntry[]>([]);
  const [channelSettingsCron, setChannelSettingsCron] = useState<CronJobStatus[]>([]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const evtSourceRef = useRef<EventSource | null>(null);
  const refreshStatusRef = useRef<() => void>(() => {});
  const modalAbortRef = useRef<AbortController | null>(null);

  const activeChannelId = searchParams.get("channel") ?? channels[0]?.id;

  /* H-5: use stable primitive (messages.length) instead of messages array */
  const { containerRef: chatRef, handleScroll: handleChatScroll } =
    useAutoScroll<HTMLDivElement>([messages.length]);

  // Load channels on mount and when showArchived changes
  useEffect(() => {
    setLoading(true);
    fetchChannels({ includeArchived: showArchived })
      .then((chs) => {
        setChannels(chs);
        setLoadError(null);
      })
      .catch((e) => {
        setLoadError(String(e));
      })
      .finally(() => setLoading(false));
  }, [showArchived]);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const activeChannelRef = useRef(activeChannelId);

  // Reset messages and restore draft when channel changes
  useEffect(() => {
    if (activeChannelRef.current !== activeChannelId) {
      setMessages([]);
      setHasOlderMessages(true);
      activeChannelRef.current = activeChannelId;
      // Restore draft from channel data
      const ch = channels.find((c) => c.id === activeChannelId);
      setInputText(ch?.draft ?? "");
      if (inputRef.current) inputRef.current.style.height = "auto";
    }
  }, [activeChannelId, channels]);

  // H-1: capture activeChannelId in closure
  const refreshMessages = useCallback(async () => {
    const channelId = activeChannelId;
    if (!channelId) return;
    try {
      const current = messagesRef.current;
      if (current.length > 0 && current[0]!.channelId === channelId) {
        // Append only new messages (newer than the newest we have)
        const newest = current[current.length - 1]!;
        const fresh = await fetchMessages(channelId, INITIAL_MESSAGE_LIMIT);
        const freshReversed = fresh.slice().reverse();
        const newMsgs = freshReversed.filter((m) => m.createdAt > newest.createdAt || (m.createdAt === newest.createdAt && !current.some((c) => c.id === m.id)));
        if (newMsgs.length > 0) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const unique = newMsgs.filter((m) => !existingIds.has(m.id));
            return unique.length > 0 ? [...prev, ...unique] : prev;
          });
        }
      } else {
        const msgs = await fetchMessages(channelId, INITIAL_MESSAGE_LIMIT);
        setMessages(msgs.slice().reverse());
        setHasOlderMessages(msgs.length >= INITIAL_MESSAGE_LIMIT);
      }
    } catch {
      /* ignore */
    }
  }, [activeChannelId]);

  // Load older messages when scrolling up
  const loadOlderMessages = useCallback(async () => {
    const channelId = activeChannelId;
    if (!channelId || loadingOlderRef.current || !hasOlderMessages) return;
    const oldestMsg = messagesRef.current[0];
    if (!oldestMsg) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const el = chatRef.current;
      const prevScrollHeight = el?.scrollHeight ?? 0;

      const older = await fetchMessages(channelId, INITIAL_MESSAGE_LIMIT, oldestMsg.id);
      if (older.length === 0) {
        setHasOlderMessages(false);
      } else {
        // older is reverse-chronological; reverse and prepend
        setMessages((prev) => [...older.slice().reverse(), ...prev]);
        setHasOlderMessages(older.length >= INITIAL_MESSAGE_LIMIT);
        // Restore scroll position after prepending
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
  }, [activeChannelId, hasOlderMessages]);

  useEffect(() => {
    refreshMessages();
  }, [refreshMessages]);

  // SSE connection with auto-reconnect
  useEffect(() => {
    if (!activeChannelId) return;

    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (closed) return;
      const source = new EventSource(
        `/api/events?channel=${encodeURIComponent(activeChannelId)}`,
      );
      evtSourceRef.current = source;

      source.onopen = () => setSseConnected(true);
      source.onerror = () => {
        setSseConnected(false);
        source.close();
        evtSourceRef.current = null;
        // Auto-reconnect after 3 seconds
        if (!closed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
      source.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data as string) as {
            type: string;
            data?: Record<string, unknown>;
          };
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
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      evtSourceRef.current?.close();
      evtSourceRef.current = null;
      setSseConnected(false);
    };
  }, [activeChannelId, refreshMessages]);

  // Re-fetch messages when page becomes visible (mobile background recovery)
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshMessages();
        refreshStatusRef.current();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [refreshMessages]);

  // Poll status every 5 seconds
  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setGatewayVersion(data.gateway.version);
      if (data.agent) {
        setAgentVersion(data.agent.version ?? "--");
        const sessions = Object.values(data.agent.sessions);
        const bound = sessions.find(
          (s) => s.boundChannelId === activeChannelId,
        );
        setSessionStatus(
          bound
            ? bound.status
            : sessions.length > 0
              ? "other channel"
              : "no session",
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

  // H-2: keep ref in sync with latest refreshStatus
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
    if (inputRef.current) inputRef.current.style.height = "auto";
    // Clear draft immediately on send (cancel any pending debounce)
    if (draftTimerRef.current !== null) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
    saveDraft(activeChannelId, null).catch(() => {});
    try {
      await sendMessage(activeChannelId, text);
      await refreshMessages();
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [inputText, activeChannelId, refreshMessages]);

  // M-4: Open status modal with AbortController
  const openModal = useCallback(async () => {
    modalAbortRef.current?.abort();
    const controller = new AbortController();
    modalAbortRef.current = controller;

    setShowModal(true);
    setModalStatus(null);
    setModalQuota(null);
    setModalModels(null);
    try {
      const { signal } = controller;
      const [status, quota, models] = await Promise.all([
        fetchStatus(signal),
        fetchQuota(signal),
        fetchModels(signal),
      ]);
      if (controller.signal.aborted) return;
      setModalStatus(status);
      setModalQuota(quota);
      setModalModels(models);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (!controller.signal.aborted) {
        setModalStatus({ gateway: { status: "error", version: "—" }, agent: null, agentCompatibility: "unavailable", config: {} } as StatusResponse);
      }
    }
  }, []);

  const closeModal = useCallback(() => {
    modalAbortRef.current?.abort();
    modalAbortRef.current = null;
    setShowModal(false);
  }, []);

  // Abort modal fetch on unmount
  useEffect(() => {
    return () => {
      modalAbortRef.current?.abort();
    };
  }, []);

  const handleArchiveChannel = useCallback(async (channelId: string) => {
    try {
      const updated = await archiveChannel(channelId);
      setChannels((prev) =>
        showArchived
          ? prev.map((ch) => (ch.id === channelId ? updated : ch))
          : prev.filter((ch) => ch.id !== channelId),
      );
      if (activeChannelId === channelId) {
        setSearchParams({});
      }
    } catch { /* ignore */ }
  }, [showArchived, activeChannelId, setSearchParams]);

  const handleUnarchiveChannel = useCallback(async (channelId: string) => {
    try {
      const updated = await unarchiveChannel(channelId);
      setChannels((prev) => prev.map((ch) => (ch.id === channelId ? updated : ch)));
    } catch { /* ignore */ }
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

  const openChannelSettings = useCallback(async (channelId: string) => {
    const [models, cron, status] = await Promise.all([
      fetchModels().then((r) => r?.models ?? []).catch(() => [] as ModelEntry[]),
      fetchCronJobs().catch(() => [] as CronJobStatus[]),
      fetchStatus().catch(() => null),
    ]);
    setChannelSettingsModels(models);
    setChannelSettingsCron(cron.filter((j) => j.channelId === channelId));
    if (status !== null) setModalStatus(status);
    // Open modal after data is loaded so it renders with fresh status
    setChannelSettingsId(channelId);
  }, []);

  const closeChannelSettings = useCallback(() => {
    setChannelSettingsId(null);
  }, []);

  const handleChannelModelChange = useCallback(async (channelId: string, model: string | null) => {
    try {
      const updated = await updateChannelModel(channelId, model);
      setChannels((prev) => prev.map((ch) => (ch.id === channelId ? updated : ch)));
    } catch { /* ignore */ }
  }, []);

  const handleStopPhysicalSession = useCallback(async (sessionId: string) => {
    try {
      await stopSession(sessionId);
      refreshStatusRef.current();
    } catch { /* ignore */ }
  }, []);

  const handleEndTurnRun = useCallback(async (sessionId: string) => {
    try {
      await endTurnRun(sessionId);
      refreshStatusRef.current();
    } catch { /* ignore */ }
  }, []);

  const compatLabel =
    compatibility && compatibility !== "compatible"
      ? ` [${compatibility}]`
      : "";
  const isProcessing = sessionStatus === "processing";

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", maxWidth: "100vw", overflow: "hidden" }}>
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
          flexShrink: 0,
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
          aria-label="Toggle logs"
          aria-pressed={logsVisible}
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
              key={`${entry.timestamp}-${entry.source}-${i}`}
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
              <span style={{ color: "#58a6ff", marginRight: "0.5rem" }}>
                [{entry.source}]
              </span>
              {entry.message}
            </div>
          ))}
        </div>
      )}

      {/* Status Modal — L-3: role="dialog" and aria-modal="true" */}
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
            onClick={closeModal}
          />
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "0.75rem",
              padding: "1.5rem",
              minWidth: "min(400px, 90vw)",
              maxWidth: "min(600px, 95vw)",
              maxHeight: "80vh",
              overflowY: "auto",
              zIndex: 101,
              color: "#c9d1d9",
              fontSize: "0.85rem",
            }}
          >
            <button
              onClick={closeModal}
              aria-label="Close"
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
            <h3
              style={{
                marginBottom: "1rem",
                fontSize: "1rem",
                color: "#58a6ff",
              }}
            >
              System Status{" "}
              <a
                href="/status"
                style={{
                  fontSize: "0.8rem",
                  fontWeight: "normal",
                  marginLeft: "0.5rem",
                }}
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

      {/* Channel Settings Modal */}
      {channelSettingsId !== null && (
        <ChannelSettingsModal
          channelId={channelSettingsId}
          channel={channels.find((ch) => ch.id === channelSettingsId) ?? null}
          models={channelSettingsModels}
          cronJobs={channelSettingsCron}
          activeSession={(() => {
            if (!modalStatus?.agent?.sessions) return null;
            for (const s of Object.values(modalStatus.agent.sessions)) {
              if (s.boundChannelId === channelSettingsId && s.physicalSession) {
                return s.physicalSession;
              }
            }
            return null;
          })()}
          activeSessionId={(() => {
            if (!modalStatus?.agent?.sessions) return undefined;
            for (const [sid, s] of Object.entries(modalStatus.agent.sessions)) {
              if (s.boundChannelId === channelSettingsId && s.status !== "suspended") {
                return sid;
              }
            }
            return undefined;
          })()}
          sessionStatus={(() => {
            if (!modalStatus?.agent?.sessions) return undefined;
            for (const s of Object.values(modalStatus.agent.sessions)) {
              if (s.boundChannelId === channelSettingsId) return s.status;
            }
            return undefined;
          })()}
          onClose={closeChannelSettings}
          onModelChange={handleChannelModelChange}
          onStopSession={handleStopPhysicalSession}
          onEndTurnRun={handleEndTurnRun}
          onRefreshStatus={refreshStatusRef.current}
        />
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
          overflowX: "auto",
          flexShrink: 0,
          WebkitOverflowScrolling: "touch",
        }}
      >
        {channels.map((ch) => {
          const isActive = ch.id === activeChannelId;
          const isArchived = ch.archivedAt != null;
          return (
            <div
              key={ch.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.2rem",
                padding: "0.4rem 0.5rem",
                borderRadius: "0.4rem 0.4rem 0 0",
                background: "#0d1117",
                border: isActive ? "1px solid #30363d" : "none",
                borderBottom: isActive ? "1px solid #0d1117" : "none",
                marginBottom: isActive ? -1 : 0,
                flexShrink: 0,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
              onClick={() => setSearchParams({ channel: ch.id })}
            >
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  if (isActive) {
                    openChannelSettings(ch.id);
                  } else {
                    setSearchParams({ channel: ch.id });
                  }
                }}
                style={{
                  color: isArchived ? "#484f58" : isActive ? "#58a6ff" : "#8b949e",
                  textDecoration: isActive ? "underline" : "none",
                  textDecorationStyle: isActive ? ("dotted" as const) : undefined,
                  fontSize: "0.85rem",
                  fontStyle: isArchived ? "italic" : "normal",
                  cursor: isActive ? "pointer" : "default",
                }}
                title={isActive ? "Channel settings" : undefined}
              >
                {ch.id.slice(0, SESSION_ID_SHORT)}
              </span>
              <button
                onClick={() => isArchived ? handleUnarchiveChannel(ch.id) : handleArchiveChannel(ch.id)}
                title={isArchived ? "Unarchive" : "Archive"}
                style={{
                  background: "none",
                  border: "none",
                  color: "#484f58",
                  cursor: "pointer",
                  fontSize: "0.7rem",
                  padding: "0 0.2rem",
                  lineHeight: 1,
                }}
              >
                {isArchived ? "\u21A9" : "\u2716"}
              </button>
            </div>
          );
        })}
        <button
          onClick={handleNewChannel}
          aria-label="New channel"
          style={{
            padding: "0.4rem 0.6rem",
            background: "none",
            border: "1px dashed #30363d",
            borderRadius: "0.4rem",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: "0.85rem",
            flexShrink: 0,
          }}
        >
          +
        </button>
        <button
          onClick={() => setShowArchived((v) => !v)}
          title={showArchived ? "Hide archived" : "Show archived"}
          style={{
            padding: "0.4rem 0.6rem",
            background: showArchived ? "#161b22" : "none",
            border: "1px solid #30363d",
            borderRadius: "0.4rem",
            color: showArchived ? "#58a6ff" : "#8b949e",
            cursor: "pointer",
            fontSize: "0.75rem",
            flexShrink: 0,
          }}
        >
          {showArchived ? "All" : "Archived"}
        </button>
      </div>

      {/* Chat Messages — M-8: loading/error states */}
      <div
        ref={chatRef}
        onScroll={(e) => {
          handleChatScroll();
          // Load older messages when scrolled near top
          const el = e.currentTarget;
          if (el.scrollTop < 100 && hasOlderMessages && !loadingOlder) {
            loadOlderMessages();
          }
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        {loadingOlder && (
          <div style={{ color: "#8b949e", textAlign: "center", padding: "0.5rem" }}>
            Loading older messages...
          </div>
        )}
        {loading && (
          <div
            style={{
              color: "#8b949e",
              textAlign: "center",
              marginTop: "2rem",
            }}
          >
            Loading...
          </div>
        )}
        {loadError && (
          <div
            style={{
              color: "#f85149",
              textAlign: "center",
              marginTop: "2rem",
            }}
          >
            Failed to load: {loadError}
          </div>
        )}
        {!loading && !loadError && messages.length === 0 && (
          <div
            style={{
              color: "#484f58",
              textAlign: "center",
              marginTop: "2rem",
            }}
          >
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
                maxWidth: "min(70%, 90vw)",
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
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "#484f58",
                  marginTop: "0.2rem",
                }}
              >
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
            <span
              className="typing-dot"
              style={{ animationDelay: "0.2s" }}
            />
            <span
              className="typing-dot"
              style={{ animationDelay: "0.4s" }}
            />
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
          onChange={(e) => {
            const val = e.target.value;
            setInputText(val);
            if (activeChannelId) debouncedSaveDraft(activeChannelId, val);
            // Auto-resize textarea height
            const el = e.target;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.altKey || e.metaKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message... (Alt+Enter or Cmd+Enter to send)"
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
            overflow: "auto",
            maxHeight: "40vh",
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
    </div>
  );
}

/* M-5: Extracted helper component for cumulative tokens (replaces IIFE) */
function CumulativeTokens({
  sess,
  rowStyle,
  labelStyle,
}: {
  sess: {
    cumulativeInputTokens?: number;
    cumulativeOutputTokens?: number;
    physicalSession?: {
      totalInputTokens?: number;
      totalOutputTokens?: number;
    };
  };
  rowStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
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

/* M-5: Extracted helper component for quota section (replaces IIFE) */
function QuotaSection({
  quota,
  sectionStyle,
  titleStyle,
  rowStyle,
  labelStyle,
}: {
  quota: QuotaResponse | null;
  sectionStyle: React.CSSProperties;
  titleStyle: React.CSSProperties;
  rowStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
}) {
  const snapshots = quota?.quotaSnapshots ?? {};
  const keys = Object.keys(snapshots);
  return (
    <div style={sectionStyle}>
      <div style={titleStyle}>Premium Requests</div>
      {keys.length === 0 && (
        <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>No data available.</div>
      )}
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
  return (
    <>
      {/* Gateway */}
      <div style={modalSectionStyle}>
        <div style={modalTitleStyle}>Gateway</div>
        <div style={modalRowStyle}>
          <span style={modalLabelStyle}>Status</span>
          <span>{status.gateway.status}</span>
        </div>
        <div style={modalRowStyle}>
          <span style={modalLabelStyle}>Version</span>
          <span>{status.gateway.version}</span>
        </div>
      </div>

      {/* Agent */}
      {status.agent ? (
        <>
          <div style={modalSectionStyle}>
            <div style={modalTitleStyle}>Agent</div>
            <div style={modalRowStyle}>
              <span style={modalLabelStyle}>Version</span>
              <span>{status.agent.version ?? "--"}</span>
            </div>
            <div style={modalRowStyle}>
              <span style={modalLabelStyle}>Started</span>
              <span>{status.agent.startedAt ?? "--"}</span>
            </div>
            <div style={modalRowStyle}>
              <span style={modalLabelStyle}>Compatibility</span>
              <span>{status.agentCompatibility}</span>
            </div>
          </div>

          {/* Sessions */}
          <div style={modalSectionStyle}>
              <div style={modalTitleStyle}>
                Sessions ({Object.keys(status.agent.sessions).length}){" "}
                <a
                  href="/sessions"
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontWeight: "normal" }}
                >
                  All sessions &rarr;
                </a>
              </div>
              {Object.entries(status.agent.sessions).length === 0 && (
                <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
                  No active sessions.
                </div>
              )}
              {Object.entries(status.agent.sessions).map(([id, sess]) => (
                <div key={id} style={{ marginBottom: "0.5rem" }}>
                  <div style={modalRowStyle}>
                    <span style={modalLabelStyle}>
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
                      <div style={modalRowStyle}>
                        <span style={modalLabelStyle}>Session started</span>
                        <span>
                          {sess.startedAt} ({elapsed(sess.startedAt)})
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
                      <div style={modalRowStyle}>
                        <span style={modalLabelStyle}>SDK Session</span>
                        <span>
                          {sess.physicalSession.sessionId.slice(
                            0,
                            SDK_SESSION_ID_SHORT,
                          )}
                        </span>
                      </div>
                      <div style={modalRowStyle}>
                        <span style={modalLabelStyle}>Model</span>
                        <span>{sess.physicalSession.model}</span>
                      </div>
                      <div style={modalRowStyle}>
                        <span style={modalLabelStyle}>State</span>
                        <span>{sess.physicalSession.currentState}</span>
                      </div>
                      {sess.physicalSession.currentTokens != null &&
                        sess.physicalSession.tokenLimit != null && (
                          <div style={modalRowStyle}>
                            <span style={modalLabelStyle}>Context</span>
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
                        <div style={modalRowStyle}>
                          <span style={modalLabelStyle}>Tokens used</span>
                          <span>
                            in: {sess.physicalSession.totalInputTokens ?? 0} /
                            out:{" "}
                            {sess.physicalSession.totalOutputTokens ?? 0} /
                            total:{" "}
                            {(sess.physicalSession.totalInputTokens ?? 0) +
                              (sess.physicalSession.totalOutputTokens ?? 0)}
                          </span>
                        </div>
                      )}
                      <div style={modalRowStyle}>
                        <span style={modalLabelStyle}>Started</span>
                        <span>
                          {sess.physicalSession.startedAt} (
                          {elapsed(sess.physicalSession.startedAt)})
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
                  <CumulativeTokens
                    sess={sess}
                    rowStyle={modalRowStyle}
                    labelStyle={modalLabelStyle}
                  />
                  {/* Physical session history */}
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
                            <div style={modalRowStyle}>
                              <span style={modalLabelStyle}>SDK Session</span>
                              <span>
                                {hps.sessionId.slice(0, SDK_SESSION_ID_SHORT)}
                              </span>
                            </div>
                            <div style={modalRowStyle}>
                              <span style={modalLabelStyle}>Model</span>
                              <span>{hps.model}</span>
                            </div>
                            <div style={modalRowStyle}>
                              <span style={modalLabelStyle}>State</span>
                              <span>{hps.currentState || "stopped"}</span>
                            </div>
                            {(hps.totalInputTokens != null ||
                              hps.totalOutputTokens != null) && (
                              <div style={modalRowStyle}>
                                <span style={modalLabelStyle}>Tokens</span>
                                <span>
                                  in: {hps.totalInputTokens ?? 0} / out:{" "}
                                  {hps.totalOutputTokens ?? 0}
                                </span>
                              </div>
                            )}
                            <div style={modalRowStyle}>
                              <span style={modalLabelStyle}>Started</span>
                              <span>{hps.startedAt}</span>
                            </div>
                            <div style={modalRowStyle}>
                              <span style={modalLabelStyle}>Events</span>
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
        </>
      ) : (
        <div style={modalSectionStyle}>
          <div style={modalTitleStyle}>Agent</div>
          <div style={modalRowStyle}>
            <span style={modalLabelStyle}>Not running</span>
          </div>
        </div>
      )}

      <QuotaSection
        quota={quota}
        sectionStyle={modalSectionStyle}
        titleStyle={modalTitleStyle}
        rowStyle={modalRowStyle}
        labelStyle={modalLabelStyle}
      />

      {/* Models */}
      <div style={modalSectionStyle}>
        <div style={modalTitleStyle}>Available Models</div>
        {models && models.models.length > 0 ? (
          models.models.map((m) => (
            <div key={m.id} style={modalRowStyle}>
              <span style={modalLabelStyle}>{m.id}</span>
              <span>x{m.billing?.multiplier ?? "?"}</span>
            </div>
          ))
        ) : (
          <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>No data available.</div>
        )}
      </div>
    </>
  );
}

function ChannelSettingsModal({
  channelId,
  channel,
  models,
  cronJobs,
  activeSession,
  activeSessionId,
  onClose,
  onModelChange,
  onStopSession,
  onEndTurnRun,
  onRefreshStatus,
  sessionStatus,
}: {
  channelId: string;
  channel: Channel | null;
  models: ModelEntry[];
  cronJobs: CronJobStatus[];
  activeSession: { model: string } | null;
  activeSessionId?: string;
  sessionStatus?: string;
  onClose: () => void;
  onModelChange: (channelId: string, model: string | null) => Promise<void>;
  onStopSession: (sessionId: string) => Promise<void>;
  onEndTurnRun: (sessionId: string) => Promise<void>;
  onRefreshStatus: () => void;
}) {
  const [selectedModel, setSelectedModel] = useState<string>(channel?.model ?? "");
  const [saving, setSaving] = useState(false);
  const [editingCron, setEditingCron] = useState<CronJobInput[]>(
    cronJobs.map((j) => ({ id: j.id, channelId: j.channelId, intervalMs: j.intervalMs, message: j.message, disabled: j.disabled ? true : undefined })),
  );
  const [cronSaving, setCronSaving] = useState(false);

  const handleModelSave = async () => {
    setSaving(true);
    try {
      await onModelChange(channelId, selectedModel === "" ? null : selectedModel);
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveSession = async () => {
    if (activeSessionId === undefined) return;
    await onStopSession(activeSessionId);
    onRefreshStatus();
  };

  const handleEndTurnRunBtn = async () => {
    if (activeSessionId === undefined) return;
    await onEndTurnRun(activeSessionId);
    onRefreshStatus();
  };

  const updateCronField = (idx: number, field: keyof CronJobInput, value: string | number | boolean | undefined) => {
    setEditingCron((prev) => prev.map((j, i) => i === idx ? { ...j, [field]: value } : j));
  };

  const addCronJob = () => {
    const newId = `job-${Date.now()}`;
    setEditingCron((prev) => [...prev, { id: newId, channelId, intervalMs: 3600000, message: "" }]);
  };

  const removeCronJob = (idx: number) => {
    setEditingCron((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCronSave = async () => {
    setCronSaving(true);
    try {
      // Fetch ALL cron jobs (not just this channel), replace this channel's jobs, save all
      const allJobs = await fetchCronJobs();
      const otherChannelJobs: CronJobInput[] = allJobs
        .filter((j) => j.channelId !== channelId)
        .map((j) => ({ id: j.id, channelId: j.channelId, intervalMs: j.intervalMs, message: j.message, disabled: j.disabled ? true : undefined }));
      const merged = [...otherChannelJobs, ...editingCron];
      await saveCronJobs(merged);
    } catch { /* ignore */ }
    setCronSaving(false);
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 1000,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: "0.5rem",
          padding: "1.5rem",
          zIndex: 1001,
          width: "min(90vw, 500px)",
          maxHeight: "80vh",
          overflowY: "auto",
          color: "#c9d1d9",
        }}
      >
        <button
          onClick={onClose}
          style={{
            float: "right",
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
          Channel Settings — {channelId.slice(0, SESSION_ID_SHORT)}
        </h3>

        {/* Model Section */}
        <div style={modalSectionStyle}>
          <div style={modalTitleStyle}>Model</div>
          <div style={modalRowStyle}>
            <span style={modalLabelStyle}>Session status</span>
            <span>{sessionStatus ?? "no session"}</span>
          </div>
          <div style={modalRowStyle}>
            <span style={modalLabelStyle}>Current model</span>
            <span>{activeSession?.model ?? "—"}</span>
          </div>
          <div style={modalRowStyle}>
            <span style={modalLabelStyle}>Setting</span>
            <span>{channel?.model ?? "default"}</span>
          </div>
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              style={{
                flex: 1,
                padding: "0.3rem",
                background: "#0d1117",
                border: "1px solid #30363d",
                borderRadius: "0.3rem",
                color: "#c9d1d9",
                fontSize: "0.85rem",
              }}
            >
              <option value="">Default (global)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.billing?.multiplier !== undefined ? ` (x${m.billing.multiplier})` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={handleModelSave}
              disabled={saving}
              style={{
                padding: "0.3rem 0.8rem",
                background: "#238636",
                border: "none",
                borderRadius: "0.3rem",
                color: "#fff",
                cursor: saving ? "default" : "pointer",
                fontSize: "0.85rem",
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "..." : "Apply"}
            </button>
          </div>
        </div>

        {/* Physical Session Section */}
        <div style={modalSectionStyle}>
          <div style={modalTitleStyle}>Physical Session</div>
          {activeSession !== null && activeSessionId !== undefined ? (
            <div>
              <div style={modalRowStyle}>
                <span style={modalLabelStyle}>Session</span>
                <span>{activeSessionId.slice(0, SESSION_ID_SHORT)}</span>
              </div>
              <div style={modalRowStyle}>
                <span style={modalLabelStyle}>Model</span>
                <span>{activeSession.model}</span>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button
                  onClick={handleEndTurnRunBtn}
                  style={{
                    padding: "0.3rem 0.8rem",
                    background: "#da3633",
                    border: "none",
                    borderRadius: "0.3rem",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  End turn run
                </button>
                <button
                  onClick={handleArchiveSession}
                  style={{
                    padding: "0.3rem 0.8rem",
                    background: "#da3633",
                    border: "none",
                    borderRadius: "0.3rem",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  Archive session
                </button>
              </div>
              <div style={{ fontSize: "0.75rem", color: "#8b949e", marginTop: "0.3rem" }}>
                End turn run: stops current turn, next message applies model setting.
                Archive: fully removes the physical session.
              </div>
            </div>
          ) : (
            <div style={{ color: "#8b949e", fontSize: "0.85rem" }}>
              {sessionStatus === undefined ? "Send a message to start" :
               sessionStatus === "new" ? "No session yet — will start on first message" :
               sessionStatus === "idle" ? "Session idle — will resume on next message" :
               sessionStatus === "starting" ? "Starting..." :
               "No active physical session"}
            </div>
          )}
        </div>

        {/* Cron Section */}
        <div style={modalSectionStyle}>
          <div style={modalTitleStyle}>Cron Jobs</div>
          {editingCron.map((job, idx) => (
            <div
              key={idx}
              style={{
                padding: "0.5rem",
                marginBottom: "0.5rem",
                border: "1px solid #21262d",
                borderRadius: "0.3rem",
              }}
            >
              <div style={{ display: "flex", gap: "0.3rem", marginBottom: "0.3rem", alignItems: "center" }}>
                <input
                  value={job.id}
                  onChange={(e) => updateCronField(idx, "id", e.target.value)}
                  placeholder="Job ID"
                  style={{ flex: 1, padding: "0.2rem 0.3rem", background: "#0d1117", border: "1px solid #30363d", borderRadius: "0.3rem", color: "#c9d1d9", fontSize: "0.8rem" }}
                />
                <button
                  onClick={() => removeCronJob(idx)}
                  title="Delete"
                  style={{ background: "none", border: "none", color: "#f85149", cursor: "pointer", fontSize: "1rem", padding: "0 0.3rem" }}
                >
                  &times;
                </button>
              </div>
              <div style={{ display: "flex", gap: "0.3rem", marginBottom: "0.3rem", alignItems: "center" }}>
                <label style={{ fontSize: "0.75rem", color: "#8b949e", width: "5rem" }}>Interval (s)</label>
                <input
                  type="number"
                  value={Math.round(job.intervalMs / 1000)}
                  onChange={(e) => updateCronField(idx, "intervalMs", Math.max(1, parseInt(e.target.value, 10) || 1) * 1000)}
                  style={{ width: "5rem", padding: "0.2rem 0.3rem", background: "#0d1117", border: "1px solid #30363d", borderRadius: "0.3rem", color: "#c9d1d9", fontSize: "0.8rem" }}
                />
                <label style={{ fontSize: "0.75rem", color: "#8b949e", marginLeft: "0.5rem" }}>
                  <input
                    type="checkbox"
                    checked={job.disabled === true}
                    onChange={(e) => updateCronField(idx, "disabled", e.target.checked ? true : undefined)}
                    style={{ marginRight: "0.3rem" }}
                  />
                  Disabled
                </label>
              </div>
              <textarea
                value={job.message}
                onChange={(e) => updateCronField(idx, "message", e.target.value)}
                placeholder="Message"
                rows={2}
                style={{ width: "100%", padding: "0.2rem 0.3rem", background: "#0d1117", border: "1px solid #30363d", borderRadius: "0.3rem", color: "#c9d1d9", fontSize: "0.8rem", resize: "vertical", boxSizing: "border-box" }}
              />
            </div>
          ))}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.3rem" }}>
            <button
              onClick={addCronJob}
              style={{ padding: "0.3rem 0.8rem", background: "#21262d", border: "1px solid #30363d", borderRadius: "0.3rem", color: "#c9d1d9", cursor: "pointer", fontSize: "0.85rem" }}
            >
              + Add
            </button>
            <button
              onClick={handleCronSave}
              disabled={cronSaving}
              style={{ padding: "0.3rem 0.8rem", background: "#238636", border: "none", borderRadius: "0.3rem", color: "#fff", cursor: cronSaving ? "default" : "pointer", fontSize: "0.85rem", opacity: cronSaving ? 0.6 : 1 }}
            >
              {cronSaving ? "Saving..." : "Save & Reload"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
