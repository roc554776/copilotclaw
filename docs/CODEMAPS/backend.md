<!-- Generated: 2026-03-27 | Updated: 2026-03-31 | Files scanned: 44 | Version: 0.50.0 | Token estimate: ~4600 -->

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
GET  /api/channels                         → 200 Channel[] (?includeArchived=true to include archived)
POST /api/channels                         → 201 Channel
PATCH /api/channels/:id                    → 200 Channel (archive/unarchive via { archived: boolean })
GET  /api/channels/pending                 → 200 { [channelId]: count }
GET  /api/channels/:channelId/messages              → 200 Message[] (?limit=N&before=rowid, reverse-chronological, cursor-based pagination via rowid)
POST /api/channels/:channelId/messages              → 201 Message (sender: "user"|"agent"|"cron"|"system", user/cron/system messages go to pending queue)
POST /api/channels/:channelId/messages/pending      → 200 Message[] | 204 (drain all pending user messages)
GET  /api/channels/:channelId/messages/pending/peek → 200 Message | 204 (oldest pending, non-destructive)
POST /api/channels/:channelId/messages/pending/flush → 200 { flushed: count }
GET  /status                               → 200 HTML standalone SystemStatus page (same data as modal)
GET  /sessions/:sessionId/events          → 200 HTML session events stream page (flat/nested toggle, auto-scroll)
POST /api/session-events                  → 201 { ok: true } (agent posts SDK session events)
GET  /api/sessions/:sessionId/events      → 200 SessionEvent[] (events for a session; accepts ?limit=N&before=id&after=id for cursor-based pagination via getEventsPaginated)
GET  /api/session-events/sessions         → 200 string[] (session IDs with events)
GET  /api/token-usage                     → 200 TokenUsageEntry[] (?hours=5 default, or ?from=ISO&to=ISO for custom range; proxied from SessionEventStore.getTokenUsage)
GET  /api/system-prompts/original         → 200 SystemPromptSnapshot[] (all captured original prompts)
POST /api/system-prompts/original         → 201 { ok: true } (agent posts captured original system prompt)
GET  /api/system-prompts/original/:model  → 200 SystemPromptSnapshot | 404
POST /api/system-prompts/effective        → 201 { ok: true } (agent posts effective system prompt)
GET  /api/system-prompts/effective/:id    → 200 { sessionId, model, prompt, capturedAt } | 404
GET  /                                    → 200 HTML dashboard (status bar + channel tabs + chat UI)
```

### Key Files

```
src/server.ts              — HTTP server, route handler, startServer(), GATEWAY_VERSION from package.json; /api/logs endpoint serves LogBuffer contents; /api/quota, /api/models, and /api/sessions/:sessionId/messages proxy to agent via agentManager; /api/status config includes stateDir from getStateDir(); /api/status merges orchestratorSessions into agent.sessions (single data source for frontend — orchestrator data merged directly into agent session entries rather than returned separately, v0.49.0); ServerDeps accepts optional sessionEventStore and sessionOrchestrator; observability routes (session events, system prompts, token usage) gated on sessionEventStore presence; GET /api/token-usage accepts ?hours=5 (default) or ?from=ISO&to=ISO query params, delegates to SessionEventStore.getTokenUsage; PATCH /api/channels/:id for archive/unarchive; GET /api/channels supports ?includeArchived=true query param; POST /api/channels/:channelId/messages sender parsing accepts "cron" (in addition to "user"|"agent"), cron sender triggers agent_notify; asset cache (assetCache Map) pre-loaded at startup from frontend-dist/ into memory; serveFrontend uses Map lookup for static asset serving (no sync I/O at request time); path traversal protection via exact key match against cached entries; falls back to server-rendered HTML via observability-pages.ts when frontend-dist/ not built; /status and /sessions/:id/events serve standalone HTML pages as fallback
src/frontend-dist.ts       — frontend build output utilities: FRONTEND_DIST_DIR (resolved path to frontend-dist/), FRONTEND_INDEX_HTML (path to index.html within it), hasFrontendDist() (checks existence of frontend-dist/ directory), isWithinFrontendDist() (validates a path is within the frontend-dist/ directory)
src/config.ts              — config file module: loadConfig, loadFileConfig, saveConfig, ensureConfigFile, resolvePort, getConfigFilePath, getStateDir, CONFIG_ENV_VARS, parseBool helper; profile-aware ({{stateDir}}/config.json where {{stateDir}}=~/.copilotclaw/ or ~/.copilotclaw-{{profile}}/); getStateDir() returns state dir base path (used by workspace.ts for workspace/ and data/ subdirs); env vars (COPILOTCLAW_PORT, COPILOTCLAW_UPSTREAM, COPILOTCLAW_MODEL, COPILOTCLAW_ZERO_PREMIUM, COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS) take precedence over file values; CopilotclawConfig includes configVersion, model, zeroPremium, debugMockCopilotUnsafeTools, auth, otel, debug, cron fields; CronJobConfig interface (schedule/interval definition for periodic tasks; enabled?: boolean, default true — disabled jobs skipped at startup); cron?: CronJobConfig[] optional array of cron job definitions; DebugConfig interface (logLevel?: "info"|"debug"); OtelConfig interface (endpoints?: string[]); AuthContainerConfig wraps AuthConfig as `github` field (v0.25.0); AuthConfig interface defines auth configuration (type: "gh-cli"|"pat"|"command", plus type-specific fields); CopilotclawConfig.auth is AuthContainerConfig (not AuthConfig); loadConfig applies migrateConfig and writes back if migrated, passes through auth, otel, debug, and cron from file config; saveConfig stamps LATEST_CONFIG_VERSION; ensureConfigFile includes configVersion; LATEST_CONFIG_VERSION = 4; MIGRATIONS registry for sequential schema migration (v1→v2: moves auth.* into auth.github.*; v2→v3: configVersion bump, no schema changes — otel is optional; v3→v4: configVersion bump, no schema changes — debug is optional); migrateConfig(raw) applies migrations from current version to LATEST_CONFIG_VERSION, returns { config, migrated }
src/config-cli.ts          — `copilotclaw config` CLI: configGet (resolve + display, notes env var override), configSet (validate + save, warns if env var shadows); valid keys: upstream, port, model, zeroPremium, debugMockCopilotUnsafeTools; BOOLEAN_KEYS handling for zeroPremium/debugMockCopilotUnsafeTools
src/agent-config.ts        — defines AgentPromptConfig and CustomAgentDef interfaces; getAgentPromptConfig() function returns prompt configuration containing CHANNEL_OPERATOR_PROMPT, SYSTEM_REMINDER, custom agent definitions (customAgents[] with primaryAgentName, replacing previous channel-operator/worker pair), and session timing config (initialPrompt, staleTimeoutMs, maxSessionAgeMs, rapidFailureThresholdMs, backoffDurationMs, keepaliveTimeoutMs, reminderThresholdPercent); AgentPromptConfig also includes knownSections (configurable list of known system prompt sections), maxQueueSize (agent send queue cap), clientOptions (passthrough options for CopilotClient constructor), sessionConfigOverrides (merged into SDK session base config); resolveModel(modelsResponse, configModel, zeroPremium) function for gateway-side model selection: sorts by billing multiplier, filters non-premium when zeroPremium, returns model ID or undefined (v0.50.0); CHANNEL_OPERATOR_PROMPT updated with Cron Tasks section (instructions for handling cron-triggered messages) and Subagent Rules section (v0.41.0); gateway owns all prompt and timing config and sends them to agent via IPC config push (v0.40.0)
src/daemon.ts              — daemon entry point (ensureWorkspace + Store init + LogBuffer + OTel init + creates SessionEventStore + passes to startServer + periodic agent monitor every 30s); sets up IPC stream: agentManager.setStreamMessageHandler() routes agent messages (channel_message → store + SSE, session_event → SessionEventStore + subagent completion handling + orchestrator state updates, system prompts → SessionEventStore, drain/peek/flush/list_messages → Store, physical_session_started → orchestrator status/physical session update, physical_session_ended → backoff check + orchestrator suspend + channel notification + flush pending, running_sessions → orchestrator.reconcileWithAgent + checkAllChannelsPending); onSessionEvent receives channelId from agent, detects subagent.completed/failed for direct calls (no parentToolCallId), inserts system message into channel + sends agent_notify (v0.43.0); onSessionEvent also routes SDK events to orchestrator real-time state update methods (tool.execution_start/complete → updatePhysicalSessionState, session.idle → updatePhysicalSessionState, assistant.usage → accumulateUsageTokens, session.usage_info → updatePhysicalSessionTokens, session.model_change → updatePhysicalSessionModel, subagent.started → addSubagentSession, subagent.completed/failed → updateSubagentStatus); onPhysicalSessionEnded simplified — no longer reads token totals from message (tokens tracked via real-time events); agentManager.setConfigToSend() prepares config push (includes debug config and prompts from getAgentPromptConfig), agentManager.connectStream() after agent ensure; SessionOrchestrator with SQLite persistence (session-orchestrator.db) and legacy agent-bindings.json migration (v0.49.0); startSessionForChannel is async (v0.50.0): checks backoff + hasActiveSession, calls orchestrator.startSession(), resolves model via resolveModel(agentManager.getModels(), config.model, zeroPremium), then calls agentManager.startPhysicalSession(sessionId, channelId, copilotSessionId, resolvedModel); checkAllChannelsPending iterates channels for pending messages; onStreamConnected waits for agent running_sessions report for reconciliation (v0.50.0); onStreamDisconnected suspends all active sessions via orchestrator.suspendAllActive(); periodic orchestrator check (30s): checkAllChannelsPending + maxAge check (stop physical session + suspend via orchestrator); cron scheduler loop: reads config.cron, skips jobs with enabled===false (v0.42.0), sets up setInterval per job, dedup check via store.hasPendingCronMessage(), sends cron message + startSessionForChannel + agent_notify (v0.43.0); graceful shutdown calls orchestrator.close() + agentManager.closeStream()
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
src/store.ts               — persistent store (Channel, Message, per-channel pending queue); SQLite via better-sqlite3 (WAL mode, foreign keys); tables: channels (id PK, createdAt, archivedAt nullable), messages (id PK, channelId FK, sender REFERENCES message_senders(sender), message, createdAt; indexed by channelId+createdAt), message_senders (sender TEXT PK; values: "user", "agent", "cron", "system"), pending_queue (autoincrement id, channelId FK, messageId FK; indexed by channelId), store_schema_version (version INTEGER); versioned schema migration: LATEST_STORE_VERSION=2, STORE_MIGRATIONS registry (v0→v1: add archivedAt column to channels, v1→v2: replace CHECK constraint with message_senders FK table + add "cron" and "system" senders); initSchema() creates base tables (version 0) + store_schema_version, reads current version, applies sequential migrations, persists version; Message.sender type is "user"|"agent"|"cron"|"system"; addMessage accepts "cron" and "system" senders, cron and system messages go to pending queue (same as user); listMessages(channelId, limit?, before?) supports cursor-based pagination via optional `before` parameter (rowid-based: WHERE rowid < before); hasPendingCronMessage(channelId) checks for existing pending cron messages (used for dedup by cron scheduler); archiveChannel(id) sets archivedAt timestamp, unarchiveChannel(id) clears it; listChannels({ includeArchived }) filters archived channels by default; StoreOptions accepts persistPath (SQLite file, default :memory:) and legacyJsonPath (one-time migration from store.json when DB is empty); close() method
src/session-orchestrator.ts — SessionOrchestrator: manages abstract session lifecycle (start, suspend, stop, revive) on gateway side (v0.49.0); SQLite-backed persistence (abstract_sessions table: sessionId PK, channelId, status, startedAt, copilotSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory JSON; WAL mode); in-memory maps: sessions (sessionId → AbstractSession), channelBindings (channelId → sessionId), channelBackoff (channelId → expiresAt, ephemeral not persisted); AbstractSession type includes physicalSession (current), subagentSessions, processingStartedAt; startSession(channelId) revives suspended session if bound to channel, otherwise creates new; suspendSession(sessionId) accumulates tokens from physicalSession, pushes to history, clears physical/subagent state; stopSession(sessionId) fully removes session and channel binding; suspendAllActive() suspends all non-suspended sessions (used on stream disconnect); reconcileWithAgent(runningSessions) reconciles orchestrator state with agent's actually-running physical sessions — revives suspended sessions still alive in agent (remaps sessionId if mismatched), creates new abstract sessions for unknown running sessions (v0.50.0); updateSessionStatus(), updatePhysicalSession() for gateway-side state tracking; real-time event-driven state update methods: findSessionByCopilotId(copilotSessionId) locates session by its physical copilot session ID, updatePhysicalSessionState(sessionId, state) updates current physical session processing state, updatePhysicalSessionTokens(sessionId, input, output) sets token counters on physical session, accumulateUsageTokens(sessionId, input, output) increments token counters from assistant.usage events, updatePhysicalSessionModel(sessionId, model) updates physical session model, addSubagentSession(sessionId, subagentInfo) adds subagent to session's subagent list, updateSubagentStatus(sessionId, subagentId, status) updates subagent session status; hasSessionForChannel(), hasActiveSessionForChannel(), isChannelInBackoff(), recordBackoff(), checkSessionMaxAge(), getSessionIdForChannel() query methods; getSessionStatuses() returns snapshot of all sessions; persistSession() upserts on every mutation; deleteSessionFromDb() on stop; loadFromDb() on construction; legacy migration from agent-bindings.json or session-orchestrator.json (one-time, renames to .migrated); close() method
src/channel-provider.ts    — ChannelProvider interface (plugin contract for chat mediums)
src/builtin-chat-channel.ts — BuiltinChatChannel: built-in chat UI provider (dashboard, SSE events, SSE broadcast via SseBroadcaster); passes compatibility info to dashboard; uses hasFrontendDist() from frontend-dist.ts for frontend availability check
src/session-event-store.ts — SessionEventStore: SQLite-based event storage (session-events.db in dataDir, WAL mode); table: session_events (autoincrement id, sessionId, type, timestamp, data as JSON text, parentId; indexed by sessionId, sessionId+timestamp, type); storage cap by row count (default 100k) enforced every 500 inserts by deleting oldest rows; getEventsPaginated(sessionId, limit, {before?, after?}) for cursor-based pagination by autoincrement id; getEventCount(sessionId) returns total event count for a session; getTokenUsage(from, to) aggregates assistant.usage events by model within time range, returns per-model input/output token totals; system prompt snapshots remain as JSON files in {{dataDir}}/prompts/ (original: {{model}}.json, effective: effective-{{sessionId}}.json); close() method
src/observability-pages.ts — renderStatusPage() and renderEventsPage(): standalone HTML pages for system status and session events stream (flat/nested toggle, auto-scroll); status page shows stopped session history per session via <details> element (v0.30.0); renderSessionsListPage() fallback page title/heading: "Sessions" (v0.36.0, changed from "Physical Sessions"); physical session history label: "Physical sessions (N)" (unchanged — correctly describes physical sessions under an abstract session); link text to /sessions: "All sessions →" (v0.36.0, changed from "All physical sessions →")
src/dashboard.ts           — HTML renderer (status bar with compatibility label, chat bubbles, channel tabs, input form, logs panel toggled via Logs button with stopPropagation to prevent status modal opening); status modal shows physical session details (with elapsed time, accumulated tokens in/out/total), cumulative tokens across physical sessions (v0.27.0), subagent sessions, premium requests, available models; quota display uses /api/quota with fallback to latestQuotaSnapshots from session data; showSessionDetail() fetches and displays copilot session context detail via /api/sessions/:sessionId/messages; modal includes "Open in new tab" link to /status page; physical sessions have "View events" link to /sessions/:id/events; stopped session history shown as collapsed toggle ("Stopped sessions (N) ▸") with model, tokens, started time, and events link per entry (v0.30.0)
src/sse-broadcaster.ts                  — SseBroadcaster: SSE event broadcasting to connected clients
frontend/                  — Vite + React + TypeScript SPA (v0.32.0); see Frontend section below
src/doctor.ts              — `copilotclaw doctor` CLI: checkWorkspace, checkConfig, checkGateway, checkAgent, checkZeroPremium, checkAuth diagnostics; checkWorkspace uses checkWorkspaceHealth from setup.ts to verify workspace files and git init; checkConfig validates configVersion (warns if missing or unexpected); checkAuth reads config.auth?.github (v0.25.0); runDoctor orchestrates checks and optional --fix (fixWorkspace calls ensureWorkspaceReady, fixConfig, fixStaleSocket); exits 1 on failures
src/agent-manager.ts       — IPC-based agent process ensure at gateway start (spawn, version check, force-restart); uses createRequire to resolve @copilotclaw/agent package path; ensureAgent returns old bootId on force-restart; waitForNewAgent polls until different bootId appears; checkCompatibility() and getMinAgentVersion() methods; getQuota(), getModels(), and getSessionMessages() proxy to agent IPC; MIN_AGENT_VERSION exported (0.50.0); semverSatisfies exported (used by doctor); agent stderr redirected to {{stateDir}}/data/agent.log on spawn (openSync append mode); COPILOTCLAW_GATEWAY_URL no longer set in spawn env (v0.35.0); IPC stream management: connectStream(), setStreamMessageHandler(), setConfigToSend(), notifyAgent(), closeStream(); notifyAgent(channelId) sends generic agent_notify (used for pending messages, subagent completion, etc.; v0.43.0, renamed from notifyPending); startPhysicalSession(sessionId, channelId, copilotSessionId?, model?) sends start_physical_session to agent (v0.49.0); stopPhysicalSession(sessionId) sends stop_physical_session to agent (v0.49.0); reconnectStream() private method closes existing stream and reconnects (called after spawning new agent or force-restart); onStreamConnected() and onStreamDisconnected() callback registration (v0.49.0); RunningSessionReport type (sessionId, channelId, status); StreamMessageHandler interface: onSessionEvent receives channelId (v0.43.0), onPhysicalSessionStarted and onPhysicalSessionEnded callbacks (v0.49.0), onRunningSessionsReport callback (v0.50.0); handleAgentMessage routes running_sessions (v0.50.0), physical_session_started/ended (v0.49.0) in addition to channel_message, session_event, system prompts, drain/peek/flush/list_messages
src/ipc-client.ts          — IPC client (status/stop/quota/models/session_messages to agent process via short-lived connections); AgentStatusResponse includes bootId field; AgentSessionStatusResponse status includes "suspended" (v0.27.0 fix), cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory fields retained in type but no longer populated by agent (v0.50.0: tracking moved to gateway orchestrator); PhysicalSessionSummary type (includes totalInputTokens, totalOutputTokens, latestQuotaSnapshots); SubagentInfo type; getAgentQuota(), getAgentModels(), and getAgentSessionMessages() functions; IpcStream class (v0.35.0): persistent bidirectional connection to agent socket via {"method":"stream"} handshake, auto-reconnect on disconnect, send() for fire-and-forget, request() for id-correlated request-response; createStreamConnection() factory
src/ipc-paths.ts           — socket path: profile-aware (copilotclaw-agent.sock or copilotclaw-agent-{{profile}}.sock in tmpdir)
```

### Workspace Layout

```
~/.copilotclaw/                  (state dir, default profile)
  config.json                — default profile config (configVersion, port, upstream, model, zeroPremium, debugMockCopilotUnsafeTools, otel, debug); auto-migrated on load (v4); env vars take precedence
  source/                    — update source directory (profile-independent, shared across all profiles)
  data/
    store.db                 — SQLite database for channels, messages, pending queues (WAL mode, v0.29.0; migrated from store.json on first run)
    store.json               — legacy JSON store (deprecated, kept only for one-time migration to store.db)
    session-events.db        — SQLite database for session events (WAL mode, v0.29.0; row-count capped at 100k default)
    session-orchestrator.db  — SQLite database for abstract sessions (WAL mode, v0.49.0; migrated from session-orchestrator.json and agent-bindings.json on first run)
    gateway.log              — structured JSON Lines log from gateway (via LogBuffer + StructuredLogger)
    agent.log                — structured JSON Lines log from agent (via StructuredLogger) + agent stderr capture
    events/                  — (removed in v0.29.0, replaced by session-events.db)
    prompts/                 — system prompt snapshots ({{model}}.json for originals, effective-{{sessionId}}.json for effective prompts)
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
← {"version":"0.17.0","bootId":"uuid","startedAt":"...","sessions":{"sess-id":{"status":"waiting|suspended","startedAt":"...","boundChannelId":"ch-id","copilotSessionId":"...","physicalSession":{...},"subagentSessions":[...]}}}

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
{"type":"config","config":{...}}                                          — sent immediately when stream opens
{"type":"agent_notify","channelId":"..."}                                 — generic notification (pending messages, subagent completion, etc.)
{"type":"start_physical_session","sessionId":"...","channelId":"...","copilotSessionId":"...","model":"..."}  — start a physical session (v0.49.0; copilotSessionId optional for resume; model optional, resolved by gateway v0.50.0)
{"type":"stop_physical_session","sessionId":"..."}                        — stop a physical session (v0.49.0)
```

Agent → Gateway push (fire-and-forget):
```
{"type":"channel_message","channelId":"...","sender":"agent","message":"..."}
{"type":"session_event","sessionId":"...","channelId":"...","eventType":"...","timestamp":"...","data":{...}}
{"type":"system_prompt_original","model":"...","prompt":"...","capturedAt":"..."}
{"type":"system_prompt_session","sessionId":"...","model":"...","prompt":"..."}
{"type":"physical_session_started","sessionId":"...","copilotSessionId":"...","model":"..."}    — v0.49.0
{"type":"physical_session_ended","sessionId":"...","reason":"idle|error|aborted","copilotSessionId":"...","elapsedMs":N,"error":"..."}  — v0.49.0; token totals removed (tracked via real-time events on gateway side)
{"type":"running_sessions","sessions":[{"sessionId":"...","channelId":"...","status":"..."},...]}  — sent on stream connect for reconciliation (v0.50.0)
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
copilotclaw_wait()         — block polling for pending user messages (25 min keepalive timeout); waits for agent_notify push from gateway; wrapped in try-catch that catches ALL exceptions and returns keepalive response (errors logged to console.error only — agent must not perceive errors)
copilotclaw_list_messages(limit?)   — list recent channel messages (reverse-chronological)
```

Tool availability:
- **channel-operator** (parent): receives all three tools
- **worker** (subagent): receives only send_message and list_messages (never wait, preventing deadlock if worker attempts to block)

### SDK Hooks

- `onPostToolUse` — executes after each tool call; gates on `copilotclaw_wait` (the sole parent-exclusive tool) to avoid injecting reminders/notifications into subagent tool calls (SDK hook system provides no mechanism to distinguish parent vs subagent calls); performs two checks:
  - Pending message detection: peeks channel for pending user messages, injects notification into additionalContext
  - System prompt reinforcement (v0.15.0+): fires periodic reminders via `<system>` tagged additionalContext when context usage crosses 10% increments or after compaction; maintains reminderState (needsReminder, lastReminderPercent, currentUsagePercent) to avoid firing on every tool call

### Key Files

```
src/index.ts                    — singleton entry; waits for gateway IPC stream connection and config push (replaces HTTP fetch of /api/status); resolves auth token from config via token-resolver; listens for start_physical_session and stop_physical_session IPC push messages from gateway (v0.49.0, replaces agent_notify-driven session management); passes sessionId and model from start_physical_session to startSession (v0.50.0); calls initSendQueue(dataDir) after config received to restore buffered messages from disk; calls setMaxQueueSize() from config (maxQueueSize) to configure send queue cap; sends running_sessions report on stream connect via streamEvents "stream_connected" handler — calls flushSendQueue() before sending running_sessions report, then calls sessionManager.getRunningSessionsSummary() and sends to gateway for reconciliation (v0.50.0); initializes OTel from gateway config; receives prompts (including timing config) from gateway config and passes as required field to AgentSessionManagerOptions (v0.40.0); calls ipc.setSessionManager(sessionManager) after creating AgentSessionManager to inject session manager into IPC server; no persistPath, no checkAllPending, no stale timer, no agent_notify fallback (removed in v0.49.0 — gateway drives all session lifecycle); module-level log/logError functions with structured JSON fallback (console.error with JSON.stringify) before StructuredLogger is initialized; no COPILOTCLAW_GATEWAY_URL or gatewayBaseUrl (v0.35.0)
src/agent-session-manager.ts    — physical session execution only (v0.49.0: removed abstract session management, channel bindings, backoff, stale check, maxAge, persistence — all moved to gateway SessionOrchestrator); AgentSessionManagerOptions accepts githubToken, debugLogLevel, log, logError, and required prompts config (AgentPromptConfig with prompt definitions and timing values including keepaliveTimeoutMs and reminderThresholdPercent; structured JSON fallback via defaultLog/defaultLogError when not provided; no persistPath, no gatewayBaseUrl or fetch since v0.35.0); debugLogLevel field (optional "info"|"debug", defaults to "info"); debug() method logs only when debugLogLevel is "debug"; debug logs in onPostToolUse hook (includes session ID: `postToolUse: [${sessionId}] tool=${toolName}`); uses this.customAgents, this.primaryAgentName, this.systemReminder, this.initialPrompt, this.keepaliveTimeoutMs, this.reminderThresholdPercent instance fields from gateway-provided prompts config; KNOWN_SECTIONS sourced from config (knownSections) instead of hardcoded; createClient() passes clientOptions from config to CopilotClient constructor; baseConfig merges sessionConfigOverrides from config; all gateway communication via IPC: postToGateway(msg) calls sendToGateway, postChannelMessage calls sendToGateway with type "channel_message", onPostToolUse peek uses requestFromGateway; SDK event forwarding uses postToGateway with type "session_event" (includes channelId and eventType; v0.43.0), system prompts via "system_prompt_original"/"system_prompt_session"; sends physical_session_started on session creation and physical_session_ended on idle/error exit (v0.49.0); AgentSessionInfo now contains only status, startedAt, processingStartedAt, boundChannelId (removed PhysicalSessionSummary, SubagentInfo types, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory — all state tracking moved to gateway orchestrator); removed all SDK event subscriptions for local state tracking — uses session.on(handler) catch-all to unconditionally forward all SDK events to gateway (no explicit event list maintenance needed); events are only forwarded to gateway, not consumed locally; StartSessionOptions requires sessionId from gateway (no more randomUUID), accepts optional copilotSessionId and resolvedModel (v0.50.0); createClient() method creates CopilotClient with githubToken when provided; startSession creates new physical session using gateway-provided sessionId (no revive logic — gateway handles revival by sending copilotSessionId); resolvedModel in StartSessionOptions bypasses agent-side model selection when set (v0.50.0); resumeSession/createSession branching based on copilotSessionId presence; resumeSession wrapped in try/catch — on failure, clears copilotSessionId and falls back to createSession (v0.38.0); suspendSessionState() simplified — clears physical/subagent state only, no token accumulation; sendPhysicalSessionEnded() notifies gateway (no longer sends token totals); getRunningSessionsSummary() returns array of non-suspended sessions with sessionId, channelId, status for reconciliation on stream connect (v0.50.0); onStatusChange("waiting") sets physicalSession.currentState to "tool:copilotclaw_wait" (v0.44.0)
src/token-resolver.ts           — resolves GitHub tokens from auth config; supports gh-cli (gh auth token), PAT (via env var or file), and custom command strategies
src/otel.ts                     — OpenTelemetry setup for agent process: initOtel(endpoints, serviceName, serviceVersion), getLogger(component), shutdownOtel(); intentionally duplicated from gateway (self-contained, no shared dependency); uses serviceName "copilotclaw-agent"
src/structured-logger.ts        — StructuredLogger class: writes JSON Lines (StructuredLogEntry) to file via appendFileSync; info()/error() methods; OtelLoggerBridge interface for optional OTel log bridging (constructor accepts optional otelLogger parameter); intentionally duplicated in gateway package
src/ipc-server.ts               — Unix domain socket IPC server (status/session_status/stop/quota/models/session_messages); AgentIpcServerHandle returned by listenIpc includes setSessionManager(mgr) method for deferred injection of session manager after construction; handleConnection uses sessionManagerRef: { current: AgentSessionManager | null } mutable ref pattern — all IPC handlers read sessionManagerRef.current (null-safe via ?? and !== null guards) allowing the session manager to be injected after the IPC server is already listening; IPC stream support (v0.35.0): detects {"method":"stream"} to upgrade connection to persistent bidirectional channel; module-level stream socket with sendToGateway() (fire-and-forget, buffers to in-memory send queue + JSONL file when stream disconnected), requestFromGateway() (id-correlated request-response with 15s timeout), streamEvents EventEmitter for push message handlers; handleStreamMessage routes incoming messages (response correlation, type-based event emission); send queue with disk persistence: initSendQueue(dataDir) restores queue from JSONL file on startup, flushSendQueue() drains buffered messages when stream reconnects; maxQueueSize configurable via setMaxQueueSize() (default 10000); exports initSendQueue, flushSendQueue, and setMaxQueueSize
src/ipc-paths.ts                — socket path generation (profile-aware)
src/session-loop.ts             — session idle loop (subscribe/send/disconnect); supports both createSession and resumeSession
src/copilot-session-adapter.ts  — CopilotSession → SessionLike adapter
src/stop.ts                     — CLI stop command (IPC stop)
src/tools/channel.ts            — WAIT_TOOL_NAME constant ("copilotclaw_wait"), wait variable (defineTool); send_message (via sendToGateway IPC), wait (drains pending via requestFromGateway IPC, waits for agent_notify push; try-catch swallows ALL exceptions → keepalive response, logError with structured JSON fallback only), list_messages (via requestFromGateway IPC); NextInputResponse includes sender field; combineMessages prefixes [CRON TASK] for cron sender, [SYSTEM EVENT] for system sender; ChannelToolDeps requires keepaliveTimeoutMs (no more DEFAULT_KEEPALIVE_TIMEOUT_MS hardcode — value comes from gateway config via AgentPromptConfig, v0.50.0); ChannelToolDeps accepts optional logError (falls back to structured JSON on console.error); no HTTP fetch (v0.35.0)
```

## Frontend SPA (packages/gateway/frontend, v0.32.0)

Vite + React + TypeScript single-page application. Built to `frontend-dist/` and served by gateway server with fallback to old server-rendered pages.

### Routes (App.tsx via react-router-dom)

```
/                              → DashboardPage (chat UI with channels, SSE, status bar, logs panel)
/status                        → StatusPage (gateway, agent, sessions, config, system prompts, token consumption; elapsed time helper; 5s auto-refresh)
/sessions                      → SessionsListPage (abstract sessions from /api/status with physical sessions as children; ?focus= URL param for scroll-to; orphaned physical sessions listed separately)
/sessions/:sessionId/events    → SessionEventsPage (initial load of latest N events, append-only polling for new events, infinite scroll up for older events; auto-scroll; 2s polling; "Back to Sessions" link with ?focus= param targeting parent abstract session)
```

### Key Files

```
index.html                     — SPA entry point
vite.config.ts                 — Vite config (React plugin, build output to ../frontend-dist/)
vitest.config.ts               — Vitest config for frontend tests (jsdom environment)
src/main.tsx                   — React DOM root mount
src/App.tsx                    — BrowserRouter with route definitions
src/global.css                 — Global styles; @media query for mobile responsiveness; iOS auto-zoom prevention for inputs (font-size >= 16px)
src/api.ts                     — Typed fetch wrappers for all gateway API endpoints (Channel, Message, StatusResponse, SessionEvent, QuotaResponse, ModelsResponse, TokenUsageEntry, etc.); SessionEvent has optional id field; Message.sender includes "system" (v0.43.0); archiveChannel(id), unarchiveChannel(id), fetchChannels({ includeArchived }) for channel archiving; fetchMessages(channelId, limit=50, before?) supports cursor-based pagination via optional `before` parameter; fetchSessionEventsPaginated(sessionId, limit, {before?, after?}) for paginated event fetching; TokenUsageEntry interface and fetchTokenUsage(hours?) for token consumption data
src/hooks/useAutoScroll.ts     — Position-based auto-scroll hook (follows bottom, disengages on scroll-up, re-engages at bottom); programmaticScrollRef guard prevents scroll events from programmatic scrollTop changes from resetting isAtBottomRef
src/hooks/usePolling.ts        — Generic polling hook (immediate call + setInterval, cleanup on unmount)
src/pages/DashboardPage.tsx    — Chat dashboard (channel management, message list, input form, SSE events, status bar, logs panel); showArchived toggle for displaying archived channels; archive/unarchive buttons on channel tabs; mobile responsive (tab overflow-x: auto, flexShrink, modal min/max width); SSE auto-reconnect on error (3s delay); visibilitychange handler for message refresh; infinite scroll (loadOlderMessages on scroll near top, cursor-based pagination via `before` parameter)
src/pages/StatusPage.tsx       — System status page (gateway/agent/sessions/config display, elapsed time helper, effective prompt loading, cumulative tokens, physical session history); sessions link text: "All sessions →" (v0.36.0); Token Consumption section (v0.48.0): last 5h consumption index, model breakdown table, period breakdown (1h/6h/24h/7d); computeIndex helper function; consumption index formula: SUM over models { MAX(billing.multiplier, 0.1) * total_tokens }
src/pages/SessionsListPage.tsx — Sessions list: fetches abstract sessions from /api/status, renders each with physical sessions (current + history) as children; orphaned physical sessions (not in any abstract session) listed separately with event counts and model; supports ?focus= URL param to highlight and scroll-to an abstract session
src/pages/SessionEventsPage.tsx — Session event viewer: initial load of latest N events (EVENTS_PAGE_SIZE=50), auto-polling append-only for new events (2s via usePolling, fetches after newest id), infinite scroll up for older events (loads before oldest id, scroll position restoration via requestAnimationFrame); event count display; auto-scroll via useAutoScroll; "Back to Sessions" link with ?focus= param targeting parent abstract session; resolves parent abstract session from /api/status
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

### Test Suites (477 total: 469 vitest + 8 Playwright)

```
Gateway vitest (353 tests)   — unit + E2E tests with mock agent (includes config, config-cli, config-migration, doctor, ipc-paths, setup, workspace, structured-logger, session-event-store, store, session-orchestrator, agent-manager, daemon-session-event-handler tests); E2E tests use SessionEventStore for /api/token-usage endpoint coverage; session-orchestrator tests cover start/suspend/stop/revive, SQLite persistence, legacy migration, backoff, maxAge, suspendAllActive
Agent vitest (84 tests)      — unit tests with mock Copilot SDK session + IPC stream tests (includes structured-logger, token-resolver, ipc-stream tests; currentState tracking via onStatusChange, postToolUse log session ID tests); physical_session_started/ended notification tests
Frontend vitest (32 tests)   — React SPA component tests (SessionEventsPage, StatusPage, DashboardPage, SessionsListPage, useAutoScroll) via jsdom + @testing-library/react
Browser Playwright (8 tests) — test/browser/dashboard.spec.ts: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
```
