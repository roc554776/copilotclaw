<!-- Generated: 2026-03-27 | Updated: 2026-03-28 | Files scanned: 42 | Version: 0.36.0 | Token estimate: ~4000 -->

# Backend

## Gateway (packages/gateway)

### API Routes (server.ts)

```
GET  /healthz                              → 200 { status: "ok" }
POST /api/stop                             → 200 { status: "stopping" } → gateway exit only (localhost only, agent NOT stopped)
GET  /api/status                           → 200 { gateway: {status, version, profile}, agent: AgentStatusResponse|null, agentCompatibility: …|null, config: {model, zeroPremium, debugMockCopilotUnsafeTools, stateDir, workspaceRoot, auth: {type, user}, otel: OtelConfig|null} }  (auth extracted from config.auth?.github; otel from config.otel)
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
GET  /status                               → 200 HTML standalone SystemStatus page (same data as modal)
GET  /sessions/:sessionId/events          → 200 HTML session events stream page (flat/nested toggle, auto-scroll)
POST /api/session-events                  → 201 { ok: true } (agent posts SDK session events)
GET  /api/sessions/:sessionId/events      → 200 SessionEvent[] (events for a session, JSON Lines on disk)
GET  /api/session-events/sessions         → 200 string[] (session IDs with events)
GET  /api/system-prompts/original         → 200 SystemPromptSnapshot[] (all captured original prompts)
POST /api/system-prompts/original         → 201 { ok: true } (agent posts captured original system prompt)
GET  /api/system-prompts/original/:model  → 200 SystemPromptSnapshot | 404
POST /api/system-prompts/session          → 201 { ok: true } (agent posts session system prompt)
GET  /api/system-prompts/session/:id      → 200 { sessionId, model, prompt, capturedAt } | 404
GET  /                                    → 200 HTML dashboard (status bar + channel tabs + chat UI)
```

### Key Files

