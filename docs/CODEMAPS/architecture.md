<!-- Generated: 2026-03-27 | Updated: 2026-03-31 | Packages: 3 (cli, gateway, agent) | Version: 0.50.0 | Token estimate: ~2400 -->

# Architecture

## System Overview

```
┌─────────────┐  HTTP   ┌─────────────────────────────┐  IPC (.sock)  ┌──────────────────────┐
│   Browser    │◄──────►│          Gateway             │◄────────────►│        Agent         │
│  (dashboard) │        │  ┌───────────────────────┐  │  (stream +    │  ┌────────────────┐  │
└─────────────┘        │  │ SessionOrchestrator   │  │   short-lived) │  │ AgentSession   │  │
                        │  │  sessions: sessId→…   │  │               │  │ Manager        │  │
                        │  │  bindings: chId→sessId│  │               │  │ (physical only)│  │
                        │  │  backoff: chId→expiry │  │               │  └────────────────┘  │
                        │  └───────────────────────┘  │               └──────────────────────┘
                        └─────────────────────────────┘                          │
                                                                          Copilot SDK
                                                                          (mocked in tests)
```

- **Gateway**: singleton daemon (default port 19741, configurable via config file or COPILOTCLAW_PORT env var), manages channels, inputs, and messages; reports GATEWAY_VERSION (from package.json), agentCompatibility, profile, and config (model, zeroPremium, debugMockCopilotUnsafeTools, stateDir, workspaceRoot, auth.github, otel, debug) via /api/status; proxies Copilot quota and models from agent via /api/quota and /api/models; serves recent logs via /api/logs (ring buffer); hosts observability infrastructure (session event store, system prompt snapshots, status page, events page); initializes OTel at startup (logs + metrics export via OTLP HTTP) and shuts down on exit
- **Agent**: single process, executes physical sessions on behalf of gateway; communicates with gateway exclusively via IPC (stream for push-based messaging, short-lived connections for status/stop/quota/models); sendToGateway buffers messages to in-memory queue + JSONL file when stream disconnected (maxQueueSize configurable via gateway config, default 10000), queue restored from disk on init via initSendQueue(dataDir), flushed on stream connect via flushSendQueue(); receives OTel config from gateway via IPC stream config push and initializes its own OTel setup independently; does not manage abstract sessions, channel bindings, backoff, or persistence (moved to gateway SessionOrchestrator in v0.49.0)
- **Agent Session**: wraps a Copilot SDK session with its own sessionId, optionally bound to a channel
- **ChannelProvider**: plugin interface for chat mediums (built-in chat, Discord, Telegram, etc.); providers handle medium-specific routes and receive message notifications
- **BuiltinChatChannel**: default ChannelProvider — serves dashboard UI at "/", SSE at "/api/events", broadcasts via SseBroadcaster

## CLI Package (packages/cli)

Thin wrapper package (`copilotclaw`) that depends on `@copilotclaw/gateway` and `@copilotclaw/agent` via `workspace:*`. Published as the global CLI; contains only `bin/copilotclaw.mjs`.

### CLI Entrypoint (packages/cli/bin/copilotclaw.mjs)

```
copilotclaw setup                            → workspace init + auto-port selection if default busy
copilotclaw start [--force-agent-restart]   → spawn gateway daemon
copilotclaw stop                             → stop gateway (agent keeps running)
copilotclaw restart                          → stop + start gateway
copilotclaw update                           → fetch upstream to ~/.copilotclaw/source/, pnpm (via npx) build, rewrite workspace:* deps to file: paths, npm install -g from packages/cli/
copilotclaw config get <key>                 → show resolved config value (env var override noted)
copilotclaw config set <key> <v>             → set config value in file (env var precedence warning)
copilotclaw doctor [--fix]                   → diagnose environment (workspace, config, gateway, agent); --fix auto-repairs fixable issues
copilotclaw agent stop                       → stop agent process only

Global option (applies to all commands):
  --profile <name>               → set COPILOTCLAW_PROFILE env var (isolates workspace, config, IPC socket, port)
```

