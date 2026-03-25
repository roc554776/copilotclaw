<!-- Generated: 2026-03-25 | Files scanned: 15 | Token estimate: ~600 -->

# Backend

## Gateway (packages/gateway)

### API Routes (server.ts)

```
GET  /healthz                              → 200 { status: "ok" }
POST /api/stop                             → 200 { status: "stopping" } → stop agent → exit
GET  /api/channels                         → 200 Channel[]
POST /api/channels                         → 201 Channel
GET  /api/channels/pending                 → 200 { [channelId]: count }
POST /api/channels/:channelId/inputs       → 201 UserInput (+ ensureAgent)
POST /api/channels/:channelId/inputs/next  → 200 UserInput[] | 204 (drain all queued)
GET  /api/channels/:channelId/inputs/peek  → 200 UserInput | 204 (oldest queued, non-destructive)
POST /api/channels/:channelId/inputs/flush → 200 { flushed: count }
POST /api/channels/:channelId/replies      → 200 UserInput (with reply attached)
GET  /                                     → 200 HTML dashboard (channel tabs + chat UI)
```

### Key Files

```
src/server.ts        — HTTP server, route handler, startServer()
src/daemon.ts        — daemon entry point
src/index.ts         — CLI entry point (health check → detached spawn → exit)
src/stop.ts          — POST /api/stop CLI
src/store.ts         — in-memory data (Channel, UserInput, per-channel FIFO queue, pendingCounts, flush)
src/dashboard.ts     — HTML renderer (chat bubbles, channel tabs, input form)
src/agent-manager.ts — IPC-based agent ensure (spawn if not alive)
src/ipc-client.ts    — IPC client (status/stop to agent process)
src/ipc-paths.ts     — socket path: ${tmpdir}/copilotclaw-agent.sock
```

## Agent (packages/agent)

### IPC Protocol (newline-delimited JSON over Unix domain socket)

```
→ {"method":"status"}
← {"startedAt":"...","channels":{"ch-id":{"status":"waiting","startedAt":"..."}}}

→ {"method":"channel_status","params":{"channelId":"ch-id"}}
← {"status":"processing","startedAt":"...","processingStartedAt":"..."}
  (or {"status":"not_running"} if no session exists)

→ {"method":"stop"}
← {"ok":true}  → graceful shutdown of all channel sessions
```

### Key Files

```
src/index.ts                   — singleton entry, gateway polling loop, stale detection
src/channel-session-manager.ts — per-channel Copilot SDK session lifecycle
src/ipc-server.ts              — Unix domain socket IPC server (status/channel_status/stop)
src/ipc-paths.ts               — socket path generation
src/session-loop.ts            — session idle loop (continuePrompt, shouldStop callback)
src/copilot-session-adapter.ts — CopilotSession → SessionLike adapter
src/tools/channel.ts           — copilotclaw_receive_first_input, copilotclaw_reply_and_receive_input
```
