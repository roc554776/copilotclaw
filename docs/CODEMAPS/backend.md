<!-- Generated: 2026-03-26 | Files scanned: 31 | Token estimate: ~1650 -->

# Backend

## Gateway (packages/gateway)

### API Routes (server.ts)

```
GET  /healthz                              → 200 { status: "ok" }
POST /api/stop                             → 200 { status: "stopping" } → gateway exit only (localhost only, agent NOT stopped)
GET  /api/status                           → 200 { gateway: {status, version, profile}, agent: AgentStatusResponse|null, agentCompatibility: …|null, config: {model, zeroPremium, mockTools} }
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
src/config.ts              — config file module: loadConfig, loadFileConfig, saveConfig, ensureConfigFile, resolvePort, getConfigFilePath, CONFIG_ENV_VARS, parseBool helper; profile-aware (~/.copilotclaw/config.json or config-{{profile}}.json); env vars (COPILOTCLAW_PORT, COPILOTCLAW_UPSTREAM, COPILOTCLAW_MODEL, COPILOTCLAW_ZERO_PREMIUM, COPILOTCLAW_MOCK_TOOLS) take precedence over file values; CopilotclawConfig includes model, zeroPremium, mockTools fields
src/config-cli.ts          — `copilotclaw config` CLI: configGet (resolve + display, notes env var override), configSet (validate + save, warns if env var shadows); valid keys: upstream, port, model, zeroPremium, mockTools; BOOLEAN_KEYS handling for zeroPremium/mockTools
src/daemon.ts              — daemon entry point (ensureWorkspace + Store init + LogBuffer creation + console intercept + startServer on resolvePort() + periodic agent monitor every 30s, max 3 retries)
src/index.ts               — CLI entry point (health check on resolvePort() → detached spawn → exit); after daemon healthy, checks /api/status agentCompatibility and exits 1 on incompatible; checkAgentCompatibility polls /api/status when waitForAgent=true (used after force-restart)
src/log-buffer.ts          — LogBuffer class (ring buffer for recent log lines), interceptConsole() to capture stdout/stderr
src/stop.ts                — POST /api/stop CLI (uses resolvePort())
src/restart.ts             — `copilotclaw restart` CLI: stop gateway → wait for shutdown → start (uses resolvePort())
src/setup.ts               — `copilotclaw setup` CLI: create workspace directories + auto-port selection (isPortAvailable, findAvailablePort from candidate list; saves port to config if default busy)
src/update.ts              — `copilotclaw update` CLI: git pull + pnpm build self-update (upstream from config file, COPILOTCLAW_UPSTREAM env var takes precedence)
src/workspace.ts           — workspace paths: profile-aware (~/.copilotclaw/ or ~/.copilotclaw/workspace-{{profile}}/), data/, store.json; ensureWorkspace(); profile via COPILOTCLAW_PROFILE env var
src/store.ts               — persistent store (Channel, Message, per-channel pending queue); JSON file via atomic rename
src/channel-provider.ts    — ChannelProvider interface (plugin contract for chat mediums)
src/builtin-chat-channel.ts — BuiltinChatChannel: built-in chat UI provider (dashboard, SSE events, WS broadcast); passes compatibility info to dashboard
src/dashboard.ts           — HTML renderer (status bar with compatibility label, chat bubbles, channel tabs, input form, logs panel toggled via Logs button with stopPropagation to prevent status modal opening)
src/ws.ts                  — WsBroadcaster: SSE event broadcasting to connected clients
src/doctor.ts              — `copilotclaw doctor` CLI: checkWorkspace, checkConfig, checkGateway, checkAgent, checkZeroPremium diagnostics; runDoctor orchestrates checks and optional --fix (fixWorkspace, fixConfig, fixStaleSocket); exits 1 on failures
src/agent-manager.ts       — IPC-based agent process ensure at gateway start (spawn, version check, force-restart); ensureAgent returns old bootId on force-restart; waitForNewAgent polls until different bootId appears; checkCompatibility() and getMinAgentVersion() methods; MIN_AGENT_VERSION exported; semverSatisfies exported (used by doctor)
src/ipc-client.ts          — IPC client (status/stop to agent process); AgentStatusResponse includes bootId field
src/ipc-paths.ts           — socket path: profile-aware (copilotclaw-agent.sock or copilotclaw-agent-{{profile}}.sock in tmpdir)
```

### Workspace Layout

```
~/.copilotclaw/
  config.json                — config file (port, upstream, model, zeroPremium, mockTools); env vars take precedence
  config-{{profile}}.json    — profile-specific config (when COPILOTCLAW_PROFILE set)
  data/
    store.json               — persisted channels + messages + pending queues (atomic write via .tmp rename)
  workspace-{{profile}}/     — profile-specific workspace root (when COPILOTCLAW_PROFILE set)
    data/
      store.json
```

## Agent (packages/agent)

### IPC Protocol (newline-delimited JSON over Unix domain socket)

```
→ {"method":"status"}
← {"version":"0.1.0","bootId":"uuid","startedAt":"...","sessions":{"sess-id":{"status":"waiting","startedAt":"...","boundChannelId":"ch-id","copilotSessionId":"..."}}}

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
src/index.ts                    — singleton entry, fetches config (model/zeroPremium/mockTools) from gateway /api/status at startup, passes to AgentSessionManager; gateway polling loop, max-age check then stale detection per cycle; checks for saved sessions (hasSavedSession) when pending messages found, consumes saved copilotSessionId for deferred resume via startSession
src/agent-session-manager.ts    — per-session lifecycle, channel binding, model/zeroPremium/mockTools fields; resolveModel() method (zeroPremium overrides premium models to non-premium); mockTools mode restricts availableTools to copilotclaw_* + debug mock tools + WebFetch/WebSearch; deferred resume pattern: checkSessionMaxAge and checkStaleAndHandle save copilotSessionId to savedCopilotSessionIds map and stop session (no immediate restart/retry); hasSavedSession/consumeSavedSession for retrieval; max-age 2-day default; channel notifications (stopped/timed-out via postChannelMessage)
src/ipc-server.ts               — Unix domain socket IPC server (status/session_status/stop), version reporting
src/ipc-paths.ts                — socket path generation (profile-aware, same logic as gateway)
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

### Test Suites (193 total: 185 vitest + 8 Playwright)

```
Gateway vitest (139 tests) — unit + E2E tests with mock agent (includes config, config-cli, doctor, ipc-paths, setup, workspace tests)
Agent vitest (46 tests)    — unit tests with mock Copilot SDK session
Browser Playwright (8 tests) — test/browser/dashboard.spec.ts: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
```