```
src/server.ts              — HTTP server, route handler, startServer(), GATEWAY_VERSION from package.json; /api/logs endpoint serves LogBuffer contents; /api/quota, /api/models, and /api/sessions/:sessionId/messages proxy to agent via agentManager; /api/status config includes stateDir from getStateDir(); ServerDeps accepts optional sessionEventStore; observability routes (session events, system prompts) gated on sessionEventStore presence; asset cache (assetCache Map) pre-loaded at startup from frontend-dist/ into memory; serveFrontend uses Map lookup for static asset serving (no sync I/O at request time); path traversal protection via exact key match against cached entries; falls back to server-rendered HTML via observability-pages.ts when frontend-dist/ not built; /status and /sessions/:id/events serve standalone HTML pages as fallback
src/frontend-dist.ts       — frontend build output utilities: FRONTEND_DIST_DIR (resolved path to frontend-dist/), FRONTEND_INDEX_HTML (path to index.html within it), hasFrontendDist() (checks existence of frontend-dist/ directory), isWithinFrontendDist() (validates a path is within the frontend-dist/ directory)
src/config.ts              — config file module: loadConfig, loadFileConfig, saveConfig, ensureConfigFile, resolvePort, getConfigFilePath, getStateDir, CONFIG_ENV_VARS, parseBool helper; profile-aware ({{stateDir}}/config.json where {{stateDir}}=~/.copilotclaw/ or ~/.copilotclaw-{{profile}}/); getStateDir() returns state dir base path (used by workspace.ts for workspace/ and data/ subdirs); env vars (COPILOTCLAW_PORT, COPILOTCLAW_UPSTREAM, COPILOTCLAW_MODEL, COPILOTCLAW_ZERO_PREMIUM, COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS) take precedence over file values; CopilotclawConfig includes configVersion, model, zeroPremium, debugMockCopilotUnsafeTools, auth, otel fields; OtelConfig interface (endpoints?: string[]); AuthContainerConfig wraps AuthConfig as `github` field (v0.25.0); AuthConfig interface defines auth configuration (type: "gh-cli"|"pat"|"command", plus type-specific fields); CopilotclawConfig.auth is AuthContainerConfig (not AuthConfig); loadConfig applies migrateConfig and writes back if migrated, passes through auth and otel from file config; saveConfig stamps LATEST_CONFIG_VERSION; ensureConfigFile includes configVersion; LATEST_CONFIG_VERSION = 3; MIGRATIONS registry for sequential schema migration (v1→v2: moves auth.* into auth.github.*; v2→v3: configVersion bump, no schema changes — otel is optional); migrateConfig(raw) applies migrations from current version to LATEST_CONFIG_VERSION, returns { config, migrated }
src/config-cli.ts          — `copilotclaw config` CLI: configGet (resolve + display, notes env var override), configSet (validate + save, warns if env var shadows); valid keys: upstream, port, model, zeroPremium, debugMockCopilotUnsafeTools; BOOLEAN_KEYS handling for zeroPremium/debugMockCopilotUnsafeTools
src/daemon.ts              — daemon entry point (ensureWorkspace + Store init + LogBuffer + OTel init + creates SessionEventStore + passes to startServer + periodic agent monitor every 30s); sets up IPC stream: agentManager.setStreamMessageHandler() routes agent messages (channel_message → store + SSE, session_event → SessionEventStore, system prompts → SessionEventStore, drain/peek/flush/list_messages → Store), agentManager.setConfigToSend() prepares config push, agentManager.connectStream() after agent ensure; graceful shutdown calls agentManager.closeStream()
src/index.ts               — CLI entry point (health check on resolvePort() → detached spawn → exit); reads GATEWAY_VERSION from package.json, shows version in all CLI log messages; parses --profile before command routing (sets COPILOTCLAW_PROFILE env var); after daemon healthy, checks /api/status agentCompatibility and exits 1 on incompatible; checkAgentCompatibility polls /api/status when waitForAgent=true (used after force-restart)
src/log-buffer.ts          — LogBuffer class (ring buffer for recent log lines), interceptConsole() to capture stdout/stderr; enableFileOutput(logFilePath) delegates structured writes to StructuredLogger
src/otel.ts                — OpenTelemetry setup: initOtel(endpoints, serviceName, serviceVersion), getLogger(component), getMeter(component), severityFromLevel(), shutdownOtel(); initializes LoggerProvider + MeterProvider with OTLP HTTP exporters; noop when no endpoints configured; metrics export interval 30s
src/otel-metrics.ts        — Application-level OTel metrics: initMetrics(), updateSessionCounts(active, suspended), recordTokens(input, output); gauges: copilotclaw.sessions.active, copilotclaw.sessions.suspended; counters: copilotclaw.tokens.input, copilotclaw.tokens.output
src/structured-logger.ts   — StructuredLogger class: writes JSON Lines (StructuredLogEntry) to file via appendFileSync; info()/error() methods; OtelLoggerBridge interface for optional OTel log bridging (constructor accepts optional otelLogger parameter); intentionally duplicated in agent package
src/stop.ts                — POST /api/stop CLI (uses resolvePort())
src/restart.ts             — `copilotclaw restart` CLI: stop gateway → wait for shutdown → start (uses resolvePort())
src/setup.ts               — `copilotclaw setup` CLI: create workspace directories + auto-port selection (isPortAvailable, findAvailablePort from candidate list; saves port to config if default busy); migrateWorkspaceFiles() migrates bootstrap files from state dir root to workspace/ subdirectory (v0.26→v0.27 transition, moves SOUL.md/AGENTS.md/USER.md/TOOLS.md/MEMORY.md and memory/ if present at old location); seedWorkspaceBootstrapFiles() generates SOUL.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md, memory/.gitkeep, and memory/ directory (v0.19.0); initWorkspaceGit() runs git init in workspace (v0.19.0); ensureWorkspaceReady(workspaceRoot) orchestrates full workspace setup: mkdirSync + initWorkspaceGit + seedWorkspaceBootstrapFiles + commitInitialWorkspaceFiles (idempotent, called by setup and doctor --fix); commitInitialWorkspaceFiles() does git add -A + commit if no commits yet; checkWorkspaceHealth(workspaceRoot) returns list of issues (missing dir, missing files, missing git init); isGitAvailable() checks git CLI availability
src/update.ts              — `copilotclaw update` CLI: fetches upstream to ~/.copilotclaw/source/ via getUpdateDir (git init + fetch --depth 1 + checkout FETCH_HEAD), pnpm (via npx -y pnpm@PNPM_VERSION, no global pnpm required) install + build (pnpm run build automatically builds both TypeScript and React frontend via gateway's build script), rewriteWorkspaceDeps converts workspace:* to file: paths in CLI package.json, npm install -g from packages/cli/; upstream from config file (COPILOTCLAW_UPSTREAM env var takes precedence); skips build if SHA unchanged; the installed package always includes the React SPA in frontend-dist/
src/workspace.ts           — workspace paths: getWorkspaceRoot() returns {{stateDir}}/workspace/ (e.g. ~/.copilotclaw/workspace/ default, ~/.copilotclaw-{{profile}}/workspace/ profiled); getDataDir() returns {{stateDir}}/data/ (directly under state dir, not workspace); getStoreDbPath() derives store.db from data dir (v0.29.0); getStoreFilePath() deprecated — derives store.json from data dir, kept for legacy JSON migration only; ensureWorkspace() creates both data/ and workspace/ directories; getUpdateDir() returns profile-independent source dir (~/.copilotclaw/source/); profile via COPILOTCLAW_PROFILE env var
src/store.ts               — persistent store (Channel, Message, per-channel pending queue); SQLite via better-sqlite3 (WAL mode, foreign keys); tables: channels (id PK, createdAt), messages (id PK, channelId FK, sender, message, createdAt; indexed by channelId+createdAt), pending_queue (autoincrement id, channelId FK, messageId FK; indexed by channelId); StoreOptions accepts persistPath (SQLite file, default :memory:) and legacyJsonPath (one-time migration from store.json when DB is empty); close() method
src/channel-provider.ts    — ChannelProvider interface (plugin contract for chat mediums)
src/builtin-chat-channel.ts — BuiltinChatChannel: built-in chat UI provider (dashboard, SSE events, SSE broadcast via SseBroadcaster); passes compatibility info to dashboard; uses hasFrontendDist() from frontend-dist.ts for frontend availability check
src/session-event-store.ts — SessionEventStore: SQLite-based event storage (session-events.db in dataDir, WAL mode); table: session_events (autoincrement id, sessionId, type, timestamp, data as JSON text, parentId; indexed by sessionId, sessionId+timestamp, type); storage cap by row count (default 100k) enforced every 500 inserts by deleting oldest rows; system prompt snapshots remain as JSON files in {{dataDir}}/prompts/ (original: {{model}}.json, session: session-{{sessionId}}.json); close() method
src/observability-pages.ts — renderStatusPage() and renderEventsPage(): standalone HTML pages for system status and session events stream (flat/nested toggle, auto-scroll); status page shows stopped session history per session via <details> element (v0.30.0); renderSessionsListPage() fallback page title/heading: "Sessions" (v0.36.0, changed from "Physical Sessions"); physical session history label: "Physical sessions (N)" (unchanged — correctly describes physical sessions under an abstract session); link text to /sessions: "All sessions →" (v0.36.0, changed from "All physical sessions →")
src/dashboard.ts           — HTML renderer (status bar with compatibility label, chat bubbles, channel tabs, input form, logs panel toggled via Logs button with stopPropagation to prevent status modal opening); status modal shows physical session details (with elapsed time, accumulated tokens in/out/total), cumulative tokens across physical sessions (v0.27.0), subagent sessions, premium requests, available models; quota display uses /api/quota with fallback to latestQuotaSnapshots from session data; showSessionDetail() fetches and displays copilot session context detail via /api/sessions/:sessionId/messages; modal includes "Open in new tab" link to /status page; physical sessions have "View events" link to /sessions/:id/events; stopped session history shown as collapsed toggle ("Stopped sessions (N) ▸") with model, tokens, started time, and events link per entry (v0.30.0)
src/sse-broadcaster.ts                  — SseBroadcaster: SSE event broadcasting to connected clients
frontend/                  — Vite + React + TypeScript SPA (v0.32.0); see Frontend section below
src/doctor.ts              — `copilotclaw doctor` CLI: checkWorkspace, checkConfig, checkGateway, checkAgent, checkZeroPremium, checkAuth diagnostics; checkWorkspace uses checkWorkspaceHealth from setup.ts to verify workspace files and git init; checkConfig validates configVersion (warns if missing or unexpected); checkAuth reads config.auth?.github (v0.25.0); runDoctor orchestrates checks and optional --fix (fixWorkspace calls ensureWorkspaceReady, fixConfig, fixStaleSocket); exits 1 on failures
src/agent-manager.ts       — IPC-based agent process ensure at gateway start (spawn, version check, force-restart); uses createRequire to resolve @copilotclaw/agent package path; ensureAgent returns old bootId on force-restart; waitForNewAgent polls until different bootId appears; checkCompatibility() and getMinAgentVersion() methods; getQuota(), getModels(), and getSessionMessages() proxy to agent IPC; MIN_AGENT_VERSION exported (0.36.0); semverSatisfies exported (used by doctor); agent stderr redirected to {{stateDir}}/data/agent.log on spawn (openSync append mode); COPILOTCLAW_GATEWAY_URL no longer set in spawn env (v0.35.0); IPC stream management: connectStream(), setStreamMessageHandler(), setConfigToSend(), notifyPending(), closeStream(); reconnectStream() private method closes existing stream and reconnects (called after spawning new agent or force-restart); StreamMessageHandler interface for routing agent messages (channel_message → store + SSE, session_event → SessionEventStore, system prompts → SessionEventStore, drain/peek/flush/list_messages → Store)
src/ipc-client.ts          — IPC client (status/stop/quota/models/session_messages to agent process via short-lived connections); AgentStatusResponse includes bootId field; AgentSessionStatusResponse status includes "suspended" (v0.27.0 fix), cumulativeInputTokens, cumulativeOutputTokens (v0.27.0), physicalSessionHistory (PhysicalSessionSummary[], v0.30.0); PhysicalSessionSummary type (includes totalInputTokens, totalOutputTokens, latestQuotaSnapshots); SubagentInfo type; getAgentQuota(), getAgentModels(), and getAgentSessionMessages() functions; IpcStream class (v0.35.0): persistent bidirectional connection to agent socket via {"method":"stream"} handshake, auto-reconnect on disconnect, send() for fire-and-forget, request() for id-correlated request-response; createStreamConnection() factory
src/ipc-paths.ts           — socket path: profile-aware (copilotclaw-agent.sock or copilotclaw-agent-{{profile}}.sock in tmpdir)
```

