<!-- Generated: 2026-03-26 | Files scanned: 31 | Token estimate: ~1900 -->

# Backend

## Gateway (packages/gateway)

### API Routes (server.ts)

```
GET  /healthz                              → 200 { status: "ok" }
POST /api/stop                             → 200 { status: "stopping" } → gateway exit only (localhost only, agent NOT stopped)
GET  /api/status                           → 200 { gateway: {status, version, profile}, agent: AgentStatusResponse|null, agentCompatibility: …|null, config: {model, zeroPremium, debugMockCopilotUnsafeTools, workspaceRoot} }
GET  /api/quota                            → 200 quota object | 503 (no active agent session); proxied from agent via IPC
GET  /api/models                           → 200 models object | 503 (no active agent session); proxied from agent via IPC
GET  /api/logs                             → 200 { logs: string[] } (recent log lines from ring buffer)
GET  /api/sessions/:sessionId/messages     → 200 unknown[] | 404 (copilot session conversation history; proxied from agent via IPC)
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
src/server.ts              — HTTP server, route handler, startServer(), GATEWAY_VERSION from package.json; /api/logs endpoint serves LogBuffer contents; /api/quota, /api/models, and /api/sessions/:sessionId/messages proxy to agent via agentManager
src/config.ts              — config file module: loadConfig, loadFileConfig, saveConfig, ensureConfigFile, resolvePort, getConfigFilePath, CONFIG_ENV_VARS, parseBool helper; profile-aware (~/.copilotclaw/config.json or config-{{profile}}.json); env vars (COPILOTCLAW_PORT, COPILOTCLAW_UPSTREAM, COPILOTCLAW_MODEL, COPILOTCLAW_ZERO_PREMIUM, COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS) take precedence over file values; CopilotclawConfig includes model, zeroPremium, debugMockCopilotUnsafeTools fields
src/config-cli.ts          — `copilotclaw config` CLI: configGet (resolve + display, notes env var override), configSet (validate + save, warns if env var shadows); valid keys: upstream, port, model, zeroPremium, debugMockCopilotUnsafeTools; BOOLEAN_KEYS handling for zeroPremium/debugMockCopilotUnsafeTools
src/daemon.ts              — daemon entry point (ensureWorkspace + Store init + LogBuffer creation + console intercept + startServer on resolvePort() + periodic agent monitor every 30s, max 3 retries)
src/index.ts               — CLI entry point (health check on resolvePort() → detached spawn → exit); reads GATEWAY_VERSION from package.json, shows version in all CLI log messages; after daemon healthy, checks /api/status agentCompatibility and exits 1 on incompatible; checkAgentCompatibility polls /api/status when waitForAgent=true (used after force-restart)
src/log-buffer.ts          — LogBuffer class (ring buffer for recent log lines), interceptConsole() to capture stdout/stderr
src/stop.ts                — POST /api/stop CLI (uses resolvePort())
src/restart.ts             — `copilotclaw restart` CLI: stop gateway → wait for shutdown → start (uses resolvePort())
src/setup.ts               — `copilotclaw setup` CLI: create workspace directories + auto-port selection (isPortAvailable, findAvailablePort from candidate list; saves port to config if default busy)
src/update.ts              — `copilotclaw update` CLI: fetches upstream to ~/.copilotclaw/source/ via getUpdateDir (git init + fetch --depth 1 + checkout FETCH_HEAD), pnpm (via npx -y pnpm@PNPM_VERSION, no global pnpm required) install + build, rewriteWorkspaceDeps converts workspace:* to file: paths in CLI package.json, npm install -g from packages/cli/; upstream from config file (COPILOTCLAW_UPSTREAM env var takes precedence); skips build if SHA unchanged
src/workspace.ts           — workspace paths: profile-aware (~/.copilotclaw/ or ~/.copilotclaw/workspace-{{profile}}/), data/, store.json; ensureWorkspace(); getUpdateDir() returns profile-independent source dir (~/.copilotclaw/source/); profile via COPILOTCLAW_PROFILE env var
src/store.ts               — persistent store (Channel, Message, per-channel pending queue); JSON file via atomic rename
src/channel-provider.ts    — ChannelProvider interface (plugin contract for chat mediums)
src/builtin-chat-channel.ts — BuiltinChatChannel: built-in chat UI provider (dashboard, SSE events, SSE broadcast via SseBroadcaster); passes compatibility info to dashboard
src/dashboard.ts           — HTML renderer (status bar with compatibility label, chat bubbles, channel tabs, input form, logs panel toggled via Logs button with stopPropagation to prevent status modal opening); status modal shows physical session details (with elapsed time, accumulated tokens in/out/total), subagent sessions, premium requests, available models; quota display uses /api/quota with fallback to latestQuotaSnapshots from session data; showSessionDetail() fetches and displays copilot session context detail via /api/sessions/:sessionId/messages
src/sse-broadcaster.ts                  — SseBroadcaster: SSE event broadcasting to connected clients
src/doctor.ts              — `copilotclaw doctor` CLI: checkWorkspace, checkConfig, checkGateway, checkAgent, checkZeroPremium diagnostics; runDoctor orchestrates checks and optional --fix (fixWorkspace, fixConfig, fixStaleSocket); exits 1 on failures
src/agent-manager.ts       — IPC-based agent process ensure at gateway start (spawn, version check, force-restart); uses createRequire to resolve @copilotclaw/agent package path; ensureAgent returns old bootId on force-restart; waitForNewAgent polls until different bootId appears; checkCompatibility() and getMinAgentVersion() methods; getQuota(), getModels(), and getSessionMessages() proxy to agent IPC; MIN_AGENT_VERSION exported; semverSatisfies exported (used by doctor)
src/ipc-client.ts          — IPC client (status/stop/quota/models/session_messages to agent process); AgentStatusResponse includes bootId field; PhysicalSessionSummary type (includes totalInputTokens, totalOutputTokens, latestQuotaSnapshots); SubagentInfo type; getAgentQuota(), getAgentModels(), and getAgentSessionMessages() functions
src/ipc-paths.ts           — socket path: profile-aware (copilotclaw-agent.sock or copilotclaw-agent-{{profile}}.sock in tmpdir)
```

