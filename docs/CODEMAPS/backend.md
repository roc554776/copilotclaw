<!-- Generated: 2026-03-27 | Updated: 2026-03-27 | Files scanned: 37 | Version: 0.27.0 | Token estimate: ~2700 -->

# Backend

## Gateway (packages/gateway)

### API Routes (server.ts)

```
GET  /healthz                              → 200 { status: "ok" }
POST /api/stop                             → 200 { status: "stopping" } → gateway exit only (localhost only, agent NOT stopped)
GET  /api/status                           → 200 { gateway: {status, version, profile}, agent: AgentStatusResponse|null, agentCompatibility: …|null, config: {model, zeroPremium, debugMockCopilotUnsafeTools, stateDir, workspaceRoot, auth: {type, user}} }  (auth extracted from config.auth?.github)
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
src/server.ts              — HTTP server, route handler, startServer(), GATEWAY_VERSION from package.json; /api/logs endpoint serves LogBuffer contents; /api/quota, /api/models, and /api/sessions/:sessionId/messages proxy to agent via agentManager; /api/status config includes stateDir from getStateDir()
src/config.ts              — config file module: loadConfig, loadFileConfig, saveConfig, ensureConfigFile, resolvePort, getConfigFilePath, getStateDir, CONFIG_ENV_VARS, parseBool helper; profile-aware ({{stateDir}}/config.json where {{stateDir}}=~/.copilotclaw/ or ~/.copilotclaw-{{profile}}/); getStateDir() returns state dir base path (used by workspace.ts for workspace/ and data/ subdirs); env vars (COPILOTCLAW_PORT, COPILOTCLAW_UPSTREAM, COPILOTCLAW_MODEL, COPILOTCLAW_ZERO_PREMIUM, COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS) take precedence over file values; CopilotclawConfig includes configVersion, model, zeroPremium, debugMockCopilotUnsafeTools, auth fields; AuthContainerConfig wraps AuthConfig as `github` field (v0.25.0); AuthConfig interface defines auth configuration (type: "gh-cli"|"pat"|"command", plus type-specific fields); CopilotclawConfig.auth is AuthContainerConfig (not AuthConfig); loadConfig applies migrateConfig and writes back if migrated, passes through auth from file config; saveConfig stamps LATEST_CONFIG_VERSION; ensureConfigFile includes configVersion; LATEST_CONFIG_VERSION = 2; MIGRATIONS registry for sequential schema migration (v1→v2: moves auth.* into auth.github.*); migrateConfig(raw) applies migrations from current version to LATEST_CONFIG_VERSION, returns { config, migrated }
src/config-cli.ts          — `copilotclaw config` CLI: configGet (resolve + display, notes env var override), configSet (validate + save, warns if env var shadows); valid keys: upstream, port, model, zeroPremium, debugMockCopilotUnsafeTools; BOOLEAN_KEYS handling for zeroPremium/debugMockCopilotUnsafeTools
src/daemon.ts              — daemon entry point (ensureWorkspace creates data/ + workspace/ dirs + Store init + LogBuffer creation + enableFileOutput to {{stateDir}}/data/gateway.log + console intercept + startServer on resolvePort() + periodic agent monitor every 30s, max 3 retries)
src/index.ts               — CLI entry point (health check on resolvePort() → detached spawn → exit); reads GATEWAY_VERSION from package.json, shows version in all CLI log messages; parses --profile before command routing (sets COPILOTCLAW_PROFILE env var); after daemon healthy, checks /api/status agentCompatibility and exits 1 on incompatible; checkAgentCompatibility polls /api/status when waitForAgent=true (used after force-restart)
src/log-buffer.ts          — LogBuffer class (ring buffer for recent log lines), interceptConsole() to capture stdout/stderr; enableFileOutput(logFilePath) delegates structured writes to StructuredLogger
src/structured-logger.ts   — StructuredLogger class: writes JSON Lines (StructuredLogEntry) to file via appendFileSync; info()/error() methods; intentionally duplicated in agent package
src/stop.ts                — POST /api/stop CLI (uses resolvePort())
src/restart.ts             — `copilotclaw restart` CLI: stop gateway → wait for shutdown → start (uses resolvePort())
src/setup.ts               — `copilotclaw setup` CLI: create workspace directories + auto-port selection (isPortAvailable, findAvailablePort from candidate list; saves port to config if default busy); migrateWorkspaceFiles() migrates bootstrap files from state dir root to workspace/ subdirectory (v0.26→v0.27 transition, moves SOUL.md/AGENTS.md/USER.md/TOOLS.md/MEMORY.md and memory/ if present at old location); seedWorkspaceBootstrapFiles() generates SOUL.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md, memory/.gitkeep, and memory/ directory (v0.19.0); initWorkspaceGit() runs git init in workspace (v0.19.0); ensureWorkspaceReady(workspaceRoot) orchestrates full workspace setup: mkdirSync + initWorkspaceGit + seedWorkspaceBootstrapFiles + commitInitialWorkspaceFiles (idempotent, called by setup and doctor --fix); commitInitialWorkspaceFiles() does git add -A + commit if no commits yet; checkWorkspaceHealth(workspaceRoot) returns list of issues (missing dir, missing files, missing git init); isGitAvailable() checks git CLI availability
src/update.ts              — `copilotclaw update` CLI: fetches upstream to ~/.copilotclaw/source/ via getUpdateDir (git init + fetch --depth 1 + checkout FETCH_HEAD), pnpm (via npx -y pnpm@PNPM_VERSION, no global pnpm required) install + build, rewriteWorkspaceDeps converts workspace:* to file: paths in CLI package.json, npm install -g from packages/cli/; upstream from config file (COPILOTCLAW_UPSTREAM env var takes precedence); skips build if SHA unchanged
src/workspace.ts           — workspace paths: getWorkspaceRoot() returns {{stateDir}}/workspace/ (e.g. ~/.copilotclaw/workspace/ default, ~/.copilotclaw-{{profile}}/workspace/ profiled); getDataDir() returns {{stateDir}}/data/ (directly under state dir, not workspace); getStoreFilePath() derives store.json from data dir; ensureWorkspace() creates both data/ and workspace/ directories; getUpdateDir() returns profile-independent source dir (~/.copilotclaw/source/); profile via COPILOTCLAW_PROFILE env var
src/store.ts               — persistent store (Channel, Message, per-channel pending queue); JSON file via atomic rename
src/channel-provider.ts    — ChannelProvider interface (plugin contract for chat mediums)
src/builtin-chat-channel.ts — BuiltinChatChannel: built-in chat UI provider (dashboard, SSE events, SSE broadcast via SseBroadcaster); passes compatibility info to dashboard
src/dashboard.ts           — HTML renderer (status bar with compatibility label, chat bubbles, channel tabs, input form, logs panel toggled via Logs button with stopPropagation to prevent status modal opening); status modal shows physical session details (with elapsed time, accumulated tokens in/out/total), cumulative tokens across physical sessions (v0.27.0), subagent sessions, premium requests, available models; quota display uses /api/quota with fallback to latestQuotaSnapshots from session data; showSessionDetail() fetches and displays copilot session context detail via /api/sessions/:sessionId/messages
src/sse-broadcaster.ts                  — SseBroadcaster: SSE event broadcasting to connected clients
src/doctor.ts              — `copilotclaw doctor` CLI: checkWorkspace, checkConfig, checkGateway, checkAgent, checkZeroPremium, checkAuth diagnostics; checkWorkspace uses checkWorkspaceHealth from setup.ts to verify workspace files and git init; checkConfig validates configVersion (warns if missing or unexpected); checkAuth reads config.auth?.github (v0.25.0); runDoctor orchestrates checks and optional --fix (fixWorkspace calls ensureWorkspaceReady, fixConfig, fixStaleSocket); exits 1 on failures
src/agent-manager.ts       — IPC-based agent process ensure at gateway start (spawn, version check, force-restart); uses createRequire to resolve @copilotclaw/agent package path; ensureAgent returns old bootId on force-restart; waitForNewAgent polls until different bootId appears; checkCompatibility() and getMinAgentVersion() methods; getQuota(), getModels(), and getSessionMessages() proxy to agent IPC; MIN_AGENT_VERSION exported; semverSatisfies exported (used by doctor); agent stderr redirected to {{stateDir}}/data/agent.log on spawn (openSync append mode)
src/ipc-client.ts          — IPC client (status/stop/quota/models/session_messages to agent process); AgentStatusResponse includes bootId field; AgentSessionStatusResponse status includes "suspended" (v0.27.0 fix), cumulativeInputTokens, cumulativeOutputTokens (v0.27.0); PhysicalSessionSummary type (includes totalInputTokens, totalOutputTokens, latestQuotaSnapshots); SubagentInfo type; getAgentQuota(), getAgentModels(), and getAgentSessionMessages() functions
src/ipc-paths.ts           — socket path: profile-aware (copilotclaw-agent.sock or copilotclaw-agent-{{profile}}.sock in tmpdir)
```