### Workspace Layout

```
~/.copilotclaw/                  (state dir, default profile)
  config.json                — default profile config (configVersion, port, upstream, model, zeroPremium, debugMockCopilotUnsafeTools, otel); auto-migrated on load (v3); env vars take precedence
  source/                    — update source directory (profile-independent, shared across all profiles)
  data/
    store.db                 — SQLite database for channels, messages, pending queues (WAL mode, v0.29.0; migrated from store.json on first run)
    store.json               — legacy JSON store (deprecated, kept only for one-time migration to store.db)
    session-events.db        — SQLite database for session events (WAL mode, v0.29.0; row-count capped at 100k default)
    agent-bindings.json      — persisted channel bindings and suspended sessions (atomic write, v0.19.0); includes cumulative token data (v0.27.0)
    gateway.log              — structured JSON Lines log from gateway (via LogBuffer + StructuredLogger)
    agent.log                — structured JSON Lines log from agent (via StructuredLogger) + agent stderr capture
    events/                  — (removed in v0.29.0, replaced by session-events.db)
    prompts/                 — system prompt snapshots ({{model}}.json for originals, session-{{sessionId}}.json for session prompts)
  workspace/                   (workspace root, v0.27.0 — previously bootstrap files were at state dir root)
    SOUL.md                  — agent persona and core truths (generated v0.19.0)
    AGENTS.md                — workspace conventions and memory guidelines (generated v0.19.0)
    USER.md                  — user context and preferences (generated v0.19.0)
    TOOLS.md                 — available tools and local notes (generated v0.19.0)
    MEMORY.md                — long-term curated memory (generated v0.19.0)
    memory/
      YYYY-MM-DD.md          — daily session logs (agent-created)
    .git/                    — git repo (initialized v0.19.0 if git available)

~/.copilotclaw-{{profile}}/     (state dir, named profile)
  config.json                — profile-specific config (when COPILOTCLAW_PROFILE set)
  data/                      — same structure as default profile data/
  workspace/                 — same structure as default profile workspace/
```

