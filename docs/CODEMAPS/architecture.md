<!-- Generated: 2026-03-27 | Updated: 2026-03-27 | Packages: 3 (cli, gateway, agent) | Version: 0.21.0 | Token estimate: ~1600 -->

# Architecture

## System Overview

```
┌─────────────┐  HTTP   ┌─────────────┐  IPC (.sock)  ┌─────────────────────────────┐
│   Browser    │◄──────►│   Gateway    │─────────────►│           Agent             │
│  (dashboard) │        │  (daemon)    │               │  ┌───────────────────────┐  │
└─────────────┘        └──────┬──────┘               │  │ AgentSessionManager   │  │
                              │                       │  │  sessions: sessId→…   │  │
                              │ HTTP poll             │  │  bindings: chId→sessId│  │
                              │◄──────────────────────│  └───────────────────────┘  │
                              │                       └────────────┬────────────────┘
                                                                   │
                                                            Copilot SDK
                                                            (mocked in tests)
```

- **Gateway**: singleton daemon (default port 19741, configurable via config file or COPILOTCLAW_PORT env var), manages channels, inputs, and messages; reports GATEWAY_VERSION (from package.json), agentCompatibility, profile, and config (model, zeroPremium, debugMockCopilotUnsafeTools, workspaceRoot) via /api/status; proxies Copilot quota and models from agent via /api/quota and /api/models; serves recent logs via /api/logs (ring buffer)
- **Agent**: single process, manages agent sessions independently of channels
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
- Agent → Gateway: HTTP API poll (pending counts, drain pending, post messages, peek/flush)
- Agent process manages agent sessions: polls gateway for pending, starts session when found
- User message POST does NOT trigger agent process ensure (agent polls on its own)

## Session Keepalive

- `copilotclaw_receive_input` tool blocks for up to 25 min polling gateway for input (keepalive timeout)
- Tool execution keeps Copilot SDK session active (CLI idle timeout = 30 min)
- On keepalive timeout: tool returns empty → keepalive instruction → LLM re-invokes tool
- Premium request consumption: ~1 per 30 min (idle), plus 1 per user interaction cycle

## Custom Agents (v0.16.0+)

- **Channel-operator**: parent agent exclusively bound to the channel (infer:false, cannot be used as subagent); receives full system prompts including deadlock prevention warnings; subscribes to `copilotclaw_receive_input` tool to manage session lifecycle
- **Worker**: subagent available for task delegation (infer:true); can only access `copilotclaw_send_message` and `copilotclaw_list_messages` (never receives `copilotclaw_receive_input`); started by parent agent via subagent dispatch
- Session begins with `agent: "channel-operator"` configuration; custom agent definitions passed to SDK createSession/resumeSession

## System Prompt (v0.19.0+)

- **CHANNEL_OPERATOR_PROMPT**: includes deadlock prevention at start and end, session startup section instructing agent to read SOUL.md (priority), USER.md, memory/ (daily files), and MEMORY.md for context
- **Session Startup**: agent reads workspace bootstrap files in order: SOUL.md (persona), USER.md (user context), memory/YYYY-MM-DD.md files (recent sessions), MEMORY.md (long-term memory)
- **SYSTEM_REMINDER**: periodic deadlock prevention reinforcement via additionalContext

## Subagent Completion Notification (v0.16.0+)

- SDK events `subagent.completed` and `subagent.failed` push completion info (agentName, status, totalTokens, durationMs, error) to a completion queue
- Queue drained in two places: (1) `copilotclaw_receive_input` handler returns subagent info alongside user messages, (2) `onPostToolUse` hook injects `[SUBAGENT COMPLETED]` into additionalContext
- Parent agent can distinguish subagent completions from pending user messages and react accordingly
- SubagentCompletionInfo type exported from tools/channel.ts

## Session Lifecycle (v0.18.0: Persistent Channel Bindings)

- **Abstract vs. Physical Sessions**: Abstract session (sessionId, bound to channel) is separate from physical session (Copilot SDK session). When physical session ends unexpectedly, abstract session transitions to "suspended" (not deleted), preserving channel binding.
- **Session Status**: "starting" → "waiting" → "processing" → "suspended" or "stopped"
  - "suspended": physical session stopped unexpectedly or max age reached; abstract session preserved for revival
  - "stopped": explicit stopSession() — fully removes abstract session and channel binding
- **Suspension via checkStaleAndHandle**: if processing >10 min with pending inputs, suspend (abstract survives), notify channel with timeout message, flush inputs; deferred resume on next pending message
- **Suspension via checkSessionMaxAge**: if "waiting" session exceeds 2 days (default, configurable), suspend and save copilotSessionId for resume
- **Revival via reviveSession**: suspended sessions auto-revive with new physical session when triggered (e.g., user message arrives for the channel); same abstract sessionId reused, copilotSessionId preserved for resumeSession
- **Auto-revival in polling**: startSession auto-detects suspended sessions for a channel via hasActiveSessionForChannel; if suspended, revives with saved copilotSessionId
- **Binding Persistence (v0.18.0+)**: AgentSessionManager accepts optional `persistPath` option (defaults to {{workspaceRoot}}/data/agent-bindings.json); suspended sessions with channel bindings persisted to disk via atomic write (tmp → rename); `loadBindings()` called in constructor (line 192) restores suspended sessions from disk on agent restart, allowing recovery of channel-bound sessions across process boundaries; `saveBindings()` called on suspendSession and stopSession; SessionSnapshot and BindingSnapshot types define persist format
- **savedCopilotSessionIds map**: no longer the primary resume mechanism — copilotSessionId lives on the suspended entry; map kept for potential compatibility
- **Channel notifications**: session stopped (unexpected end) and session timed out (stale processing) post system messages to bound channel

## Key Constraints

- Gateway and agent are independent processes (gateway stop does NOT stop agent)
- Startup direction: always gateway → agent (agent never starts gateway)
- Agent process ensure: gateway start time only (NOT on user message POST)
- Agent session ensure: agent process responsibility (polls gateway for pending)
- Agent version check: gateway enforces minimum agent version (MIN_AGENT_VERSION exported from agent-manager.ts) at start; force-restart on mismatch; checkCompatibility()/getMinAgentVersion() expose compatibility status; CLI checkAgentCompatibility polls /api/status when waitForAgent=true (used after force-restart to wait for new agent bootId)
- Log capture: daemon creates LogBuffer (ring buffer), intercepts console via interceptConsole(); logs served at /api/logs and displayed in dashboard logs panel
- All Copilot SDK dependencies must be mocked in tests — including E2E. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles must be implemented in place, never deferred as skip
- Test runners: vitest for unit + E2E (178 tests: 36 agent + 142 gateway), Playwright for browser E2E (8 tests); vitest excludes test/browser/ directory
- Browser E2E tests (Playwright) cover dashboard UI behaviors: processing indicator SSE hide, SSE chat update, status bar, logs panel toggle/escape, status modal
