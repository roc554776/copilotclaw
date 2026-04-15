/**
 * MessageAvatar component
 *
 * Displays a visual avatar for each message sender type.
 * For agent messages with senderMeta, shows initials derived from agentDisplayName
 * and a color derived by hashing agentId.
 * Agent avatars are clickable and invoke onAgentClick to open the ProfileModal.
 */
import type { MessageSenderMeta } from "../api";

export interface MessageAvatarProps {
  sender: "user" | "agent" | "cron" | "system";
  senderMeta?: MessageSenderMeta;
  onAgentClick?: (meta: MessageSenderMeta) => void;
  size?: "small" | "large";
}

/** Derive a stable background color hex string from an arbitrary string key. */
function colorFromString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  const h = hash % 360;
  return `hsl(${h}, 55%, 42%)`;
}

/** Extract up to 2 uppercase initials from a display name. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return "?";
  if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
  return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
}

const SIZE_STYLES: Record<"small" | "large", React.CSSProperties> = {
  small: { width: "28px", height: "28px", fontSize: "11px" },
  large: { width: "48px", height: "48px", fontSize: "18px" },
};

const baseStyle: React.CSSProperties = {
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
  flexShrink: 0,
  userSelect: "none",
  cursor: "default",
};

export function MessageAvatar({ sender, senderMeta, onAgentClick, size = "small" }: MessageAvatarProps) {
  const sizeStyle = SIZE_STYLES[size];
  if (sender === "user") {
    return (
      <div
        data-testid="avatar-user"
        style={{ ...baseStyle, ...sizeStyle, background: "#238636", color: "#fff" }}
        title="You"
      >
        Y
      </div>
    );
  }

  if (sender === "cron") {
    return (
      <div
        data-testid="avatar-cron"
        style={{ ...baseStyle, ...sizeStyle, background: "#6e40c9", color: "#fff" }}
        title="Cron"
      >
        ⏱
      </div>
    );
  }

  if (sender === "system") {
    return (
      <div
        data-testid="avatar-system"
        style={{ ...baseStyle, ...sizeStyle, background: "#484f58", color: "#c9d1d9" }}
        title="System"
      >
        ⚙
      </div>
    );
  }

  // sender === "agent"
  const agentId = senderMeta?.agentId ?? "unknown";
  const displayName = senderMeta?.agentDisplayName ?? "Agent";
  const bgColor = colorFromString(agentId);
  const label = initials(displayName);
  const isClickable = onAgentClick !== undefined;

  return (
    <div
      data-testid="avatar-agent"
      style={{
        ...baseStyle,
        ...sizeStyle,
        background: bgColor,
        color: "#fff",
        cursor: isClickable ? "pointer" : "default",
        outline: "none",
      }}
      title={displayName}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable && senderMeta !== undefined ? () => onAgentClick(senderMeta) : undefined}
      onKeyDown={
        isClickable && senderMeta !== undefined
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onAgentClick(senderMeta);
              }
            }
          : undefined
      }
    >
      {label}
    </div>
  );
}
