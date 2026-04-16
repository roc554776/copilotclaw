/**
 * ProfileModal component
 *
 * Displays agent identity information in a modal dialog.
 * Supports Info and Intent tabs. Intent tab shows a timeline of intents
 * recorded via the copilotclaw_intent tool (fetched from the API).
 * Closes on Escape key, backdrop click, or close button.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentRole, Intent } from "../api";
import { fetchIntents } from "../api";
import { MessageAvatar } from "./MessageAvatar";

export interface ProfileModalProps {
  agentId: string;
  agentDisplayName: string;
  agentRole: AgentRole;
  onClose: () => void;
  /** Channel ID used to fetch intents. When omitted, intent tab shows no data. */
  channelId?: string;
  /** Physical session model name. When undefined, shows "モデル情報なし". */
  modelName?: string;
}

const ROLE_LABELS: Record<AgentRole, string> = {
  "channel-operator": "Channel Operator",
  "worker": "Worker",
  "subagent": "Subagent",
  "unknown": "Unknown",
};


export function ProfileModal({ agentId, agentDisplayName, agentRole, onClose, channelId, modelName }: ProfileModalProps) {
  const [activeTab, setActiveTab] = useState<"info" | "intent">("info");
  const backdropRef = useRef<HTMLDivElement>(null);
  const [intents, setIntents] = useState<Intent[] | null>(null);
  const [intentsError, setIntentsError] = useState<string | null>(null);
  const [intentsLoading, setIntentsLoading] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Fetch intents when the intent tab is opened
  useEffect(() => {
    if (activeTab !== "intent") return;
    if (channelId === undefined) return;
    setIntentsLoading(true);
    setIntentsError(null);
    fetchIntents(channelId, agentId)
      .then((data) => {
        setIntents(data);
        setIntentsLoading(false);
      })
      .catch((err: unknown) => {
        setIntentsError(err instanceof Error ? err.message : "Failed to load intents");
        setIntentsLoading(false);
      });
  }, [activeTab, channelId, agentId]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  return (
    <div
      ref={backdropRef}
      data-testid="profile-modal-backdrop"
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        data-testid="profile-modal"
        style={{
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: "0.75rem",
          width: "min(420px, 90vw)",
          maxHeight: "80vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1.5rem 1.5rem 1rem",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            borderBottom: "1px solid #21262d",
          }}
        >
          <div data-testid="profile-modal-avatar">
            <MessageAvatar
              sender="agent"
              senderMeta={{ agentId, agentDisplayName, agentRole }}
              size="large"
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              data-testid="profile-modal-display-name"
              style={{ fontSize: "1.1rem", fontWeight: 600, color: "#c9d1d9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {agentDisplayName}
            </div>
            <div
              data-testid="profile-modal-role-badge"
              style={{
                display: "inline-block",
                marginTop: "0.25rem",
                padding: "0.1rem 0.5rem",
                borderRadius: "9999px",
                fontSize: "0.7rem",
                fontWeight: 600,
                background: agentRole === "channel-operator" ? "#0d419d" : agentRole === "subagent" ? "#3d2b00" : "#21262d",
                color: agentRole === "channel-operator" ? "#58a6ff" : agentRole === "subagent" ? "#e3b341" : "#8b949e",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {ROLE_LABELS[agentRole]}
            </div>
          </div>
          <button
            data-testid="profile-modal-close"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#8b949e",
              cursor: "pointer",
              fontSize: "1.2rem",
              padding: "0.25rem",
              lineHeight: 1,
              flexShrink: 0,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderBottom: "1px solid #21262d",
            padding: "0 1.5rem",
          }}
        >
          {(["info", "intent"] as const).map((tab) => (
            <button
              key={tab}
              data-testid={`profile-modal-tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              style={{
                background: "none",
                border: "none",
                borderBottom: activeTab === tab ? "2px solid #f78166" : "2px solid transparent",
                color: activeTab === tab ? "#c9d1d9" : "#8b949e",
                cursor: "pointer",
                fontSize: "0.85rem",
                fontWeight: activeTab === tab ? 600 : 400,
                padding: "0.6rem 0.75rem",
                textTransform: "capitalize",
              }}
            >
              {tab === "info" ? "Info" : "Intent"}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: "1rem 1.5rem 1.5rem" }}>
          {activeTab === "info" && (
            <div data-testid="profile-modal-info-tab">
              <div style={{ marginBottom: "0.75rem" }}>
                <div style={{ fontSize: "0.75rem", color: "#8b949e", marginBottom: "0.25rem" }}>Agent ID</div>
                <div
                  data-testid="profile-modal-agent-id"
                  style={{ fontSize: "0.85rem", color: "#c9d1d9", fontFamily: "monospace", wordBreak: "break-all" }}
                >
                  {agentId}
                </div>
              </div>
              <div style={{ marginBottom: "0.75rem" }}>
                <div style={{ fontSize: "0.75rem", color: "#8b949e", marginBottom: "0.25rem" }}>Role</div>
                <div
                  data-testid="profile-modal-role-text"
                  style={{ fontSize: "0.85rem", color: "#c9d1d9" }}
                >
                  {ROLE_LABELS[agentRole]}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "#8b949e", marginBottom: "0.25rem" }}>Model</div>
                <div
                  data-testid="profile-modal-model-name"
                  style={{ fontSize: "0.85rem", color: modelName !== undefined ? "#c9d1d9" : "#484f58", fontFamily: modelName !== undefined ? "monospace" : undefined, wordBreak: "break-all" }}
                >
                  {modelName ?? "モデル情報なし"}
                </div>
              </div>
            </div>
          )}
          {activeTab === "intent" && (
            <div data-testid="profile-modal-intent-tab">
              {intentsLoading && (
                <div
                  data-testid="profile-modal-intent-loading"
                  style={{ color: "#8b949e", fontSize: "0.85rem" }}
                >
                  Loading...
                </div>
              )}
              {intentsError !== null && (
                <div
                  data-testid="profile-modal-intent-error"
                  style={{ color: "#f85149", fontSize: "0.85rem" }}
                >
                  {intentsError}
                </div>
              )}
              {!intentsLoading && intentsError === null && (intents === null || intents.length === 0) && channelId === undefined && (
                <div
                  data-testid="profile-modal-intent-placeholder"
                  style={{ color: "#8b949e", fontSize: "0.85rem", fontStyle: "italic" }}
                >
                  Intent timeline（チャンネルを選択してください）
                </div>
              )}
              {!intentsLoading && intentsError === null && intents !== null && intents.length === 0 && channelId !== undefined && (
                <div
                  data-testid="profile-modal-intent-empty"
                  style={{ color: "#8b949e", fontSize: "0.85rem", fontStyle: "italic" }}
                >
                  Intent が記録されていません
                </div>
              )}
              {!intentsLoading && intents !== null && intents.length > 0 && (
                <div data-testid="profile-modal-intent-timeline">
                  {intents.map((entry) => (
                    <div
                      key={entry.id}
                      data-testid="profile-modal-intent-entry"
                      style={{
                        marginBottom: "0.75rem",
                        padding: "0.5rem 0.75rem",
                        background: "#0d1117",
                        border: "1px solid #21262d",
                        borderRadius: "0.375rem",
                        fontSize: "0.82rem",
                      }}
                    >
                      <div style={{ color: "#c9d1d9", marginBottom: "0.25rem", lineHeight: 1.5 }}>{entry.intent}</div>
                      <div style={{ color: "#484f58", fontSize: "0.72rem" }}>
                        {new Date(entry.timestamp).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