### Workspace Layout

```
~/.copilotclaw/                  (state dir, default profile)
  config.json                — default profile config (configVersion, port, upstream, model, zeroPremium, debugMockCopilotUnsafeTools); auto-migrated on load; env vars take precedence
  source/                    — update source directory (profile-independent, shared across all profiles)
  data/
    store.json               — persisted channels + messages + pending queues (atomic write via .tmp rename)
    agent-bindings.json      — persisted channel bindings and suspended sessions (atomic write, v0.19.0); includes cumulative token data (v0.27.0)
    gateway.log              — structured JSON Lines log from gateway (via LogBuffer + StructuredLogger)
    agent.log                — structured JSON Lines log from agent (via StructuredLogger) + agent stderr capture
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
← {"version":"0.17.0","bootId":"uuid","startedAt":"...","sessions":{"sess-id":{"status":"waiting|suspended","startedAt":"...","boundChannelId":"ch-id","copilotSessionId":"...","cumulativeInputTokens":N,"cumulativeOutputTokens":N,"physicalSession":{...},"subagentSessions":[...]}}}

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
copilotclaw_receive_input()         — block polling for pending user messages (25 min keepalive timeout); drains subagent completion queue and includes completion info in response; wrapped in try-catch that catches ALL exceptions and returns keepalive response (errors logged to console.error only — agent must not perceive errors)
copilotclaw_list_messages(limit?)   — list recent channel messages (reverse-chronological)
```