Environment variables:
- `COPILOTCLAW_PROFILE` — profile name (isolates workspace, config, IPC socket, and port)
- `COPILOTCLAW_UPSTREAM` — git remote URL for update command
- `COPILOTCLAW_PORT` — override gateway HTTP port (takes precedence over config file)
- `COPILOTCLAW_MODEL` — override Copilot SDK model
- `COPILOTCLAW_ZERO_PREMIUM` — enable zero-premium mode (boolean: true/1/false/0)
- `COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS` — enable debug mock copilot unsafe tools mode (boolean: true/1/false/0)

## Process Model

- Gateway: CLI spawns daemon (detached), CLI checks /api/status agentCompatibility after healthy, exits 1 on incompatible
- Agent: single process, singleton via Unix domain socket (`copilotclaw-agent.sock`, or `copilotclaw-agent-{{profile}}.sock` when profiled)
- Gateway start → agent process ensure: IPC status + version check, spawn if absent; agent status response includes bootId (UUID, unique per process start)
- Gateway daemon → periodic agent monitor (30s interval): re-runs ensureAgent, logs failures, recovers automatically; max 3 consecutive failures before error-level logging
- Force-restart flow: ensureAgent returns old bootId on force-restart → daemon calls waitForNewAgent to poll until different bootId appears before proceeding
- Gateway stop → gateway only (agent process NOT stopped)
- Gateway restart → POST /api/stop, wait for port free, then start (restart.ts)
- Agent ↔ Gateway: IPC stream (v0.35.0) — persistent bidirectional connection; gateway pushes config and agent_notify; agent pushes channel messages, session events, system prompts; agent sends request-response for drain/peek/flush/list_messages
- Gateway SessionOrchestrator manages abstract sessions (channel bindings, suspend/revive, backoff, max age); sends start_physical_session/stop_physical_session commands to agent via IPC stream
- Agent listens for start_physical_session/stop_physical_session from gateway; sends physical_session_started/physical_session_ended back to gateway
- User message POST triggers gateway to check orchestrator and start physical session via agent (push-based, no polling)

## Session Keepalive

- `copilotclaw_wait` tool blocks for up to 25 min polling gateway for input (keepalive timeout)
- Tool execution keeps Copilot SDK session active (CLI idle timeout = 30 min)
- On keepalive timeout: tool returns empty → keepalive instruction → LLM re-invokes tool
- Premium request consumption: ~1 per 30 min (idle), plus 1 per user interaction cycle

## Custom Agents (v0.16.0+)

- **Channel-operator**: parent agent exclusively bound to the channel (infer:false, cannot be used as subagent); receives full system prompts including deadlock prevention warnings; subscribes to `copilotclaw_wait` (WAIT_TOOL_NAME) tool to manage session lifecycle
- **Worker**: subagent available for task delegation (infer:true); can only access `copilotclaw_send_message` and `copilotclaw_list_messages` (never receives `copilotclaw_wait`); started by parent agent via subagent dispatch
- Session begins with `agent: "channel-operator"` configuration; custom agent definitions passed to SDK createSession/resumeSession
- Custom agent definitions (customAgents[] with primaryAgentName) and session timing config (staleTimeoutMs, maxSessionAgeMs, rapidFailureThresholdMs, backoffDurationMs, keepaliveTimeoutMs, reminderThresholdPercent, initialPrompt) defined in gateway's `agent-config.ts` as AgentPromptConfig and CustomAgentDef interfaces; AgentPromptConfig also includes knownSections (configurable KNOWN_SECTIONS for system prompt), maxQueueSize (agent send queue cap), clientOptions (passthrough to CopilotClient constructor), sessionConfigOverrides (merged into SDK session base config); resolveModel function for gateway-side model selection (v0.50.0); sent to agent via IPC config push

## System Prompt (v0.19.0+)

