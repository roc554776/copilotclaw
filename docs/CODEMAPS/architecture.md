<!-- Generated: 2026-03-25 | Packages: 2 | Token estimate: ~600 -->

# Architecture

## System Overview

```
┌─────────────┐  HTTP   ┌─────────────┐  IPC (.sock)  ┌──────────────────────┐
│   Browser    │◄──────►│   Gateway    │◄────────────►│       Agent          │
│  (dashboard) │        │  (daemon)    │               │  (single process)    │
└─────────────┘        └──────┬──────┘               │  ┌──────────────┐   │
                              │                       │  │ Ch Session A │   │
                              │ HTTP poll             │  │ Ch Session B │   │
                              │◄──────────────────────│  │ Ch Session … │   │
                              │                       │  └──────────────┘   │
                              │                       └────────┬─────────────┘
                                                              │
                                                       Copilot SDK
                                                       (mocked in tests)
```

- **Gateway**: singleton daemon on port 19741, manages channels and user inputs
- **Agent**: single process managing all channels, each with its own Copilot SDK session

## Process Model

- Gateway: CLI spawns daemon (detached), CLI exits immediately
- Agent: single process, singleton via Unix domain socket (`copilotclaw-agent.sock`)
- Gateway → Agent: IPC (status/stop), detached spawn to ensure alive
- Agent → Gateway: HTTP API poll (pending counts, drain inputs, post replies, peek/flush)
- Agent internally manages channel sessions: starts on pending input, stops on stale timeout

## Key Constraints

- Gateway and agent are independent processes (gateway restart does not kill agent)
- Startup direction: always gateway → agent (agent never starts gateway)
- All Copilot SDK dependencies must be mocked in tests — including E2E. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles must be implemented in place, never deferred as skip
