/** Render the SystemStatus standalone page (same data as the modal, but as a full page). */
export function renderStatusPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CopilotClaw — System Status</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 1rem; }
  h1 { font-size: 1.2rem; color: #58a6ff; margin-bottom: 1rem; }
  .section { margin-bottom: 1rem; padding: 0.75rem; border: 1px solid #30363d; border-radius: 0.5rem; }
  .section-title { font-weight: 600; margin-bottom: 0.5rem; color: #8b949e; font-size: 0.85rem; text-transform: uppercase; }
  .row { display: flex; justify-content: space-between; padding: 0.2rem 0; font-size: 0.85rem; }
  .label { color: #8b949e; }
  .value { color: #c9d1d9; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  #content { max-width: 800px; margin: 0 auto; }
  pre { background: #161b22; padding: 0.75rem; border-radius: 0.5rem; overflow-x: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
  .prompt-section { margin-top: 0.5rem; }
  .prompt-label { font-size: 0.8rem; color: #8b949e; margin-bottom: 0.3rem; }
  .back-link { margin-bottom: 1rem; display: inline-block; }
</style>
</head>
<body>
<div id="content">
  <a href="/" class="back-link">&larr; Back to chat</a>
  <h1>System Status</h1>
  <div id="status-content">Loading...</div>
  <div id="prompts-content"></div>
</div>
<script>
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function elapsed(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms/1000); if (s < 60) return s + 's';
  const m = Math.floor(s/60); if (m < 60) return m + 'm';
  const h = Math.floor(m/60); return h + 'h ' + (m%60) + 'm';
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    let html = '';

    // Gateway
    html += '<div class="section"><div class="section-title">Gateway</div>';
    html += '<div class="row"><span class="label">Status</span><span class="value">' + escHtml(data.gateway?.status ?? '?') + '</span></div>';
    html += '<div class="row"><span class="label">Version</span><span class="value">' + escHtml(data.gateway?.version ?? '?') + '</span></div>';
    html += '<div class="row"><span class="label">Profile</span><span class="value">' + escHtml(data.gateway?.profile ?? 'default') + '</span></div>';
    html += '</div>';

    // Agent
    if (data.agent) {
      html += '<div class="section"><div class="section-title">Agent</div>';
      html += '<div class="row"><span class="label">Version</span><span class="value">' + escHtml(data.agent.version ?? '?') + '</span></div>';
      html += '<div class="row"><span class="label">Started</span><span class="value">' + escHtml(data.agent.startedAt ?? '?') + '</span></div>';
      html += '<div class="row"><span class="label">Compatibility</span><span class="value">' + escHtml(data.agentCompatibility ?? '?') + '</span></div>';
      html += '</div>';

      // Sessions
      const entries = Object.entries(data.agent.sessions || {});
      if (entries.length > 0) {
        html += '<div class="section"><div class="section-title">Sessions · <a href="/sessions" style="font-weight:normal;text-transform:none">All sessions &rarr;</a></div>';
        for (const [id, sess] of entries) {
          const chLabel = sess.boundChannelId ? ' → ch:' + escHtml(sess.boundChannelId.slice(0,8)) : '';
          html += '<div class="row"><span class="label">' + escHtml(id.slice(0,8)) + chLabel + '</span><span class="value">' + escHtml(sess.status) + '</span></div>';
          if (sess.startedAt) {
            html += '<div style="margin-left:1rem;font-size:0.8rem;color:#8b949e"><div class="row"><span class="label">Session started</span><span class="value">' + escHtml(sess.startedAt) + ' (' + elapsed(sess.startedAt) + ')</span></div></div>';
          }
          if (sess.physicalSession) {
            const ps = sess.physicalSession;
            html += '<div style="margin-left:1rem;font-size:0.8rem;color:#8b949e">';
            html += '<div class="row"><span class="label">SDK Session</span><span class="value">' + escHtml(ps.sessionId.slice(0,12)) + '</span></div>';
            html += '<div class="row"><span class="label">Model</span><span class="value">' + escHtml(ps.model) + '</span></div>';
            html += '<div class="row"><span class="label">State</span><span class="value">' + escHtml(ps.currentState) + '</span></div>';
            if (ps.currentTokens != null && ps.tokenLimit != null) {
              const pct = Math.round(ps.currentTokens / ps.tokenLimit * 100);
              html += '<div class="row"><span class="label">Context</span><span class="value">' + ps.currentTokens + ' / ' + ps.tokenLimit + ' (' + pct + '%)</span></div>';
            }
            if (ps.totalInputTokens != null || ps.totalOutputTokens != null) {
              const inp = ps.totalInputTokens ?? 0;
              const out = ps.totalOutputTokens ?? 0;
              html += '<div class="row"><span class="label">Tokens used</span><span class="value">in: ' + inp + ' / out: ' + out + ' / total: ' + (inp+out) + '</span></div>';
            }
            html += '<div class="row"><span class="label">Started</span><span class="value">' + escHtml(ps.startedAt) + ' (' + elapsed(ps.startedAt) + ')</span></div>';
            html += '<div class="row"><span class="label">Events</span><span class="value"><a href="/sessions/' + encodeURIComponent(ps.sessionId) + '/events">View events &rarr;</a></span></div>';
            html += '<div class="row"><span class="label">System Prompt</span><span class="value"><a href="#" onclick="loadSessionPrompt(\\'' + escHtml(ps.sessionId) + '\\');return false;">View &rarr;</a></span></div>';
            html += '</div>';
          }
          if (sess.cumulativeInputTokens != null || sess.cumulativeOutputTokens != null) {
            const cIn = (sess.cumulativeInputTokens ?? 0) + (sess.physicalSession?.totalInputTokens ?? 0);
            const cOut = (sess.cumulativeOutputTokens ?? 0) + (sess.physicalSession?.totalOutputTokens ?? 0);
            if (cIn > 0 || cOut > 0) {
              html += '<div style="margin-left:1rem;font-size:0.8rem;color:#8b949e"><div class="row"><span class="label">Cumulative tokens</span><span class="value">in: ' + cIn + ' / out: ' + cOut + ' / total: ' + (cIn+cOut) + '</span></div></div>';
            }
          }
          // Physical session history
          const history = sess.physicalSessionHistory || [];
          if (history.length > 0) {
            html += '<div style="margin-left:1rem;font-size:0.8rem;margin-top:0.3rem">';
            html += '<div style="color:#8b949e;margin-bottom:0.3rem">Physical sessions (' + history.length + ')</div>';
            for (const hps of history) {
              html += '<div style="margin:0.3rem 0;padding:0.3rem;border:1px solid #21262d;border-radius:0.3rem;color:#8b949e">';
              html += '<div class="row"><span class="label">SDK Session</span><span class="value">' + escHtml(hps.sessionId.slice(0,12)) + '</span></div>';
              html += '<div class="row"><span class="label">Model</span><span class="value">' + escHtml(hps.model) + '</span></div>';
              html += '<div class="row"><span class="label">State</span><span class="value">' + escHtml(hps.currentState || 'stopped') + '</span></div>';
              if (hps.totalInputTokens != null || hps.totalOutputTokens != null) {
                html += '<div class="row"><span class="label">Tokens</span><span class="value">in: ' + (hps.totalInputTokens??0) + ' / out: ' + (hps.totalOutputTokens??0) + '</span></div>';
              }
              html += '<div class="row"><span class="label">Started</span><span class="value">' + escHtml(hps.startedAt) + '</span></div>';
              html += '<div class="row"><span class="label">Events</span><span class="value"><a href="/sessions/' + encodeURIComponent(hps.sessionId) + '/events">View events &rarr;</a></span></div>';
              html += '</div>';
            }
            html += '</div>';
          }
        }
        html += '</div>';
      }
    }

    // Config
    if (data.config) {
      html += '<div class="section"><div class="section-title">Config</div>';
      html += '<div class="row"><span class="label">Model</span><span class="value">' + escHtml(data.config.model ?? '(auto)') + '</span></div>';
      html += '<div class="row"><span class="label">Zero Premium</span><span class="value">' + data.config.zeroPremium + '</span></div>';
      html += '</div>';
    }

    document.getElementById('status-content').innerHTML = html;
  } catch (e) {
    document.getElementById('status-content').innerHTML = '<div class="section">Error loading status: ' + escHtml(String(e)) + '</div>';
  }

  // Load original prompts
  try {
    const res = await fetch('/api/system-prompts/original');
    if (res.ok) {
      const prompts = await res.json();
      if (Array.isArray(prompts) && prompts.length > 0) {
        let pHtml = '<div class="section"><div class="section-title">Original System Prompts (from Copilot SDK)</div>';
        for (const p of prompts) {
          pHtml += '<div class="prompt-section"><div class="prompt-label">Model: ' + escHtml(p.model) + ' — Captured: ' + escHtml(p.capturedAt) + '</div>';
          pHtml += '<pre>' + escHtml(p.prompt) + '</pre></div>';
        }
        pHtml += '</div>';
        document.getElementById('prompts-content').innerHTML = pHtml;
      }
    }
  } catch {}
}

async function loadSessionPrompt(sessionId) {
  try {
    const res = await fetch('/api/system-prompts/session/' + encodeURIComponent(sessionId));
    if (res.ok) {
      const data = await res.json();
      const el = document.createElement('div');
      el.className = 'section';
      el.innerHTML = '<div class="section-title">Session System Prompt (' + escHtml(data.model) + ')</div><pre>' + escHtml(data.prompt) + '</pre>';
      document.getElementById('prompts-content').appendChild(el);
    } else {
      alert('No system prompt captured for this session.');
    }
  } catch (e) { alert('Error: ' + e); }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

/** Render the sessions list page showing all sessions from the event store. */
export function renderSessionsListPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CopilotClaw — Sessions</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 1rem; }
  h1 { font-size: 1.2rem; color: #58a6ff; margin-bottom: 1rem; }
  .section { margin-bottom: 1rem; padding: 0.75rem; border: 1px solid #30363d; border-radius: 0.5rem; }
  .row { display: flex; justify-content: space-between; padding: 0.2rem 0; font-size: 0.85rem; }
  .label { color: #8b949e; }
  .value { color: #c9d1d9; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  #content { max-width: 800px; margin: 0 auto; }
  .back-link { margin-bottom: 1rem; display: inline-block; }
  .session-card { padding: 0.5rem; border: 1px solid #21262d; border-radius: 0.3rem; margin-bottom: 0.5rem; }
  .session-card:hover { border-color: #58a6ff; }
  .session-id { color: #58a6ff; font-weight: 600; font-size: 0.85rem; }
  .session-meta { color: #8b949e; font-size: 0.8rem; margin-top: 0.2rem; }
  .empty { color: #8b949e; font-size: 0.85rem; }
</style>
</head>
<body>
<div id="content">
  <a href="/status" class="back-link">&larr; Back to System Status</a>
  <h1>Sessions</h1>
  <div id="sessions-content">Loading...</div>
</div>
<script>
function escHtml(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

async function loadSessions() {
  try {
    const res = await fetch('/api/session-events/sessions');
    if (!res.ok) { document.getElementById('sessions-content').textContent = 'Failed to load sessions'; return; }
    const sessionIds = await res.json();
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      document.getElementById('sessions-content').innerHTML = '<div class="empty">No sessions recorded.</div>';
      return;
    }

    // Fetch first and last event for each session to show summary
    const summaries = await Promise.all(sessionIds.map(async (sid) => {
      try {
        const evRes = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/events');
        const events = await evRes.json();
        const first = events[0];
        const last = events[events.length - 1];
        // Extract model from session events (model_change or first usage)
        let model = '';
        for (const e of events) {
          if (e.type === 'session.model_change' && e.data?.newModel) { model = e.data.newModel; }
          if (!model && e.type === 'assistant.usage' && e.data?.model) { model = e.data.model; }
        }
        return { sid, eventCount: events.length, firstTime: first?.timestamp, lastTime: last?.timestamp, model };
      } catch { return { sid, eventCount: 0, firstTime: null, lastTime: null, model: '' }; }
    }));

    // Sort by most recent first
    summaries.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));

    let html = '';
    for (const s of summaries) {
      html += '<a href="/sessions/' + encodeURIComponent(s.sid) + '/events" style="text-decoration:none">';
      html += '<div class="session-card">';
      html += '<div class="session-id">' + escHtml(s.sid.slice(0, 12)) + '</div>';
      html += '<div class="session-meta">';
      if (s.model) html += 'Model: ' + escHtml(s.model) + ' · ';
      html += escHtml(String(s.eventCount)) + ' events';
      if (s.firstTime) {
        html += ' · Started: ' + escHtml(new Date(s.firstTime).toLocaleString());
      }
      if (s.lastTime) {
        html += ' · Last: ' + escHtml(new Date(s.lastTime).toLocaleString());
      }
      html += '</div></div></a>';
    }

    document.getElementById('sessions-content').innerHTML = html;
  } catch (e) {
    document.getElementById('sessions-content').innerHTML = '<div class="empty">Error: ' + escHtml(String(e)) + '</div>';
  }
}

loadSessions();
</script>
</body>
</html>`;
}

/** Render the session events stream page with auto-scroll and nested view toggle. */
export function renderEventsPage(sessionId: string): string {
  const escaped = sessionId.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session Events — ${escaped}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 1rem; }
  h1 { font-size: 1rem; color: #58a6ff; margin-bottom: 0.5rem; }
  .controls { margin-bottom: 1rem; display: flex; gap: 1rem; align-items: center; }
  .controls label { font-size: 0.85rem; color: #8b949e; }
  .controls button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 0.3rem 0.8rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.8rem; }
  .controls button:hover { background: #30363d; }
  #events { max-height: calc(100vh - 10rem); overflow-y: auto; border: 1px solid #30363d; border-radius: 0.5rem; padding: 0.5rem; }
  .event { padding: 0.3rem 0.5rem; border-bottom: 1px solid #21262d; font-size: 0.8rem; }
  .event:last-child { border-bottom: none; }
  .event-type { color: #58a6ff; font-weight: 600; }
  .event-time { color: #8b949e; margin-left: 0.5rem; }
  .event-data { color: #7d8590; margin-top: 0.2rem; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
  .nested { margin-left: 1.5rem; border-left: 2px solid #30363d; padding-left: 0.5rem; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .back-link { margin-bottom: 1rem; display: inline-block; }
  .event-count { color: #8b949e; font-size: 0.8rem; margin-left: 1rem; }
</style>
</head>
<body>
<a href="/status" class="back-link">&larr; Back to System Status</a>
<h1>Session Events<span class="event-count" id="count"></span></h1>
<div class="controls">
  <label><input type="checkbox" id="nested-toggle"> Nested view (parent-child)</label>
  <button onclick="refresh()">Refresh</button>
  <label><input type="checkbox" id="auto-scroll" checked> Auto-scroll</label>
</div>
<div id="events"></div>
<script>
const SESSION_ID = ${JSON.stringify(sessionId)};
let lastEventCount = 0;

function escHtml(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

function renderFlat(events) {
  return events.map(e =>
    '<div class="event"><span class="event-type">' + escHtml(e.type) + '</span>' +
    '<span class="event-time">' + escHtml(formatTime(e.timestamp)) + '</span>' +
    (e.parentId ? ' <span style="color:#8b949e">[parent: ' + escHtml(e.parentId.slice(0,8)) + ']</span>' : '') +
    '<div class="event-data">' + escHtml(JSON.stringify(e.data, null, 2)) + '</div></div>'
  ).join('');
}

function renderNested(events) {
  const byParent = new Map();
  const roots = [];
  for (const e of events) {
    if (e.parentId) {
      const list = byParent.get(e.parentId) || [];
      list.push(e);
      byParent.set(e.parentId, list);
    } else {
      roots.push(e);
    }
  }
  function renderNode(e) {
    const children = byParent.get(e.data?.toolCallId) || byParent.get(e.data?.sessionId) || [];
    let html = '<div class="event"><span class="event-type">' + escHtml(e.type) + '</span>' +
      '<span class="event-time">' + escHtml(formatTime(e.timestamp)) + '</span>' +
      '<div class="event-data">' + escHtml(JSON.stringify(e.data, null, 2)) + '</div>';
    if (children.length > 0) {
      html += '<div class="nested">' + children.map(renderNode).join('') + '</div>';
    }
    html += '</div>';
    return html;
  }
  return roots.map(renderNode).join('');
}

async function refresh() {
  try {
    const res = await fetch('/api/sessions/' + encodeURIComponent(SESSION_ID) + '/events');
    const events = await res.json();
    const container = document.getElementById('events');
    const nested = document.getElementById('nested-toggle').checked;
    const autoScroll = document.getElementById('auto-scroll').checked;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;

    container.innerHTML = nested ? renderNested(events) : renderFlat(events);
    document.getElementById('count').textContent = '(' + events.length + ' events)';

    if (autoScroll && (atBottom || events.length !== lastEventCount)) {
      container.scrollTop = container.scrollHeight;
    }
    lastEventCount = events.length;
  } catch (e) {
    document.getElementById('events').innerHTML = '<div class="event">Error: ' + escHtml(String(e)) + '</div>';
  }
}

document.getElementById('nested-toggle').addEventListener('change', refresh);
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