- **Prompt ownership (v0.40.0)**: Gateway owns all agent prompt definitions and session timing config in `agent-config.ts` and sends them to agent via IPC config push; agent requires gateway-provided config (no fallback defaults); AgentPromptConfig includes keepaliveTimeoutMs and reminderThresholdPercent (v0.50.0)
- **CHANNEL_OPERATOR_PROMPT**: includes deadlock prevention at start and end, Workspace section describing git-managed workspace files (SOUL.md/USER.md/TOOLS.md/MEMORY.md/memory/) and instructing agent to commit changes, session startup section instructing agent to read SOUL.md (priority), USER.md, memory/ (daily files), and MEMORY.md for context; Lifecycle section with broader wait semantics (copilotclaw_wait use cases: waiting for user reply, subagent completion, all work done, unknown what to do, unexpected system error); Cron Tasks section describing cron-triggered messages and expected handling; Subagent Rules section
- **Session Startup**: agent reads workspace bootstrap files in order: SOUL.md (persona), USER.md (user context), memory/YYYY-MM-DD.md files (recent sessions), MEMORY.md (long-term memory)
- **SYSTEM_REMINDER**: periodic deadlock prevention reinforcement via additionalContext

## Subagent Completion Notification (v0.16.0+, gateway-handled v0.43.0)

- SDK events `subagent.completed` and `subagent.failed` forwarded from agent to gateway via IPC stream session_event (with channelId)
- Gateway detects direct subagent calls (no parentToolCallId in event data) and inserts `[SUBAGENT COMPLETED/FAILED]` system message into the channel's pending queue, then sends agent_notify
- Agent receives system messages via normal pending drain in `copilotclaw_wait`; combineMessages prefixes system sender with `[SYSTEM EVENT]`
- Agent-side status tracking retained (subagent session status updated on events) for dashboard display only

## Session Lifecycle (v0.18.0: Persistent Channel Bindings, v0.49.0: Gateway-Side Orchestration)

- **Responsibility Split (v0.49.0)**: Abstract session lifecycle (channel bindings, suspend/revive, backoff, max age, persistence) managed by gateway's SessionOrchestrator; agent only executes physical sessions (Copilot SDK sessions) on gateway command
- **Abstract vs. Physical Sessions**: Abstract session (sessionId, bound to channel) is separate from physical session (Copilot SDK session). When physical session ends unexpectedly, abstract session transitions to "suspended" (not deleted), preserving channel binding.
- **Session Status**: "starting" → "waiting" → "processing" → "suspended" or "stopped"
  - "suspended": physical session stopped unexpectedly or max age reached; abstract session preserved for revival
  - "stopped": explicit stopSession() — fully removes abstract session and channel binding
- **Gateway-Driven Session Commands (v0.49.0)**: Gateway sends start_physical_session (with sessionId, channelId, optional copilotSessionId, optional model) and stop_physical_session (with sessionId) to agent via IPC stream; agent sends physical_session_started (sessionId, copilotSessionId, model) and physical_session_ended (sessionId, reason, copilotSessionId, elapsedMs, tokens, error) back to gateway
- **Suspension via daemon periodic check**: gateway daemon checks all sessions periodically (30s); maxAge check suspends sessions exceeding 2 days (default, configurable) by sending stop_physical_session to agent then calling orchestrator.suspendSession()
- **Revival via orchestrator.startSession**: when a message arrives for a channel with a suspended session, orchestrator revives (sets status to "starting") and gateway sends start_physical_session with preserved copilotSessionId; agent-side resumeSession wrapped in try/catch — on failure, clears copilotSessionId and falls back to createSession (v0.38.0)
- **Stream disconnect handling**: onStreamDisconnected calls orchestrator.suspendAllActive() to suspend all non-suspended sessions (agent restart scenario); onStreamConnected waits for agent's running_sessions report to reconcile orchestrator state before starting new sessions; agent flushes send queue (buffered messages from disconnected period) before sending running_sessions report on stream connect
- **Running sessions reconciliation (v0.50.0)**: Agent sends running_sessions report on stream connect (listing all non-suspended physical sessions with sessionId, channelId, status); gateway daemon passes to orchestrator.reconcileWithAgent() which revives suspended sessions that are still alive in agent and creates new abstract sessions for unknown running sessions; checkAllChannelsPending runs after reconciliation
- **Binding Persistence (v0.49.0)**: SessionOrchestrator uses SQLite (session-orchestrator.db in data dir, WAL mode); abstract_sessions table (sessionId PK, channelId, status, startedAt, copilotSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory JSON); persistSession() upserts on every mutation; loadFromDb() on construction; legacy one-time migration from agent-bindings.json (renames to .migrated after migration)
- **Cumulative Token Tracking (v0.27.0)**: SessionOrchestrator tracks cumulativeInputTokens and cumulativeOutputTokens per abstract session; suspendSession() accumulates tokens from physical session before clearing; gateway updates physical session via onPhysicalSessionEnded handler; dashboard shows cumulative tokens
- **Stopped Session History (v0.30.0)**: SessionOrchestrator maintains physicalSessionHistory (PhysicalSessionSummary[]) per abstract session; suspendSession() pushes physical session to history before clearing; capped at 10 entries (oldest removed); persisted in SQLite
- **Channel backoff**: SessionOrchestrator tracks channelBackoff map (ephemeral, not persisted); daemon records backoff on rapid failure (onPhysicalSessionEnded checks elapsedMs < rapidFailureThresholdMs); isChannelInBackoff() checked before starting sessions
- **Channel notifications**: gateway daemon inserts system messages on unexpected physical session stop (with error detail) and flushes pending messages for the channel