## Agent (packages/agent)

### IPC Protocol (newline-delimited JSON over Unix domain socket)

```
→ {"method":"status"}
← {"version":"0.17.0","bootId":"uuid","startedAt":"...","sessions":{"sess-id":{"status":"waiting|suspended","startedAt":"...","boundChannelId":"ch-id","copilotSessionId":"...","cumulativeInputTokens":N,"cumulativeOutputTokens":N,"physicalSession":{...},"subagentSessions":[...],"physicalSessionHistory":[...]}}}

→ {"method":"session_status","params":{"sessionId":"sess-id"}}
← {"status":"waiting|processing|suspended|stopped","startedAt":"...","processingStartedAt":"...","boundChannelId":"ch-id"}
  (or {"status":"not_running"} if no session exists)

→ {"method":"stop"}
← {"ok":true}  → graceful shutdown of all sessions

→ {"method":"quota"}
← { ...quota object } | {"error":"no active session"}

→ {"method":"models"}
← { ...models object } | {"error":"no active session"}

→ {"method":"session_messages","params":{"sessionId":"copilot-sess-id"}}
← [ ...message objects ] | {"error":"session not found"} | {"error":"missing sessionId"}

→ {"method":"stream"}
← {"ok":true}  → connection upgrades to persistent bidirectional stream (newline-delimited JSON)
```