### Workspace Layout

```
~/.copilotclaw/
  config.json                — config file (port, upstream, model, zeroPremium, debugMockCopilotUnsafeTools); env vars take precedence
  config-{{profile}}.json    — profile-specific config (when COPILOTCLAW_PROFILE set)
  source/                    — update source directory (profile-independent, shared across all profiles)
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
← {"version":"0.13.0","bootId":"uuid","startedAt":"...","sessions":{"sess-id":{"status":"waiting","startedAt":"...","boundChannelId":"ch-id","copilotSessionId":"...","physicalSession":{"sessionId":"...","model":"...","startedAt":"...","totalInputTokens":123,"totalOutputTokens":456,"latestQuotaSnapshots":{...}},"subagentSessions":[{"sessionId":"...","model":"...","status":"...","startedAt":"..."}]}}}

→ {"method":"session_status","params":{"sessionId":"sess-id"}}
← {"status":"processing","startedAt":"...","processingStartedAt":"...","boundChannelId":"ch-id"}
  (or {"status":"not_running"} if no session exists)

→ {"method":"stop"}
← {"ok":true}  → graceful shutdown of all sessions

→ {"method":"quota"}
← { ...quota object } | {"error":"no active session"}

→ {"method":"models"}
← { ...models object } | {"error":"no active session"}

→ {"method":"session_messages","params":{"sessionId":"copilot-sess-id"}}
← [ ...message objects ] | {"error":"session not found"} | {"error":"missing sessionId"}
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
src/index.ts                    — singleton entry, fetches config (model/zeroPremium/debugMockCopilotUnsafeTools) from gateway /api/status at startup, passes to AgentSessionManager; gateway polling loop, max-age check then stale detection per cycle; checks for saved sessions (hasSavedSession) when pending messages found, consumes saved copilotSessionId for deferred resume via startSession
src/agent-session-manager.ts    — per-session lifecycle, channel binding, model/zeroPremium/debugMockCopilotUnsafeTools fields; PhysicalSessionSummary (includes totalInputTokens, totalOutputTokens, latestQuotaSnapshots) and SubagentInfo types exported; SDK event tracking (tool.execution_start/complete, session.idle, subagent.started/completed/failed, session.model_change, assistant.usage for token accumulation and quota caching); getQuota() and getModels() methods (proxy Copilot SDK account API); getSessionMessages() method (retrieves conversation history from stored CopilotSession); stores copilotSession on entry for later message retrieval; resolveModel() method (zeroPremium overrides premium models to non-premium); debugMockCopilotUnsafeTools mode restricts availableTools to copilotclaw_* + debug debug mock copilot unsafe tools + WebFetch/WebSearch; deferred resume pattern: checkSessionMaxAge and checkStaleAndHandle save copilotSessionId to savedCopilotSessionIds map and stop session (no immediate restart/retry); hasSavedSession/consumeSavedSession for retrieval; max-age 2-day default; channel notifications (stopped/timed-out via postChannelMessage)
src/ipc-server.ts               — Unix domain socket IPC server (status/session_status/stop/quota/models/session_messages), version reporting
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

### Test Suites (186 total: 178 vitest + 8 Playwright)

```
Gateway vitest (142 tests) — unit + E2E tests with mock agent (includes config, config-cli, doctor, ipc-paths, setup, workspace tests)
Agent vitest (36 tests)    — unit tests with mock Copilot SDK session
Browser Playwright (8 tests) — test/browser/dashboard.spec.ts: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
```