## Observability (v0.28.0, SQLite v0.29.0)

- **SessionEventStore**: SQLite-based event storage (session-events.db in data dir, WAL mode); table: session_events (autoincrement id, sessionId, type, timestamp, data as JSON, parentId; indexed by sessionId, sessionId+timestamp, type); stores system prompt snapshots as JSON files in `{{stateDir}}/data/prompts/`; enforces configurable storage cap by row count (default 100k events) by deleting oldest rows every 500 inserts; getEventsPaginated(sessionId, limit, {before?, after?}) for cursor-based pagination by id; getEventCount(sessionId) returns total event count; getTokenUsage(from, to) aggregates assistant.usage events by model within time range (returns per-model totals of input/output tokens)
- **Event Forwarding**: agent uses session.on(handler) catch-all to unconditionally forward all SDK events to gateway via fire-and-forget IPC stream push (type "session_event"); no explicit event list maintenance needed — any new SDK event is automatically forwarded; gateway daemon routes incoming session events to SessionOrchestrator state update methods for real-time tracking (tool execution state, tokens, model, subagents)
- **System Prompt Capture**: agent uses registerTransformCallbacks("*") on CopilotSession to intercept the original system prompt from the SDK; captured prompt forwarded to gateway via IPC stream push as both original prompt (type "system_prompt_original", per-model) and effective prompt (type "system_prompt_session", per-session)
- **React SPA Frontend (v0.32.0)**: Vite + React + TypeScript SPA in `packages/gateway/frontend/`; routes: `/` (DashboardPage), `/status` (StatusPage), `/sessions` (SessionsListPage), `/sessions/:sessionId/events` (SessionEventsPage); hooks: useAutoScroll (position-based scroll follow with programmaticScrollRef guard to ignore programmatic scrollTop changes), usePolling (generic interval polling); API client: `api.ts` with typed fetch wrappers for all gateway endpoints (fetchMessages default limit 50, cursor-based pagination via `before` parameter; fetchSessionEventsPaginated for paginated event fetching; SessionEvent has optional id field); built to `frontend-dist/` via `build:frontend` script; server serves SPA with fallback to old server-rendered HTML pages (observability-pages.ts) when `frontend-dist/` not present
- **Status Page** (`/status`): shows gateway, agent, sessions (with elapsed time helper), config, original system prompts, and Token Consumption section; sessions section always visible with empty state when no sessions exist; auto-refreshes every 5s; links to session event pages and effective prompt viewer; shows stopped session history per session (v0.30.0); sessions link text: "All sessions →" (v0.36.0, changed from "All physical sessions →"); Token Consumption (v0.48.0): last 5h consumption index, model breakdown table, period breakdown (1h/6h/24h/7d); consumption index formula: SUM over models { MAX(billing.multiplier, 0.1) * total_tokens }; computeIndex helper function
- **Events Page** (`/sessions/:id/events`): initial load of latest N events, auto-polling append-only for new events (2s interval), infinite scroll up for older events with scroll position restoration; event count in heading; auto-scroll via useAutoScroll; "Back to System Status" and "Back to Sessions" links (latter uses ?focus= param targeting parent abstract session)
- **Sessions List Page** (`/sessions`): fetches abstract sessions from /api/status and renders them with physical sessions (current + history) as children; orphaned physical sessions listed separately; supports ?focus= URL param to highlight and scroll-to a specific abstract session; back link to /status
- **Dashboard Integration**: status modal includes "Open in new tab" link to /status; sessions section always visible in status modal with empty state when no sessions exist; physical session details include "View events" link to events page; stopped session history shown as collapsed toggle ("Stopped sessions (N) ▸") with model, tokens, started time, and events link per entry (v0.30.0)