**IPC Stream Protocol (v0.35.0)** — persistent bidirectional channel alongside short-lived connections:

Gateway → Agent push:
```
{"type":"config","config":{...}}                — sent immediately when stream opens
{"type":"pending_notify","channelId":"...","count":N}  — new pending user message
```

Agent → Gateway push (fire-and-forget):
```
{"type":"channel_message","channelId":"...","sender":"agent","message":"..."}
{"type":"session_event","sessionId":"...","eventType":"...","timestamp":"...","data":{...}}
{"type":"system_prompt_original","model":"...","prompt":"...","capturedAt":"..."}
{"type":"system_prompt_session","sessionId":"...","model":"...","prompt":"..."}
```

Agent → Gateway request-response (id-correlated):
```
→ {"type":"drain_pending","id":"uuid","channelId":"..."}
← {"type":"response","id":"uuid","data":[...messages]}

→ {"type":"peek_pending","id":"uuid","channelId":"..."}
← {"type":"response","id":"uuid","data":{...}|null}

→ {"type":"flush_pending","id":"uuid","channelId":"..."}
← {"type":"response","id":"uuid","data":{"flushed":N}}

→ {"type":"list_messages","id":"uuid","channelId":"...","limit":N}
← {"type":"response","id":"uuid","data":[...messages]}
```

**Status values (v0.18.0)**:
- "starting" — session initializing, copilotClient not yet bound
- "waiting" — idle, awaiting user input (keepalive tool polling gateway)
- "processing" — handling tool calls or LLM requests
- "suspended" — physical session ended, abstract session preserved for later revival (copilotSessionId retained); persisted to disk if persistPath configured
- "stopped" — session fully removed via explicit stopSession()

### Copilot SDK Tools (tools/channel.ts)

```
copilotclaw_send_message(message)   — send a message to the channel (non-blocking)
copilotclaw_wait()         — block polling for pending user messages (25 min keepalive timeout); drains subagent completion queue and includes completion info in response; wrapped in try-catch that catches ALL exceptions and returns keepalive response (errors logged to console.error only — agent must not perceive errors)
copilotclaw_list_messages(limit?)   — list recent channel messages (reverse-chronological)
```

Tool availability:
- **channel-operator** (parent): receives all three tools
- **worker** (subagent): receives only send_message and list_messages (never wait, preventing deadlock if worker attempts to block)

### SDK Hooks

- `onPostToolUse` — executes after each tool call; gates on `copilotclaw_wait` (the sole parent-exclusive tool) to avoid injecting reminders/notifications into subagent tool calls (SDK hook system provides no mechanism to distinguish parent vs subagent calls); performs three checks:
  - Pending message detection: peeks channel for pending user messages, injects notification into additionalContext
  - Subagent completion notification (v0.16.0+): drains subagent completion queue, injects `[SUBAGENT COMPLETED]` tagged notifications with agent name, status, tokens, and duration
  - System prompt reinforcement (v0.15.0+): fires periodic reminders via `<system>` tagged additionalContext when context usage crosses 10% increments or after compaction; maintains reminderState (needsReminder, lastReminderPercent, currentUsagePercent) to avoid firing on every tool call

### Key Files

