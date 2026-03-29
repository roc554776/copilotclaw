<!-- Generated: 2026-03-27 | Updated: 2026-03-28 | Packages: 3 (cli, gateway, agent) | Version: 0.38.0 | Token estimate: ~2200 -->

# Architecture

## System Overview

```
┌─────────────┐  HTTP   ┌─────────────┐  IPC (.sock)  ┌─────────────────────────────┐
│   Browser    │◄──────►│   Gateway    │◄────────────►│           Agent             │
│  (dashboard) │        │  (daemon)    │  (stream +    │  ┌───────────────────────┐  │
└─────────────┘        └─────────────┘   short-lived) │  │ AgentSessionManager   │  │
                                                       │  │  sessions: sessId→…   │  │
                                                       │  │  bindings: chId→sessId│  │
                                                       └──┴───────────────────────┴──┘
                                                                   │
                                                            Copilot SDK
                                                            (mocked in tests)
```

- **Gateway**: singleton daemon (default port 19741, configurable via config file or COPILOTCLAW_PORT env var), manages channels, inputs, and messages; reports GATEWAY_VERSION (from package.json), agentCompatibility, profile, and config (model, zeroPremium, debugMockCopilotUnsafeTools, stateDir, workspaceRoot, auth.github, otel) via /api/status; proxies Copilot quota and models from agent via /api/quota and /api/models; serves recent logs via /api/logs (ring buffer); hosts observability infrastructure (session event store, system prompt snapshots, status page, events page); initializes OTel at startup (logs + metrics export via OTLP HTTP) and shuts down on exit
- **Agent**: single process, manages agent sessions independently of channels; communicates with gateway exclusively via IPC (stream for push-based messaging, short-lived connections for status/stop/quota/models); receives OTel config from gateway via IPC stream config push and initializes its own OTel setup independently
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
- Agent ↔ Gateway: IPC stream (v0.35.0) — persistent bidirectional connection; gateway pushes config and pending_notify; agent pushes channel messages, session events, system prompts; agent sends request-response for drain/peek/flush/list_messages
- Agent process manages agent sessions: listens for pending_notify push from gateway via IPC stream, starts session when notified
- User message POST triggers gateway notifyPending via IPC stream (push-based, no polling)

## Session Keepalive

- `copilotclaw_wait` tool blocks for up to 25 min polling gateway for input (keepalive timeout)
- Tool execution keeps Copilot SDK session active (CLI idle timeout = 30 min)
- On keepalive timeout: tool returns empty → keepalive instruction → LLM re-invokes tool
- Premium request consumption: ~1 per 30 min (idle), plus 1 per user interaction cycle

## Custom Agents (v0.16.0+)

- **Channel-operator**: parent agent exclusively bound to the channel (infer:false, cannot be used as subagent); receives full system prompts including deadlock prevention warnings; subscribes to `copilotclaw_wait` (WAIT_TOOL_NAME) tool to manage session lifecycle
- **Worker**: subagent available for task delegation (infer:true); can only access `copilotclaw_send_message` and `copilotclaw_list_messages` (never receives `copilotclaw_wait`); started by parent agent via subagent dispatch
- Session begins with `agent: "channel-operator"` configuration; custom agent definitions passed to SDK createSession/resumeSession

## System Prompt (v0.19.0+)

- **CHANNEL_OPERATOR_PROMPT**: includes deadlock prevention at start and end, Workspace section describing git-managed workspace files (SOUL.md/USER.md/TOOLS.md/MEMORY.md/memory/) and instructing agent to commit changes, session startup section instructing agent to read SOUL.md (priority), USER.md, memory/ (daily files), and MEMORY.md for context; Lifecycle section with broader wait semantics (copilotclaw_wait use cases: waiting for user reply, subagent completion, all work done, unknown what to do, unexpected system error)
- **Session Startup**: agent reads workspace bootstrap files in order: SOUL.md (persona), USER.md (user context), memory/YYYY-MM-DD.md files (recent sessions), MEMORY.md (long-term memory)
- **SYSTEM_REMINDER**: periodic deadlock prevention reinforcement via additionalContext

## Subagent Completion Notification (v0.16.0+)

- SDK events `subagent.completed` and `subagent.failed` push completion info (agentName, status, totalTokens, durationMs, error) to a completion queue
- Queue drained in two places: (1) `copilotclaw_wait` handler returns subagent info alongside user messages, (2) `onPostToolUse` hook injects `[SUBAGENT COMPLETED]` into additionalContext
- Parent agent can distinguish subagent completions from pending user messages and react accordingly
- SubagentCompletionInfo type exported from tools/channel.ts