## Project Skills (.claude/skills/, v0.38.0)

- `.claude/skills/implement/` — skill for feature implementation, bug fixes, and debugging workflow
- `.claude/skills/process-requirements/` — skill for processing raw requirements into documentation

## Key Constraints

- Gateway and agent are independent processes (gateway stop does NOT stop agent)
- Startup direction: always gateway → agent (agent never starts gateway)
- Agent process ensure: gateway start time only (NOT on user message POST)
- Agent session ensure: gateway responsibility via SessionOrchestrator (sends start_physical_session/stop_physical_session to agent via IPC stream)
- Agent version check: gateway enforces minimum agent version (MIN_AGENT_VERSION=0.50.0, exported from agent-manager.ts) at start; force-restart on mismatch with reconnectStream(); checkCompatibility()/getMinAgentVersion() expose compatibility status; CLI checkAgentCompatibility polls /api/status when waitForAgent=true (used after force-restart to wait for new agent bootId)
- Log capture: daemon creates LogBuffer (ring buffer), intercepts console via interceptConsole(); logs served at /api/logs and displayed in dashboard logs panel; LogBuffer optionally writes structured JSON lines to file via enableFileOutput() (gateway.log); agent spawned with stderr redirected to agent.log; agent process initializes its own StructuredLogger writing to agent.log
- Structured logging: StructuredLogger (intentionally duplicated in gateway and agent packages) writes JSON Lines (StructuredLogEntry: ts, level, component, msg, data?) to file via appendFileSync; bridges to OpenTelemetry via optional OtelLoggerBridge parameter (emits log records to OTel LoggerProvider when configured); agent uses structured JSON fallback pattern (console.error with JSON.stringify) before StructuredLogger is initialized — applies to index.ts module-level log/logError, AgentSessionManager defaultLog/defaultLogError, and channel.ts ChannelToolDeps logError
- OpenTelemetry: OTel setup module (otel.ts, intentionally duplicated in gateway and agent) initializes OTLP HTTP exporters for logs and metrics; gateway additionally defines application-level metrics (otel-metrics.ts: session count gauges, token usage counters); endpoints configured via config.otel.endpoints (empty = noop export); agent receives OTel config from gateway via IPC stream config push and initializes independently with serviceName "copilotclaw-agent"
- Channel backoff: SessionOrchestrator tracks channelBackoff map (ephemeral, not persisted); gateway daemon records backoff in onPhysicalSessionEnded when elapsedMs < rapidFailureThresholdMs; isChannelInBackoff() checked before starting sessions (prevents retry storms)
- All Copilot SDK dependencies must be mocked in tests — including E2E. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles must be implemented in place, never deferred as skip
- Test runners: vitest for unit + E2E (469 tests: 84 agent + 353 gateway + 32 frontend), Playwright for browser E2E (8 tests); gateway vitest excludes test/browser/ directory
- Frontend tests: vitest + jsdom + @testing-library/react for React SPA component tests (SessionEventsPage, StatusPage, DashboardPage, SessionsListPage, useAutoScroll)
- Browser E2E tests (Playwright) cover dashboard UI behaviors: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
