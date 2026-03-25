<!-- Generated: 2026-03-25 | Packages: 2 | Token estimate: ~700 -->

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

- **Gateway**: singleton daemon on port 19741, manages channels, inputs, and messages
- **Agent**: single process, manages agent sessions independently of channels
- **Agent Session**: wraps a Copilot SDK session with its own sessionId, optionally bound to a channel

## Process Model

- Gateway: CLI spawns daemon (detached), CLI exits immediately
- Agent: single process, singleton via Unix domain socket (`copilotclaw-agent.sock`)
- Gateway → Agent: IPC (status/stop), detached spawn to ensure alive, version check on startup
- Agent → Gateway: HTTP API poll (pending counts, drain inputs, post messages, peek/flush)
- Agent manages agent sessions (each with own sessionId), binds them to channels on demand
- Sessions start when channel has pending input, stop on stale timeout or abort

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

- Gateway and agent are independent processes (gateway restart does not kill agent)
- Startup direction: always gateway → agent (agent never starts gateway)
- Agent version check: gateway enforces minimum agent version on ensureAgent; force-restart on mismatch
- All Copilot SDK dependencies must be mocked in tests — including E2E. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles must be implemented in place, never deferred as skip