```
src/index.ts                    — singleton entry; waits for gateway IPC stream connection and config push (replaces HTTP fetch of /api/status); resolves auth token from config via token-resolver; listens for pending_notify IPC push messages to start sessions (replaces HTTP polling); initializes OTel from gateway config; uses hasActiveSessionForChannel to avoid starting duplicate sessions; startSession auto-revives suspended sessions; periodic stale/max-age checks via setInterval (peek_pending and flush_pending via IPC request-response); passes persistPath to AgentSessionManager; calls ipc.setSessionManager(sessionManager) after creating AgentSessionManager to inject session manager into IPC server; module-level log/logError functions with structured JSON fallback (console.error with JSON.stringify) before StructuredLogger is initialized; no COPILOTCLAW_GATEWAY_URL or gatewayBaseUrl (v0.35.0)
src/agent-session-manager.ts    — per-session lifecycle with abstract/physical session separation (v0.18.0); PARENT_ONLY_TOOL constant ("copilotclaw_wait"); channel binding persistence (v0.19.0): AgentSessionManagerOptions accepts persistPath, githubToken, log, and logError (structured JSON fallback via defaultLog/defaultLogError when not provided; no gatewayBaseUrl or fetch since v0.35.0); all gateway communication via IPC: postToGateway(msg) calls sendToGateway, postChannelMessage calls sendToGateway with type "channel_message", onPostToolUse peek uses requestFromGateway; SDK event forwarding uses postToGateway with type "session_event" (eventType field for inner event type), system prompts via "system_prompt_original"/"system_prompt_session"; createClient() method creates CopilotClient with githubToken when provided; loadBindings/saveBindings for agent-bindings.json persistence; SessionSnapshot includes cumulativeInputTokens/cumulativeOutputTokens (v0.27.0), physicalSessionHistory (v0.30.0); startSession auto-revives suspended sessions; suspendSession accumulates tokens via delta calculation when same physical session is resumed (compares against last history entry to compute delta); checkSessionMaxAge suspends and clears copilotSessionId (so next revival creates a new physical session); checkStaleAndHandle for stale processing lifecycle management; resumeSession/createSession branching based on copilotSessionId presence (no fallback — one or the other); resolveModel handles zeroPremium override; custom agents: CHANNEL_OPERATOR_CONFIG + WORKER_CONFIG; ensureWorkspaceReady() called at runSession start; channelBackoff map tracks rapid-failure backoff
src/token-resolver.ts           — resolves GitHub tokens from auth config; supports gh-cli (gh auth token), PAT (via env var or file), and custom command strategies
src/otel.ts                     — OpenTelemetry setup for agent process: initOtel(endpoints, serviceName, serviceVersion), getLogger(component), shutdownOtel(); intentionally duplicated from gateway (self-contained, no shared dependency); uses serviceName "copilotclaw-agent"
src/structured-logger.ts        — StructuredLogger class: writes JSON Lines (StructuredLogEntry) to file via appendFileSync; info()/error() methods; OtelLoggerBridge interface for optional OTel log bridging (constructor accepts optional otelLogger parameter); intentionally duplicated in gateway package
src/ipc-server.ts               — Unix domain socket IPC server (status/session_status/stop/quota/models/session_messages); AgentIpcServerHandle returned by listenIpc includes setSessionManager(mgr) method for deferred injection of session manager after construction; handleConnection uses sessionManagerRef: { current: AgentSessionManager | null } mutable ref pattern — all IPC handlers read sessionManagerRef.current (null-safe via ?? and !== null guards) allowing the session manager to be injected after the IPC server is already listening; IPC stream support (v0.35.0): detects {"method":"stream"} to upgrade connection to persistent bidirectional channel; module-level stream socket with sendToGateway() (fire-and-forget), requestFromGateway() (id-correlated request-response with 15s timeout), streamEvents EventEmitter for push message handlers; handleStreamMessage routes incoming messages (response correlation, type-based event emission)
src/ipc-paths.ts                — socket path generation (profile-aware)
src/session-loop.ts             — session idle loop (subscribe/send/disconnect); supports both createSession and resumeSession
src/copilot-session-adapter.ts  — CopilotSession → SessionLike adapter
src/stop.ts                     — CLI stop command (IPC stop)
src/tools/channel.ts            — WAIT_TOOL_NAME constant ("copilotclaw_wait"), wait variable (defineTool); send_message (via sendToGateway IPC), wait (drains pending via requestFromGateway IPC, waits for pending_notify push; try-catch swallows ALL exceptions → keepalive response, logError with structured JSON fallback only), list_messages (via requestFromGateway IPC); ChannelToolDeps accepts optional logError (falls back to structured JSON on console.error); no HTTP fetch (v0.35.0); exports SubagentCompletionInfo
```

