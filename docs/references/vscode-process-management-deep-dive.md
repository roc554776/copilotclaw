# VSCode Process Management: Source Code Deep Dive

Quick-reference for implementing VSCode-style singleton/IPC patterns in Node.js. Based on direct source code reading of microsoft/vscode.

## Overview

VSCode has two independent singleton systems:
- **Rust CLI** (`cli/src/`) — tunnel/server management, uses file lock + IPC socket
- **Electron main process** (`src/vs/`) — desktop app, uses try-listen / fallback-to-connect

Both share the same conceptual pattern but differ in implementation.

---

## Rust CLI Singleton

### File Lock: `cli/src/util/file_lock.rs`

```rust
pub struct FileLock { file: File }

pub enum Lock {
    Acquired(FileLock),       // this process is the server
    AlreadyLocked(File),      // another process holds it — the file is still readable
}
```

- Unix: `flock(fd, LOCK_EX | LOCK_NB)`. Returns `EWOULDBLOCK` if already held.
- Windows: `LockFileEx(..., LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)`.
- Lock is released on `Drop` (i.e. when process exits or panics).

**Windows caveat:** `LockFileEx` blocks reads on the locked byte range. Therefore `PREFIX_LOCKED_BYTES = 1` on Windows (only byte 0 is locked). On Unix `PREFIX_LOCKED_BYTES = 0` because `flock` does not block reads.

### Singleton Orchestrator: `cli/src/singleton.rs`

```rust
struct LockFileMatter { socket_path: String, pid: u32 }  // msgpack-serialized into lock file

enum SingletonConnection {
    Singleton(SingletonServer),   // we won the lock
    Client(AsyncPipe),            // someone else has it
}
```

**`acquire_singleton(lock_file)` flow:**

```
open lock file (O_RDWR | O_CREAT, no truncate)
  → flock(LOCK_EX | LOCK_NB)
    → acquired → start_singleton_server(lock)
    → already_locked → connect_as_client_with_file(file)
```

**Server startup (`start_singleton_server`):**
- Generate random socket path: `tmpdir/vscode-{uuid}` (Unix) or `\\.\pipe\vscode-{uuid}` (Windows)
- Write `[PREFIX zeros] + msgpack({ socket_path, pid })` into lock file
- `listen_socket_rw_stream(socket_path)` — begin accepting connections
- Return `SingletonServer { server, _lock }` — dropping releases both

**Client connection (`connect_as_client_with_file`):**
- Seek past `PREFIX_LOCKED_BYTES`, deserialize `LockFileMatter`
- Race two futures:
  - `retry_get_socket_rw_stream(socket_path, 5 attempts, 500ms apart)`
  - `wait_until_process_exits(pid, 500ms poll)` — early out if server died
