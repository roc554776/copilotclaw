<!-- Generated: 2026-03-26 | Files scanned: 29 | Token estimate: ~1300 -->

# Backend

## Gateway (packages/gateway)

### API Routes (server.ts)

```
GET  /healthz                              → 200 { status: "ok" }
POST /api/stop                             → 200 { status: "stopping" } → gateway exit only (localhost only, agent NOT stopped)
GET  /api/status                           → 200 { gateway: {status, version}, agent: AgentStatusResponse|null, agentCompatibility: {compatible, minVersion, currentVersion}|null }
GET  /api/logs                             → 200 { logs: string[] } (recent log lines from ring buffer)
GET  /api/channels                         → 200 Channel[]
POST /api/channels                         → 201 Channel
GET  /api/channels/pending                 → 200 { [channelId]: count }
GET  /api/channels/:channelId/messages              → 200 Message[] (?limit=N, reverse-chronological)
POST /api/channels/:channelId/messages              → 201 Message (sender: "user"|"agent", user messages go to pending queue)
POST /api/channels/:channelId/messages/pending      → 200 Message[] | 204 (drain all pending user messages)
GET  /api/channels/:channelId/messages/pending/peek → 200 Message | 204 (oldest pending, non-destructive)
POST /api/channels/:channelId/messages/pending/flush → 200 { flushed: count }
GET  /                                     → 200 HTML dashboard (status bar + channel tabs + chat UI)
```

### Key Files

```
src/server.ts              — HTTP server, route handler, startServer(), GATEWAY_VERSION from package.json; /api/logs endpoint serves LogBuffer contents
src/daemon.ts              — daemon entry point (ensureWorkspace + Store init + LogBuffer creation + console intercept + startServer + periodic agent monitor every 30s, max 3 retries)
src/index.ts               — CLI entry point (health check → detached spawn → exit); after daemon healthy, checks /api/status agentCompatibility and exits 1 on incompatible
src/log-buffer.ts          — LogBuffer class (ring buffer for recent log lines), interceptConsole() to capture stdout/stderr
src/stop.ts                — POST /api/stop CLI
src/restart.ts             — `copilotclaw restart` CLI: stop gateway → wait for shutdown → start
src/setup.ts               — `copilotclaw setup` CLI: create workspace directories
src/update.ts              — `copilotclaw update` CLI: git pull + pnpm build self-update (COPILOTCLAW_UPSTREAM for file URL)
src/workspace.ts           — workspace paths: ~/.copilotclaw/ root, data/, store.json; ensureWorkspace()
src/store.ts               — persistent store (Channel, Message, per-channel pending queue); JSON file via atomic rename
src/channel-provider.ts    — ChannelProvider interface (plugin contract for chat mediums)
src/builtin-chat-channel.ts — BuiltinChatChannel: built-in chat UI provider (dashboard, SSE events, WS broadcast); passes compatibility info to dashboard
src/dashboard.ts           — HTML renderer (status bar with compatibility label, chat bubbles, channel tabs, input form, logs panel toggled via Logs button with stopPropagation to prevent status modal opening)
src/ws.ts                  — WsBroadcaster: SSE event broadcasting to connected clients
src/agent-manager.ts       — IPC-based agent process ensure at gateway start (spawn, version check, force-restart); checkCompatibility() and getMinAgentVersion() methods
src/ipc-client.ts          — IPC client (status/stop to agent process)
src/ipc-paths.ts           — socket path: ${tmpdir}/copilotclaw-agent.sock
```

### Workspace Layout

```
~/.copilotclaw/
  data/
    store.json    — persisted channels + messages + pending queues (atomic write via .tmp rename)
```

## Agent (packages/agent)

### IPC Protocol (newline-delimited JSON over Unix domain socket)

```
→ {"method":"status"}
← {"version":"0.1.0","startedAt":"...","sessions":{"sess-id":{"status":"waiting","startedAt":"...","boundChannelId":"ch-id","copilotSessionId":"..."}}}

→ {"method":"session_status","params":{"sessionId":"sess-id"}}
← {"status":"processing","startedAt":"...","processingStartedAt":"...","boundChannelId":"ch-id"}
  (or {"status":"not_running"} if no session exists)

→ {"method":"stop"}
← {"ok":true}  → graceful shutdown of all sessions
```

### Copilot SDK Tools (tools/channel.ts)

```
copilotclaw_send_message(message)   — send a message to the channel (non-blocking)
copilotclaw_receive_input()         — block polling for pending user messages (25 min keepalive timeout)
copilotclaw_list_messages(limit?)   — list recent channel messages (reverse-chronological)
```

### SDK Hooks

- `onPostToolUse` — peeks channel for pending user messages, injects additionalContext notification

### Key Files

```
src/index.ts                    — singleton entry, gateway polling loop, max-age check then stale detection per cycle; checks for saved sessions (hasSavedSession) when pending messages found, consumes saved copilotSessionId for deferred resume via startSession
src/agent-session-manager.ts    — per-session lifecycle, channel binding, deferred resume pattern: checkSessionMaxAge and checkStaleAndHandle save copilotSessionId to savedCopilotSessionIds map and stop session (no immediate restart/retry); hasSavedSession/consumeSavedSession for retrieval; max-age 2-day default; channel notifications (stopped/timed-out via postChannelMessage)
src/ipc-server.ts               — Unix domain socket IPC server (status/session_status/stop), version reporting
src/ipc-paths.ts                — socket path generation
src/session-loop.ts             — session idle loop (subscribe/send/disconnect, no continuePrompt); runSession supports both createSession and resumeSession
src/copilot-session-adapter.ts  — CopilotSession → SessionLike adapter
src/stop.ts                     — CLI stop command (IPC stop)
src/tools/channel.ts            — send_message, receive_input, list_messages tools
```

## Testing

### Configuration

```
vitest.config.ts           — vitest config; excludes test/browser/ (Playwright-managed)
playwright.config.ts       — Playwright config for browser E2E tests
```

### Test Suites (120 total: 112 vitest + 8 Playwright)

```
Gateway vitest (80 tests)  — unit + E2E tests with mock agent
Agent vitest (32 tests)    — unit + E2E tests with mock Copilot SDK session
Browser Playwright (8 tests) — test/browser/dashboard.spec.ts: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
```
