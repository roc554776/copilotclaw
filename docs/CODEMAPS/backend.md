<!-- Generated: 2026-03-26 | Files scanned: 21 | Token estimate: ~900 -->

# Backend

## Gateway (packages/gateway)

### API Routes (server.ts)

```
GET  /healthz                              → 200 { status: "ok" }
POST /api/stop                             → 200 { status: "stopping" } → stop agent → exit (localhost only)
GET  /api/status                           → 200 { gateway: {status}, agent: AgentStatusResponse|null }
GET  /api/channels                         → 200 Channel[]
POST /api/channels                         → 201 Channel
GET  /api/channels/pending                 → 200 { [channelId]: count }
GET  /api/channels/:channelId/messages              → 200 Message[] (?limit=N, reverse-chronological)
POST /api/channels/:channelId/messages              → 201 Message (sender: "user"|"agent", user messages go to pending queue + ensureAgent)
POST /api/channels/:channelId/messages/pending      → 200 Message[] | 204 (drain all pending user messages)
GET  /api/channels/:channelId/messages/pending/peek → 200 Message | 204 (oldest pending, non-destructive)
POST /api/channels/:channelId/messages/pending/flush → 200 { flushed: count }
GET  /                                     → 200 HTML dashboard (status bar + channel tabs + chat UI)
```

### Key Files

```
src/server.ts        — HTTP server, route handler, startServer(), dashboard agent status
src/daemon.ts        — daemon entry point (ensureWorkspace + Store init + startServer)
src/index.ts         — CLI entry point (health check → detached spawn → exit)
src/stop.ts          — POST /api/stop CLI
src/setup.ts         — `copilotclaw setup` CLI: create workspace directories
src/update.ts        — `copilotclaw update` CLI: git pull + pnpm build self-update (COPILOTCLAW_UPSTREAM for file URL)
src/workspace.ts     — workspace paths: ~/.copilotclaw/ root, data/, store.json; ensureWorkspace()
src/store.ts         — persistent store (Channel, Message, per-channel pending queue); JSON file via atomic rename
src/dashboard.ts     — HTML renderer (status bar, chat bubbles, channel tabs, input form)
src/agent-manager.ts — IPC-based agent process ensure at gateway start (spawn, version check, force-restart)
src/ipc-client.ts    — IPC client (status/stop to agent process)
src/ipc-paths.ts     — socket path: ${tmpdir}/copilotclaw-agent.sock
```

### Workspace Layout

```
~/.copilotclaw/
  data/
    store.json    — persisted channels + messages + pending queues (atomic write via .tmp rename)
```

## Agent (packages/agent)

### IPC Protocol (newline-delimited JSON over Unix domain socket)

```
→ {"method":"status"}
← {"version":"0.1.0","startedAt":"...","sessions":{"sess-id":{"status":"waiting","startedAt":"...","boundChannelId":"ch-id"}}}

→ {"method":"session_status","params":{"sessionId":"sess-id"}}
← {"status":"processing","startedAt":"...","processingStartedAt":"...","boundChannelId":"ch-id"}
  (or {"status":"not_running"} if no session exists)

→ {"method":"stop"}
← {"ok":true}  → graceful shutdown of all sessions
```

### Copilot SDK Tools (tools/channel.ts)

```
copilotclaw_send_message(message)   — send a message to the channel (non-blocking)
copilotclaw_receive_input()         — block polling for pending user messages (25 min keepalive timeout)
copilotclaw_list_messages(limit?)   — list recent channel messages (reverse-chronological)
```

### SDK Hooks

- `onPostToolUse` — peeks channel for pending user messages, injects additionalContext notification

### Key Files

```
src/index.ts                    — singleton entry, gateway polling loop, stale detection
src/agent-session-manager.ts    — per-session lifecycle, channel binding, stale restart, stopped notification
src/ipc-server.ts               — Unix domain socket IPC server (status/session_status/stop), version reporting
src/ipc-paths.ts                — socket path generation
src/session-loop.ts             — session idle loop (subscribe/send/disconnect, no continuePrompt)
src/copilot-session-adapter.ts  — CopilotSession → SessionLike adapter
src/stop.ts                     — CLI stop command (IPC stop)
src/tools/channel.ts            — send_message, receive_input, list_messages tools
```