- Outer retry: up to `MAX_CLIENT_ATTEMPTS = 10` with 500ms sleep (handles race where server has lock but hasn't written file yet)

### Socket Abstraction: `cli/src/async_pipe.rs`

```
Unix:  AsyncPipe = tokio::net::UnixStream
       listen    = UnixListener::bind(path)
       connect   = UnixStream::connect(path)

Windows: AsyncPipe = NamedPipeClient | NamedPipeServer
         listen    = ServerOptions::new().first_pipe_instance(true).create(path)
         connect   = ClientOptions::new().open(path), retry on ERROR_PIPE_BUSY (231)
```

Socket name: `{tmpdir}/{app_name}-{uuid4}` (Unix) or `\\.\pipe\{app_name}-{uuid4}` (Windows).

### JSON-RPC Server: `cli/src/tunnels/singleton_server.rs`

RPC methods:

| Method | Action |
|:---|:---|
| `restart` | Sends `ShutdownSignal::RpcRestartRequested` on broadcast |
| `status` | Returns `StatusWithTunnelName { name, status }` from in-memory state |
| `shutdown` | Broadcasts shutdown notification to all clients, then sends `ShutdownSignal::RpcShutdownRequested` |

Connection loop: `tokio::select!` on `server.accept()` vs `shutdown_fut`. Each client connection spawns a task.

Log broadcasting: `BroadcastLogSink` keeps a 50-item ring buffer. New clients receive replayed logs, then live messages via `broadcast::channel`.

### JSON-RPC Client: `cli/src/tunnels/singleton_client.rs`

- Interactive TTY: stdin thread reads `'x'` → `METHOD_SHUTDOWN`, `'r'` → `METHOD_RESTART`, Ctrl-C → detach (server stays alive)
- `do_single_rpc_call(lock_file, method, params)` — fire-and-forget RPC for CLI subcommands like `tunnel status`

### Tunnel Serve Loop: `cli/src/commands/tunnels.rs`

```rust
let server = loop {
    match acquire_singleton(&lock_file).await {
        Client(stream) => {
            let should_exit = start_singleton_client(...).await;
            if should_exit { return Ok(0); }
            // server died/restarted, loop and try to become singleton
        }
        Singleton(server) => break server,
        Err(e) => { sleep(2s); retry; }
    }
};
```

Restart: re-spawns itself with `Command::new(current_exe()).args(env::args().skip(1)).spawn()?.wait()`. Synchronous — parent waits for child.

### Shutdown Signals: `cli/src/tunnels/shutdown_signal.rs`

```rust
enum ShutdownSignal {
    CtrlC,
    ParentProcessKilled(Pid),
    ExeUninstalled,
    ServiceStopped,
    RpcShutdownRequested,
    RpcRestartRequested,
}
```

Raced with `FuturesUnordered`, first signal wins.

---

## Electron Main Process Singleton

### Socket Path: `src/vs/base/parts/ipc/node/ipc.net.ts`

```typescript
function createStaticIPCHandle(directoryPath, type, version) {
    const scope = sha256(directoryPath).slice(0, 8);
    // Windows: \\.\pipe\{scope}-{version}-{type}-sock
    // Linux:   $XDG_RUNTIME_DIR/vscode-{scope}-{version4}-{type6}.sock
    // macOS:   {directoryPath}/{version4}-{type6}.sock
}
```

Path length limits: Linux ≤ 107 bytes, macOS ≤ 103 bytes.

`XDG_RUNTIME_DIR` is captured once at module load to prevent later env mutations.

### serve / connect

```typescript
function serve(hook: string): Promise<Server> {
    // net.createServer().listen(hook)
}

function connect(hook: string, clientId: string): Promise<Client> {
    // net.createConnection(hook, callback)
}
```

### Instance Claiming: `src/vs/code/electron-main/main.ts`

**`claimInstance` flow:**

```
try nodeIPCServe(mainIPCHandle)
  → success → we are the first instance
    - register server.dispose() on onWillShutdown
    - write PID to mainLockfile
    - continue with CodeApplication.startup()

  → EADDRINUSE → another instance is running
    try nodeIPCConnect(mainIPCHandle)
      → success → forward args to running instance via ProxyChannel('launch')
        - then exit cleanly (throw ExpectedError)
      → ECONNREFUSED (Linux/macOS only)
        # stale socket — server died without cleanup
        unlinkSync(mainIPCHandle)
        return claimInstance(..., retry=false)  // retry once only
      → other errors → show dialog, throw
```

### Lifecycle / Graceful Shutdown: `lifecycleMainService.ts`

Phases: `Starting → Ready → AfterWindowOpen → Eventually`. Each backed by a `Barrier` (one-shot promise).

**`onWillShutdown` joiner pattern:**
- Handlers call `evt.join(id, promise)` to delay exit until cleanup completes
- `Promise.allSettled` — one failing joiner does not block others

**`process.once('exit', () => disposables.dispose())` — backstop for abnormal exits.**

---

## Key Patterns for Node.js Implementation

### Singleton via socket (Electron pattern — simplest for Node.js)

```
try net.createServer().listen(socketPath)
  → success → you are the singleton
  → EADDRINUSE → try net.createConnection(socketPath)
    → success → existing singleton is alive (send command, exit)
    → ECONNREFUSED → unlink(socketPath), retry listen once
```

### Socket path generation

Deterministic from stable input (channel ID, user data dir, etc.):
```
${os.tmpdir()}/copilotclaw-agent-${channelId}.sock
```
Validate length < 103 bytes (macOS limit).

### Stale socket cleanup

- On `EADDRINUSE` + `ECONNREFUSED`: `unlinkSync(socketPath)`, retry listen once
- On Windows: named pipes are kernel-managed, no stale files

### Process zombie prevention

- `process.once('exit', cleanup)` as backstop
- Release IPC server in shutdown handler (stops accepting connections)
- Parent processes: `child.wait()` or `child.unref()` — never leave unreferenced children

### Graceful shutdown

- Joiner pattern: collect async cleanup tasks with `Promise.allSettled`
- Close IPC server first (reject new connections), then drain existing work

### IPC protocol

Newline-delimited JSON over the socket is simplest for Node.js:
```json
{"method":"status"}\n
{"method":"stop"}\n
{"method":"restart"}\n
```
