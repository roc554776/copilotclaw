<!-- Generated: 2026-03-26 | Updated: 2026-03-26 | Packages: 3 (cli, gateway, agent) | Version: 0.14.0 | Token estimate: ~1400 -->

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
copilotclaw setup                → workspace init + auto-port selection if default busy
copilotclaw start [--force-agent-restart]  → spawn gateway daemon
copilotclaw stop                 → stop gateway (agent keeps running)
copilotclaw restart              → stop + start gateway
copilotclaw update               → fetch upstream to ~/.copilotclaw/source/, pnpm (via npx) build, rewrite workspace:* deps to file: paths, npm install -g from packages/cli/
copilotclaw config get <key>     → show resolved config value (env var override noted)
copilotclaw config set <key> <v> → set config value in file (env var precedence warning)
copilotclaw doctor [--fix]       → diagnose environment (workspace, config, gateway, agent); --fix auto-repairs fixable issues
copilotclaw agent stop           → stop agent process only
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

## Session Lifecycle

- Session ends normally (idle) → status set to "stopped" → gateway notified via POST messages
- Session error → status "stopped" → gateway notified
- Max age enforcement: sessions exceeding 2 days (default, configurable via maxSessionAgeMs) save copilotSessionId to savedCopilotSessionIds map when in "waiting" status, then stop session (no immediate restart); checked each poll cycle before stale detection
- Stale detection: if processing >10 min with pending inputs, save copilotSessionId and stop session; notify channel with timeout message, flush inputs (single detection, no restart/retry logic)
- Deferred resume: main polling loop checks for saved sessions when pending messages are found; consumeSavedSession retrieves and removes the saved copilotSessionId, then startSession resumes with that copilotSessionId
- Channel notifications: session stopped and session timed out events post system messages to the bound channel via postChannelMessage helper

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