## Session Lifecycle (v0.18.0: Persistent Channel Bindings)

- **Abstract vs. Physical Sessions**: Abstract session (sessionId, bound to channel) is separate from physical session (Copilot SDK session). When physical session ends unexpectedly, abstract session transitions to "suspended" (not deleted), preserving channel binding.
- **Session Status**: "starting" → "waiting" → "processing" → "suspended" or "stopped"
  - "suspended": physical session stopped unexpectedly or max age reached; abstract session preserved for revival
  - "stopped": explicit stopSession() — fully removes abstract session and channel binding
- **Suspension via checkStaleAndHandle**: if processing >10 min with pending inputs, suspend (abstract survives), notify channel with timeout message, flush inputs; deferred resume on next pending message
- **Suspension via checkSessionMaxAge**: if "waiting" session exceeds 2 days (default, configurable), suspend and clear copilotSessionId (so next revival creates a new physical session rather than resuming the old one)
- **Revival via reviveSession**: suspended sessions auto-revive with new physical session when triggered (e.g., user message arrives for the channel); same abstract sessionId reused, copilotSessionId preserved for resumeSession; resumeSession wrapped in try/catch — on failure, clears copilotSessionId and falls back to createSession (v0.38.0)
- **Auto-revival in polling**: startSession auto-detects suspended sessions for a channel via hasActiveSessionForChannel; if suspended, revives with saved copilotSessionId
- **Binding Persistence (v0.18.0+)**: AgentSessionManager accepts optional `persistPath` option (defaults to {{stateDir}}/data/agent-bindings.json — uses stateDir, not workspaceRoot); suspended sessions with channel bindings persisted to disk via atomic write (tmp → rename); `loadBindings()` called in constructor (line 192) restores suspended sessions from disk on agent restart, allowing recovery of channel-bound sessions across process boundaries; restores cumulative token data and physicalSessionHistory from snapshots; `saveBindings()` called on suspendSession and stopSession; SessionSnapshot and BindingSnapshot types define persist format; SessionSnapshot includes cumulativeInputTokens/cumulativeOutputTokens, physicalSessionHistory (v0.30.0)
- **Cumulative Token Tracking (v0.27.0)**: AgentSessionInfo tracks cumulativeInputTokens and cumulativeOutputTokens across physical sessions; suspendSession() accumulates token usage via delta calculation when same physical session is resumed (compares against last history entry to compute delta, preventing double-counting); cumulative totals persisted in SessionSnapshot via saveBindings() and restored via loadBindings(); dashboard shows cumulative tokens; IPC AgentSessionStatusResponse includes cumulative token fields
- **Stopped Session History (v0.30.0)**: AgentSessionInfo has physicalSessionHistory (PhysicalSessionSummary[]); suspendSession() pushes a copy of the physical session (with currentState set to "stopped") to history before clearing physicalSession; capped at 10 entries (oldest removed); persisted in SessionSnapshot via saveBindings() and restored via loadBindings(); IPC AgentSessionStatusResponse includes physicalSessionHistory field
- **savedCopilotSessionIds map**: no longer the primary resume mechanism — copilotSessionId lives on the suspended entry; map kept for potential compatibility
- **Channel notifications**: session stopped (unexpected end) and session timed out (stale processing) post system messages to bound channel

## Observability (v0.28.0, SQLite v0.29.0)