Tool availability:
- **channel-operator** (parent): receives all three tools
- **worker** (subagent): receives only send_message and list_messages (never receive_input, preventing deadlock if worker attempts to block)

### SDK Hooks

- `onPostToolUse` — executes after each tool call; gates on `copilotclaw_receive_input` (the sole parent-exclusive tool) to avoid injecting reminders/notifications into subagent tool calls (SDK hook system provides no mechanism to distinguish parent vs subagent calls); performs three checks:
  - Pending message detection: peeks channel for pending user messages, injects notification into additionalContext
  - Subagent completion notification (v0.16.0+): drains subagent completion queue, injects `[SUBAGENT COMPLETED]` tagged notifications with agent name, status, tokens, and duration
  - System prompt reinforcement (v0.15.0+): fires periodic reminders via `<system>` tagged additionalContext when context usage crosses 10% increments or after compaction; maintains reminderState (needsReminder, lastReminderPercent, currentUsagePercent) to avoid firing on every tool call

### Key Files

```
src/index.ts                    — singleton entry, fetches config from gateway /api/status (GatewayConfig includes stateDir), resolves auth token from config via token-resolver, polls gateway for pending inputs; uses hasActiveSessionForChannel to avoid starting duplicate sessions; startSession auto-revives suspended sessions (with saved copilotSessionId) or creates new; per-cycle: max-age check (checkSessionMaxAge suspends on expiry), then stale detection (checkStaleAndHandle suspends after 10m+ processing with pending, flushes inputs); passes persistPath to AgentSessionManager: {{stateDir}}/data/agent-bindings.json (uses stateDir, not workspaceRoot); passes resolved githubToken to AgentSessionManager; initializes StructuredLogger writing to {{stateDir}}/data/agent.log (uses stateDir); skips channels in backoff via isChannelInBackoff check in polling loop
src/agent-session-manager.ts    — per-session lifecycle with abstract/physical session separation (v0.18.0); channel binding persistence (v0.19.0): AgentSessionManagerOptions accepts persistPath and githubToken; createClient() method creates CopilotClient with githubToken when provided; loadBindings() in constructor (line 192) restores suspended sessions from agent-bindings.json, recreating entries in suspended state with preserved copilotSessionId, boundChannelId, and cumulative token data; saveBindings() called on suspendSession and stopSession to persist/update agent-bindings.json via atomic write (tmp → rename); SessionSnapshot and BindingSnapshot types define persist format; SessionSnapshot includes cumulativeInputTokens/cumulativeOutputTokens (v0.27.0); AgentSessionInfo has cumulativeInputTokens/cumulativeOutputTokens fields (v0.27.0); AgentSessionStatus: "starting"|"waiting"|"processing"|"suspended"|"stopped"; startSession auto-detects suspended sessions via hasActiveSessionForChannel and revives via reviveSession; suspendSession transitions to "suspended", accumulates token usage from physical session into cumulative totals before clearing physicalSession, preserves copilotSessionId for later revival; reviveSession launches new physical session, reusing abstract sessionId and copilotSessionId; stopSession fully removes abstract session and channel binding (explicit termination); checkSessionMaxAge suspends when "waiting" exceeds 2-day max (or configurable maxSessionAgeMs); checkStaleAndHandle suspends when "processing" >10min with pending inputs (staleTimeoutMs), posts timeout notification, returns "flushed" to trigger input flush; PhysicalSessionSummary (totalInputTokens, totalOutputTokens, latestQuotaSnapshots); getQuota/getModels methods proxy Copilot SDK account API; getSessionMessages retrieves CopilotSession conversation history; resolveModel handles zeroPremium override; debugMockCopilotUnsafeTools restricts availableTools; custom agents (v0.16.0+): CHANNEL_OPERATOR_CONFIG (infer:false, deadlock prevention with workspace structure description and session startup section reading SOUL.md/USER.md/memory files) and WORKER_CONFIG (infer:true); private ensureWorkspaceReady() called at runSession start — creates dir, git init, bootstrap files (SOUL.md/USER.md/TOOLS.md/MEMORY.md/memory/.gitkeep with minimal templates), initial commit (idempotent); onPostToolUse hook gates on copilotclaw_receive_input, injects: (1) pending message notifications, (2) subagent completion notifications [SUBAGENT COMPLETED], (3) periodic system prompt reminders on context usage 10% increments; channel notifications (stopped, timed-out) via postChannelMessage; channelBackoff map tracks rapid-failure backoff per channel; isChannelInBackoff(channelId) checks if channel is in backoff period; recordBackoffIfRapidFailure() sets backoff when session fails within rapid-failure threshold; notifyChannelSessionStopped() accepts optional error reason string for system message detail
src/token-resolver.ts           — resolves GitHub tokens from auth config; supports gh-cli (gh auth token), PAT (via env var or file), and custom command strategies
src/structured-logger.ts        — StructuredLogger class: writes JSON Lines (StructuredLogEntry) to file via appendFileSync; info()/error() methods; intentionally duplicated in gateway package
src/ipc-server.ts               — Unix domain socket IPC server (status/session_status/stop/quota/models/session_messages)
src/ipc-paths.ts                — socket path generation (profile-aware)
src/session-loop.ts             — session idle loop (subscribe/send/disconnect); supports both createSession and resumeSession
src/copilot-session-adapter.ts  — CopilotSession → SessionLike adapter
src/stop.ts                     — CLI stop command (IPC stop)
src/tools/channel.ts            — send_message, receive_input (drains subagent completions; try-catch swallows ALL exceptions → keepalive response, console.error only), list_messages; exports SubagentCompletionInfo
```

## Testing

### Configuration

```
vitest.config.ts           — vitest config; excludes test/browser/ (Playwright-managed)
playwright.config.ts       — Playwright config for browser E2E tests
```

### Test Suites (276 total: 268 vitest + 8 Playwright)

```
Gateway vitest (188 tests) — unit + E2E tests with mock agent (includes config, config-cli, config-migration, doctor, ipc-paths, setup, workspace, structured-logger tests)
Agent vitest (80 tests)    — unit tests with mock Copilot SDK session (includes structured-logger, token-resolver tests)
Browser Playwright (8 tests) — test/browser/dashboard.spec.ts: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
```