## Frontend SPA (packages/gateway/frontend, v0.32.0)

Vite + React + TypeScript single-page application. Built to `frontend-dist/` and served by gateway server with fallback to old server-rendered pages.

### Routes (App.tsx via react-router-dom)

```
/                              → DashboardPage (chat UI with channels, SSE, status bar, logs panel)
/status                        → StatusPage (gateway, agent, sessions, config, system prompts; elapsed time helper; 5s auto-refresh)
/sessions                      → SessionsListPage (abstract sessions from /api/status with physical sessions as children; ?focus= URL param for scroll-to; orphaned physical sessions listed separately)
/sessions/:sessionId/events    → SessionEventsPage (flat event list with event count in heading, auto-scroll; 2s auto-refresh; "Back to Sessions" link with ?focus= param targeting parent abstract session)
```

### Key Files

```
index.html                     — SPA entry point
vite.config.ts                 — Vite config (React plugin, build output to ../frontend-dist/)
vitest.config.ts               — Vitest config for frontend tests (jsdom environment)
src/main.tsx                   — React DOM root mount
src/App.tsx                    — BrowserRouter with route definitions
src/global.css                 — Global styles
src/api.ts                     — Typed fetch wrappers for all gateway API endpoints (Channel, Message, StatusResponse, SessionEvent, QuotaResponse, ModelsResponse, etc.)
src/hooks/useAutoScroll.ts     — Position-based auto-scroll hook (follows bottom, disengages on scroll-up, re-engages at bottom)
src/hooks/usePolling.ts        — Generic polling hook (immediate call + setInterval, cleanup on unmount)
src/pages/DashboardPage.tsx    — Chat dashboard (channel management, message list, input form, SSE events, status bar, logs panel)
src/pages/StatusPage.tsx       — System status page (gateway/agent/sessions/config display, elapsed time helper, session prompt loading, cumulative tokens, physical session history); sessions link text: "All sessions →" (v0.36.0)
src/pages/SessionsListPage.tsx — Sessions list: fetches abstract sessions from /api/status, renders each with physical sessions (current + history) as children; orphaned physical sessions (not in any abstract session) listed separately with event counts and model; supports ?focus= URL param to highlight and scroll-to an abstract session
src/pages/SessionEventsPage.tsx — Session event viewer (flat event list, event count display, auto-scroll via useAutoScroll, 2s polling via usePolling; "Back to Sessions" link with ?focus= param targeting parent abstract session; resolves parent abstract session from /api/status)
src/__tests__/setup.ts         — Test setup (jsdom + @testing-library/jest-dom matchers)
src/__tests__/*.test.tsx       — Component tests (SessionEventsPage, StatusPage, DashboardPage, SessionsListPage, useAutoScroll)
```

### Build Scripts (in packages/gateway/package.json)

```
build                          — tsc && cd frontend && vite build (compiles TypeScript server AND builds React SPA to frontend-dist/); npm `files` field includes frontend-dist/ so the SPA is always packaged
build:frontend                 — cd frontend && npx vite build (outputs to frontend-dist/)
dev:frontend                   — cd frontend && npx vite (dev server with HMR)
test:frontend                  — cd frontend && npx vitest run
```

## Testing

### Configuration

```
vitest.config.ts           — vitest config; excludes test/browser/ (Playwright-managed)
playwright.config.ts       — Playwright config for browser E2E tests
```

### Test Suites (356 total: 348 vitest + 8 Playwright)

```
Gateway vitest (226 tests)   — unit + E2E tests with mock agent (includes config, config-cli, config-migration, doctor, ipc-paths, setup, workspace, structured-logger, session-event-store tests)
Agent vitest (91 tests)      — unit tests with mock Copilot SDK session + IPC stream tests (includes structured-logger, token-resolver, ipc-stream tests)
Frontend vitest (31 tests)   — React SPA component tests (SessionEventsPage, StatusPage, DashboardPage, SessionsListPage, useAutoScroll) via jsdom + @testing-library/react
Browser Playwright (8 tests) — test/browser/dashboard.spec.ts: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
```
