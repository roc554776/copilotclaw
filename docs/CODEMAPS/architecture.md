<!-- Generated: 2026-03-26 | Packages: 2 | Token estimate: ~850 -->

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

- **Gateway**: singleton daemon on port 19741, manages channels, inputs, and messages; reports GATEWAY_VERSION (from package.json) via /api/status
- **Agent**: single process, manages agent sessions independently of channels
- **Agent Session**: wraps a Copilot SDK session with its own sessionId, optionally bound to a channel
- **ChannelProvider**: plugin interface for chat mediums (built-in chat, Discord, Telegram, etc.); providers handle medium-specific routes and receive message notifications
- **BuiltinChatChannel**: default ChannelProvider — serves dashboard UI at "/", SSE at "/api/events", broadcasts via WsBroadcaster

## CLI Entrypoint (bin/copilotclaw.mjs)

```
copilotclaw setup                → workspace init (~/.copilotclaw/)
copilotclaw start [--force-agent-restart]  → spawn gateway daemon
copilotclaw stop                 → stop gateway (agent keeps running)
copilotclaw restart              → stop + start gateway
copilotclaw update               → git pull + pnpm build
copilotclaw agent stop           → stop agent process only
```

## Process Model

- Gateway: CLI spawns daemon (detached), CLI exits immediately
- Agent: single process, singleton via Unix domain socket (`copilotclaw-agent.sock`)
- Gateway start → agent process ensure: IPC status + version check, spawn if absent
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
- Stale detection: if processing >10 min with pending inputs, restart once; if stuck again, flush inputs

## Key Constraints

- Gateway and agent are independent processes (gateway stop does NOT stop agent)
- Startup direction: always gateway → agent (agent never starts gateway)
- Agent process ensure: gateway start time only (NOT on user message POST)
- Agent session ensure: agent process responsibility (polls gateway for pending)
- Agent version check: gateway enforces minimum agent version at start; force-restart on mismatch
- All Copilot SDK dependencies must be mocked in tests — including E2E. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles must be implemented in place, never deferred as skip
