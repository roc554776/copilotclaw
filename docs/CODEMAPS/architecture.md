<!-- Generated: 2026-03-25 | Packages: 2 | Token estimate: ~600 -->

# Architecture

## System Overview

```
┌─────────────┐  HTTP   ┌─────────────┐  IPC (.sock)  ┌─────────────────────────────┐
│   Browser    │◄──────►│   Gateway    │─────────────►│           Agent             │
│  (dashboard) │        │  (daemon)    │               │  ┌───────────────────────┐  │
└─────────────┘        └──────┬──────┘               │  │ AgentSessionManager   │  │
                              │                       │  │  sessions: sessionId→… │  │
                              │ HTTP poll             │  │  bindings: chId→sessId │  │
                              │◄──────────────────────│  └───────────────────────┘  │
                              │                       └────────────┬────────────────┘
                                                                   │
                                                            Copilot SDK
                                                            (mocked in tests)
```

- **Gateway**: singleton daemon on port 19741, manages channels and user inputs
- **Agent**: single process, manages agent sessions independently of channels
- **Agent Session**: wraps a Copilot SDK session with its own sessionId, optionally bound to a channel

## Process Model

- Gateway: CLI spawns daemon (detached), CLI exits immediately
- Agent: single process, singleton via Unix domain socket (`copilotclaw-agent.sock`)
- Gateway → Agent: IPC (status/stop), detached spawn to ensure alive
- Agent → Gateway: HTTP API poll (pending counts, drain inputs, post replies, peek/flush)
- Agent manages agent sessions (each with own sessionId), binds them to channels on demand
- Sessions start when channel has pending input, stop on stale timeout

## Session Keepalive

- `copilotclaw_*` tool handlers block for up to 25 min polling gateway for input (keepalive timeout)
- Tool execution keeps Copilot SDK session active (CLI idle timeout = 30 min)
- On keepalive timeout: tool returns empty keepalive instruction → idle fires → `session.send()` consumes 1 premium request → tool re-invoked
- Premium request consumption: ~1 per 30 min (idle), plus 1 per user interaction cycle

## Key Constraints

- Gateway and agent are independent processes (gateway restart does not kill agent)
- Startup direction: always gateway → agent (agent never starts gateway)
- All Copilot SDK dependencies must be mocked in tests — including E2E. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles must be implemented in place, never deferred as skip