- **SessionEventStore**: SQLite-based event storage (session-events.db in data dir, WAL mode); table: session_events (sessionId, type, timestamp, data as JSON, parentId; indexed by sessionId, sessionId+timestamp, type); stores system prompt snapshots as JSON files in `{{stateDir}}/data/prompts/`; enforces configurable storage cap by row count (default 100k events) by deleting oldest rows every 500 inserts
- **Event Forwarding**: agent registers SDK event listeners (session.idle, session.error, tool.execution_start/complete, subagent.started/completed/failed, assistant.message/usage/turn_start/turn_end, session.compaction_start/complete, session.usage_info, session.model_change, session.title_changed) and forwards them to gateway via fire-and-forget IPC stream push (type "session_event")
- **System Prompt Capture**: agent uses registerTransformCallbacks("*") on CopilotSession to intercept the original system prompt from the SDK; captured prompt forwarded to gateway via IPC stream push as both original prompt (type "system_prompt_original", per-model) and session prompt (type "system_prompt_session", per-session)
- **React SPA Frontend (v0.32.0)**: Vite + React + TypeScript SPA in `packages/gateway/frontend/`; routes: `/` (DashboardPage), `/status` (StatusPage), `/sessions` (SessionsListPage), `/sessions/:sessionId/events` (SessionEventsPage); hooks: useAutoScroll (position-based scroll follow), usePolling (generic interval polling); API client: `api.ts` with typed fetch wrappers for all gateway endpoints; built to `frontend-dist/` via `build:frontend` script; server serves SPA with fallback to old server-rendered HTML pages (observability-pages.ts) when `frontend-dist/` not present
- **Status Page** (`/status`): shows gateway, agent, sessions (with elapsed time helper), config, and original system prompts; sessions section always visible with empty state when no sessions exist; auto-refreshes every 5s; links to session event pages and session prompt viewer; shows stopped session history per session (v0.30.0); sessions link text: "All sessions →" (v0.36.0, changed from "All physical sessions →")
- **Events Page** (`/sessions/:id/events`): shows session events with event count in heading, flat event list and auto-scroll; auto-refreshes every 2s; "Back to System Status" and "Back to Sessions" links (latter uses ?focus= param targeting parent abstract session)
- **Sessions List Page** (`/sessions`): fetches abstract sessions from /api/status and renders them with physical sessions (current + history) as children; orphaned physical sessions listed separately; supports ?focus= URL param to highlight and scroll-to a specific abstract session; back link to /status
- **Dashboard Integration**: status modal includes "Open in new tab" link to /status; sessions section always visible in status modal with empty state when no sessions exist; physical session details include "View events" link to events page; stopped session history shown as collapsed toggle ("Stopped sessions (N) ▸") with model, tokens, started time, and events link per entry (v0.30.0)

## Project Skills (.claude/skills/, v0.38.0)

- `.claude/skills/implement/` — skill for feature implementation, bug fixes, and debugging workflow
- `.claude/skills/process-requirements/` — skill for processing raw requirements into documentation

## Key Constraints

- Gateway and agent are independent processes (gateway stop does NOT stop agent)
- Startup direction: always gateway → agent (agent never starts gateway)
- Agent process ensure: gateway start time only (NOT on user message POST)
- Agent session ensure: agent process responsibility (listens for pending_notify via IPC stream)
- Agent version check: gateway enforces minimum agent version (MIN_AGENT_VERSION exported from agent-manager.ts) at start; force-restart on mismatch with reconnectStream(); checkCompatibility()/getMinAgentVersion() expose compatibility status; CLI checkAgentCompatibility polls /api/status when waitForAgent=true (used after force-restart to wait for new agent bootId)
- Log capture: daemon creates LogBuffer (ring buffer), intercepts console via interceptConsole(); logs served at /api/logs and displayed in dashboard logs panel; LogBuffer optionally writes structured JSON lines to file via enableFileOutput() (gateway.log); agent spawned with stderr redirected to agent.log; agent process initializes its own StructuredLogger writing to agent.log
- Structured logging: StructuredLogger (intentionally duplicated in gateway and agent packages) writes JSON Lines (StructuredLogEntry: ts, level, component, msg, data?) to file via appendFileSync; bridges to OpenTelemetry via optional OtelLoggerBridge parameter (emits log records to OTel LoggerProvider when configured); agent uses structured JSON fallback pattern (console.error with JSON.stringify) before StructuredLogger is initialized — applies to index.ts module-level log/logError, AgentSessionManager defaultLog/defaultLogError, and channel.ts ChannelToolDeps logError
- OpenTelemetry: OTel setup module (otel.ts, intentionally duplicated in gateway and agent) initializes OTLP HTTP exporters for logs and metrics; gateway additionally defines application-level metrics (otel-metrics.ts: session count gauges, token usage counters); endpoints configured via config.otel.endpoints (empty = noop export); agent receives OTel config from gateway via IPC stream config push and initializes independently with serviceName "copilotclaw-agent"
- Channel backoff: AgentSessionManager tracks channelBackoff map; recordBackoffIfRapidFailure() sets backoff when session fails within rapid-failure threshold; isChannelInBackoff() checked in polling loop to skip channels in backoff (prevents retry storms); notifyChannelSessionStopped() includes error reason in system message when available
- All Copilot SDK dependencies must be mocked in tests — including E2E. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles must be implemented in place, never deferred as skip
- Test runners: vitest for unit + E2E (363 tests: 91 agent + 241 gateway + 31 frontend), Playwright for browser E2E (8 tests); gateway vitest excludes test/browser/ directory
- Frontend tests: vitest + jsdom + @testing-library/react for React SPA component tests (SessionEventsPage, StatusPage, DashboardPage, SessionsListPage, useAutoScroll)
- Browser E2E tests (Playwright) cover dashboard UI behaviors: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
