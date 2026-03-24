import type { UserInput } from "./store.js";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMessage(input: UserInput): string {
  const userBubble = `<div class="msg user"><div class="bubble user-bubble">${escapeHtml(input.message)}</div><div class="time">${escapeHtml(input.createdAt)}</div></div>`;

  if (input.reply === undefined) {
    return userBubble + `<div class="msg agent"><div class="bubble agent-bubble pending">thinking…</div></div>`;
  }

  const agentBubble = `<div class="msg agent"><div class="bubble agent-bubble">${escapeHtml(input.reply.message)}</div><div class="time">${escapeHtml(input.reply.createdAt)}</div></div>`;
  return userBubble + agentBubble;
}

export function renderDashboard(inputs: UserInput[]): string {
  const messages = inputs.map(renderMessage).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>copilotclaw</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; height: 100vh; display: flex; flex-direction: column; }
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
    #input-area textarea { flex: 1; padding: 0.5rem 0.75rem; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 0.5rem; font-family: inherit; font-size: 0.9rem; resize: none; rows: 1; }
    #input-area textarea:focus { outline: none; border-color: #58a6ff; }
    #input-area button { padding: 0.5rem 1.25rem; background: #238636; color: #fff; border: none; border-radius: 0.5rem; cursor: pointer; font-size: 0.9rem; }
    #input-area button:hover { background: #2ea043; }
    #input-area button:disabled { opacity: 0.5; cursor: default; }
    .empty { color: #484f58; text-align: center; margin-top: 2rem; }
  </style>
</head>
<body>
  <div id="chat">
    ${messages || '<div class="empty">Send a message to start the conversation.</div>'}
  </div>
  <div id="input-area">
    <textarea id="msg" placeholder="Type a message…" rows="1"></textarea>
    <button id="send">Send</button>
  </div>
  <script>
    const chat = document.getElementById("chat");
    const msgInput = document.getElementById("msg");
    const sendBtn = document.getElementById("send");

    async function sendMessage() {
      const text = msgInput.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      msgInput.value = "";
      try {
        await fetch("/api/inputs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        await refreshChat();
      } finally {
        sendBtn.disabled = false;
        msgInput.focus();
      }
    }

    async function refreshChat() {
      const res = await fetch("/");
      if (!res.ok) return;
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const newChat = doc.getElementById("chat");
      if (newChat) {
        chat.innerHTML = newChat.innerHTML;
        chat.scrollTop = chat.scrollHeight;
      }
    }

    sendBtn.addEventListener("click", sendMessage);
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    setInterval(refreshChat, 2000);
    chat.scrollTop = chat.scrollHeight;
  </script>
</body>
</html>`;
}
