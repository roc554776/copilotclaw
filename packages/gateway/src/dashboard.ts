import type { Channel, Message } from "./store.js";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderChatMessage(msg: Message): string {
  const side = msg.sender === "user" ? "user" : "agent";
  const bubbleCls = msg.sender === "user" ? "user-bubble" : "agent-bubble";
  return `<div class="msg ${side}"><div class="bubble ${bubbleCls}">${escapeHtml(msg.message)}</div><div class="time">${escapeHtml(msg.createdAt)}</div></div>`;
}

function renderTab(channel: Channel, isActive: boolean): string {
  const cls = isActive ? "tab active" : "tab";
  const label = channel.id.slice(0, 8);
  return `<a class="${cls}" href="/?channel=${escapeHtml(channel.id)}">${escapeHtml(label)}</a>`;
}

export interface DashboardAgentStatus {
  version?: string;
  sessionStatus?: string;
  compatibility?: string;
}

export function renderDashboard(channels: Channel[], chatMessages: Message[], activeChannelId: string | undefined, agentStatus?: DashboardAgentStatus): string {
  const messages = chatMessages.map(renderChatMessage).join("\n");
  const tabs = channels.map((ch) => renderTab(ch, ch.id === activeChannelId)).join("\n");
  const channelId = activeChannelId ?? "";

  const agentVersion = agentStatus?.version ? escapeHtml(agentStatus.version) : "—";
  const sessionState = agentStatus?.sessionStatus ? escapeHtml(agentStatus.sessionStatus) : "—";
  const compatibility = agentStatus?.compatibility ?? "unknown";
  const compatLabel = compatibility === "compatible" ? "" : ` [${escapeHtml(compatibility)}]`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>copilotclaw</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; height: 100vh; display: flex; flex-direction: column; }
    #tabs { display: flex; gap: 0.25rem; padding: 0.5rem 1rem 0; background: #161b22; border-bottom: 1px solid #30363d; align-items: center; }
    .tab { padding: 0.4rem 0.75rem; border-radius: 0.4rem 0.4rem 0 0; background: #0d1117; color: #8b949e; text-decoration: none; font-size: 0.85rem; }
    .tab.active { background: #0d1117; color: #58a6ff; border: 1px solid #30363d; border-bottom: 1px solid #0d1117; margin-bottom: -1px; }
    .tab:hover { color: #c9d1d9; }
    #new-tab { padding: 0.4rem 0.6rem; background: none; border: 1px dashed #30363d; border-radius: 0.4rem; color: #8b949e; cursor: pointer; font-size: 0.85rem; }
    #new-tab:hover { color: #c9d1d9; border-color: #58a6ff; }
    #chat { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .msg { display: flex; flex-direction: column; max-width: 70%; }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.agent { align-self: flex-start; align-items: flex-start; }
    .bubble { padding: 0.6rem 1rem; border-radius: 1rem; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .user-bubble { background: #238636; color: #fff; border-bottom-right-radius: 0.25rem; }
    .agent-bubble { background: #21262d; color: #c9d1d9; border-bottom-left-radius: 0.25rem; }
    .pending { color: #8b949e; font-style: italic; }
    .time { font-size: 0.7rem; color: #484f58; margin-top: 0.2rem; }
    #input-area { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; border-top: 1px solid #30363d; background: #161b22; }
    #input-area textarea { flex: 1; padding: 0.5rem 0.75rem; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 0.5rem; font-family: inherit; font-size: 0.9rem; resize: none; }
    #input-area textarea:focus { outline: none; border-color: #58a6ff; }
    #input-area button { padding: 0.5rem 1.25rem; background: #238636; color: #fff; border: none; border-radius: 0.5rem; cursor: pointer; font-size: 0.9rem; }
    #input-area button:hover { background: #2ea043; }
    #input-area button:disabled { opacity: 0.5; cursor: default; }
    .empty { color: #484f58; text-align: center; margin-top: 2rem; }
    #status-bar { padding: 0.3rem 1rem; background: #161b22; border-bottom: 1px solid #30363d; font-size: 0.75rem; color: #8b949e; cursor: pointer; user-select: none; }
    #status-bar:hover { color: #c9d1d9; }
    #status-modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 100; }
    #status-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); background: #161b22; border: 1px solid #30363d; border-radius: 0.75rem; padding: 1.5rem; min-width: 400px; max-width: 600px; z-index: 101; color: #c9d1d9; font-size: 0.85rem; }
    #status-modal h3 { margin-bottom: 1rem; font-size: 1rem; color: #58a6ff; }
    #status-modal .section { margin-bottom: 1rem; }
    #status-modal .section-title { font-weight: 600; color: #8b949e; margin-bottom: 0.3rem; }
    #status-modal .row { display: flex; justify-content: space-between; padding: 0.2rem 0; }
    #status-modal .label { color: #8b949e; }
    #status-modal .value { color: #c9d1d9; }
    #status-modal .close-btn { position: absolute; top: 0.75rem; right: 1rem; background: none; border: none; color: #8b949e; cursor: pointer; font-size: 1.2rem; }
    #status-modal .close-btn:hover { color: #c9d1d9; }
    .ws-indicator { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 0.4rem; vertical-align: middle; }
    .ws-connected { background: #3fb950; }
    .ws-disconnected { background: #f85149; }
    #processing-indicator { display: none; align-self: flex-start; }
    #processing-indicator.visible { display: flex; }
    .typing-dots { display: flex; gap: 0.3rem; padding: 0.6rem 1rem; background: #21262d; border-radius: 1rem; border-bottom-left-radius: 0.25rem; align-items: center; }
    .typing-dots span { width: 6px; height: 6px; border-radius: 50%; background: #8b949e; animation: typing 1.4s infinite; }
    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing { 0%, 60%, 100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-4px); } }
    #logs-btn { float: right; background: none; border: 1px solid #30363d; border-radius: 0.3rem; color: #8b949e; cursor: pointer; font-size: 0.7rem; padding: 0.1rem 0.4rem; }
    #logs-btn:hover { color: #c9d1d9; border-color: #58a6ff; }
    #logs-panel { display: none; position: fixed; bottom: 0; left: 0; width: 100%; max-height: 40vh; background: #0d1117; border-top: 1px solid #30363d; overflow-y: auto; z-index: 50; font-family: monospace; font-size: 0.75rem; padding: 0.5rem; }
    #logs-panel.visible { display: block; }
    .log-entry { padding: 0.1rem 0; color: #8b949e; white-space: pre-wrap; word-break: break-all; }
    .log-entry.error { color: #f85149; }
    .log-time { color: #484f58; margin-right: 0.5rem; }
    .log-source { color: #58a6ff; margin-right: 0.5rem; }
  </style>
</head>
<body>
  <div id="status-bar">
    <button id="logs-btn" onclick="event.stopPropagation(); toggleLogs()">Logs</button>
    <span class="ws-indicator ws-disconnected" id="ws-dot"></span>
    <span id="status-text">gateway: running | agent: v${agentVersion}${compatLabel} | session: ${sessionState}</span>
  </div>
  <div id="logs-panel"></div>
  <div id="status-modal-overlay" onclick="closeStatusModal()"></div>
  <div id="status-modal" style="display:none">
    <button class="close-btn" onclick="closeStatusModal()">&times;</button>
    <h3>System Status</h3>
    <div id="status-modal-content">Loading...</div>
  </div>
  <div id="tabs">
    ${tabs}
    <button id="new-tab">+</button>
  </div>
  <div id="chat">
    ${messages || '<div class="empty">Send a message to start the conversation.</div>'}
    <div id="processing-indicator" class="msg agent${sessionState === "processing" ? " visible" : ""}"><div class="typing-dots"><span></span><span></span><span></span></div></div>
  </div>
  <div id="input-area">
    <textarea id="msg" placeholder="Type a message…" rows="1"></textarea>
    <button id="send">Send</button>
  </div>
  <script>
    const CHANNEL_ID = ${JSON.stringify(channelId ?? "")};
    const chat = document.getElementById("chat");
    const msgInput = document.getElementById("msg");
    const sendBtn = document.getElementById("send");
    const newTabBtn = document.getElementById("new-tab");
    const statusBar = document.getElementById("status-bar");
    const statusText = document.getElementById("status-text");
    const statusModal = document.getElementById("status-modal");
    const statusModalOverlay = document.getElementById("status-modal-overlay");
    const statusModalContent = document.getElementById("status-modal-content");
    const wsDot = document.getElementById("ws-dot");
    let processingIndicator = document.getElementById("processing-indicator");

    function escHtml(s) {
      return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    // --- Server-Sent Events ---
    let evtSource = null;
    function connectSSE() {
      if (!CHANNEL_ID) return;
      evtSource = new EventSource("/api/events?channel=" + encodeURIComponent(CHANNEL_ID));
      evtSource.onopen = () => { wsDot.className = "ws-indicator ws-connected"; };
      evtSource.onerror = () => { wsDot.className = "ws-indicator ws-disconnected"; };
      evtSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === "new_message") {
            const isAgentMessage = event.data && event.data.sender === "agent";
            refreshChat(isAgentMessage);
            refreshStatus();
          } else if (event.type === "status_update") {
            updateStatusBar(event.data);
          }
        } catch {}
      };
    }
    connectSSE();

    // --- Status Bar + Processing Indicator ---
    function updateStatusBar(data) {
      if (!data) return;
      const agentVer = data.agentVersion || "—";
      const sessStatus = data.sessionStatus || "—";
      const compat = data.compatibility || "";
      const compatLabel = compat && compat !== "compatible" ? " [" + compat + "]" : "";
      statusText.textContent = "gateway: running | agent: v" + agentVer + compatLabel + " | session: " + sessStatus;
      // Re-query in case innerHTML replacement created a new node
      processingIndicator = document.getElementById("processing-indicator") || processingIndicator;
      if (sessStatus === "processing") {
        processingIndicator.classList.add("visible");
        chat.scrollTop = chat.scrollHeight;
      } else {
        processingIndicator.classList.remove("visible");
      }
    }

    // Poll status periodically (lightweight, supplements WS)
    async function refreshStatus() {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) return;
        const body = await res.json();
        const agent = body.agent;
        let sessStatus = "no session";
        let agentVer = "—";
        if (agent) {
          agentVer = agent.version || "—";
          const sessions = Object.values(agent.sessions || {});
          const bound = sessions.find(s => s.boundChannelId === CHANNEL_ID);
          sessStatus = bound ? bound.status : (sessions.length > 0 ? "other channel" : "no session");
        }
        updateStatusBar({ agentVersion: agentVer, sessionStatus: sessStatus, compatibility: body.agentCompatibility || "unknown" });
      } catch {}
    }
    setInterval(refreshStatus, 5000);
    refreshStatus();

    // --- Status Modal ---
    statusBar.addEventListener("click", openStatusModal);

    async function openStatusModal() {
      statusModal.style.display = "block";
      statusModalOverlay.style.display = "block";
      try {
        const statusRes = await fetch("/api/status");
        if (!statusRes.ok) { statusModalContent.textContent = "Failed to load status"; return; }
        const body = await statusRes.json();
        let html = '<div class="section"><div class="section-title">Gateway</div>';
        html += '<div class="row"><span class="label">Status</span><span class="value">' + escHtml(body.gateway?.status || "unknown") + '</span></div>';
        html += '</div>';
        if (body.agent) {
          html += '<div class="section"><div class="section-title">Agent</div>';
          html += '<div class="row"><span class="label">Version</span><span class="value">' + escHtml(body.agent.version || "—") + '</span></div>';
          html += '<div class="row"><span class="label">Started</span><span class="value">' + escHtml(body.agent.startedAt || "—") + '</span></div>';
          html += '</div>';
          const sessions = body.agent.sessions || {};
          const entries = Object.entries(sessions);
          if (entries.length > 0) {
            html += '<div class="section"><div class="section-title">Sessions (' + escHtml(String(entries.length)) + ')</div>';
            for (const [id, sess] of entries) {
              const chLabel = sess.boundChannelId ? ' → ch:' + escHtml(sess.boundChannelId.slice(0,8)) : '';
              html += '<div class="row"><span class="label">' + escHtml(id.slice(0,8)) + chLabel + '</span><span class="value">' + escHtml(sess.status) + '</span></div>';
              // Physical session details
              if (sess.physicalSession) {
                const ps = sess.physicalSession;
                html += '<div style="margin-left:1rem;font-size:0.8rem;color:#8b949e">';
                html += '<div class="row"><span class="label">SDK Session</span><span class="value">' + escHtml(ps.sessionId.slice(0,12)) + '</span></div>';
                html += '<div class="row"><span class="label">Model</span><span class="value">' + escHtml(ps.model) + '</span></div>';
                html += '<div class="row"><span class="label">State</span><span class="value">' + escHtml(ps.currentState) + '</span></div>';
                html += '<div class="row"><span class="label">Started</span><span class="value">' + escHtml(ps.startedAt) + '</span></div>';
                html += '</div>';
              }
              // Subagent sessions
              const subs = sess.subagentSessions || [];
              if (subs.length > 0) {
                html += '<div style="margin-left:1rem;font-size:0.8rem">';
                html += '<div class="section-title">Subagents (' + escHtml(String(subs.length)) + ')</div>';
                for (const sub of subs) {
                  html += '<div class="row"><span class="label">' + escHtml(sub.agentDisplayName || sub.agentName) + '</span><span class="value">' + escHtml(sub.status) + '</span></div>';
                }
                html += '</div>';
              }
            }
            html += '</div>';
          } else {
            html += '<div class="section"><div class="section-title">Sessions</div><div class="row"><span class="label">None active</span></div></div>';
          }
        } else {
          html += '<div class="section"><div class="section-title">Agent</div><div class="row"><span class="label">Not running</span></div></div>';
        }
        // Quota
        try {
          const quotaRes = await fetch("/api/quota");
          if (quotaRes.ok) {
            const quotaData = await quotaRes.json();
            const snapshots = quotaData.quotaSnapshots || {};
            const keys = Object.keys(snapshots);
            if (keys.length > 0) {
              html += '<div class="section"><div class="section-title">Premium Requests</div>';
              for (const key of keys) {
                const q = snapshots[key];
                const used = q.usedRequests ?? 0;
                const total = q.entitlementRequests ?? 0;
                const remaining = total - used;
                html += '<div class="row"><span class="label">' + escHtml(key) + '</span><span class="value">' + escHtml(String(remaining)) + ' / ' + escHtml(String(total)) + '</span></div>';
                if (q.overage > 0) {
                  html += '<div class="row"><span class="label">Overage</span><span class="value">' + escHtml(String(q.overage)) + '</span></div>';
                }
              }
              html += '</div>';
            }
          }
        } catch { /* quota not available */ }

        // Models
        try {
          const modelsRes = await fetch("/api/models");
          if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            const models = modelsData.models || [];
            if (models.length > 0) {
              html += '<div class="section"><div class="section-title">Available Models</div>';
              for (const m of models) {
                const multiplier = m.billing?.multiplier ?? "?";
                html += '<div class="row"><span class="label">' + escHtml(m.id) + '</span><span class="value">x' + escHtml(String(multiplier)) + '</span></div>';
              }
              html += '</div>';
            }
          }
        } catch { /* models not available */ }

        statusModalContent.innerHTML = html;
      } catch {
        statusModalContent.textContent = "Failed to load status";
      }
    }

    function closeStatusModal() {
      statusModal.style.display = "none";
      statusModalOverlay.style.display = "none";
    }

    // --- Chat ---
    async function sendMessage() {
      const text = msgInput.value.trim();
      if (!text || !CHANNEL_ID) return;
      sendBtn.disabled = true;
      msgInput.value = "";
      try {
        await fetch("/api/channels/" + CHANNEL_ID + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: "user", message: text }),
        });
        // WebSocket will trigger refreshChat, but also do it immediately for responsiveness
        await refreshChat();
      } finally {
        sendBtn.disabled = false;
        msgInput.focus();
      }
    }

    async function refreshChat(hideIndicator) {
      const res = await fetch("/?channel=" + CHANNEL_ID);
      if (!res.ok) return;
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const newChat = doc.getElementById("chat");
      if (newChat) {
        const wasProcessing = !hideIndicator && processingIndicator.classList.contains("visible");
        chat.innerHTML = newChat.innerHTML;
        // Update the processingIndicator reference to the new DOM node
        processingIndicator = document.getElementById("processing-indicator");
        if (wasProcessing && processingIndicator) {
          processingIndicator.classList.add("visible");
        }
        chat.scrollTop = chat.scrollHeight;
      }
    }

    async function createChannel() {
      const res = await fetch("/api/channels", { method: "POST" });
      if (!res.ok) return;
      const ch = await res.json();
      window.location.href = "/?channel=" + ch.id;
    }

    sendBtn.addEventListener("click", sendMessage);
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    newTabBtn.addEventListener("click", createChannel);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeStatusModal(); toggleLogs(true); }
    });

    // --- Logs Panel ---
    const logsPanel = document.getElementById("logs-panel");
    let logsVisible = false;
    let logsInterval = null;

    function toggleLogs(forceClose) {
      if (forceClose === true) {
        logsPanel.classList.remove("visible");
        logsVisible = false;
        clearInterval(logsInterval);
        logsInterval = null;
        return;
      }
      logsVisible = !logsVisible;
      if (logsVisible) {
        logsPanel.classList.add("visible");
        refreshLogs();
        logsInterval = setInterval(refreshLogs, 3000);
      } else {
        logsPanel.classList.remove("visible");
        clearInterval(logsInterval);
        logsInterval = null;
      }
    }

    async function refreshLogs() {
      try {
        const res = await fetch("/api/logs?limit=100");
        if (!res.ok) return;
        const logs = await res.json();
        logsPanel.innerHTML = logs.map(function(entry) {
          const cls = entry.level === "error" ? "log-entry error" : "log-entry";
          const time = entry.timestamp ? entry.timestamp.slice(11, 19) : "";
          return '<div class="' + cls + '"><span class="log-time">' + escHtml(time) + '</span><span class="log-source">[' + escHtml(entry.source) + ']</span>' + escHtml(entry.message) + '</div>';
        }).join("");
        logsPanel.scrollTop = 0;
      } catch {}
    }

    chat.scrollTop = chat.scrollHeight;
  </script>
</body>
</html>`;
}
