# @github/copilot-sdk v0.2.0 Reference

SDK: `@github/copilot-sdk` ^0.2.0
Source: `https://github.com/github/copilot-sdk.git`
Description: TypeScript SDK for programmatic control of GitHub Copilot CLI via JSON-RPC.
Dependency: `@github/copilot` ^1.0.10 (the CLI binary), `vscode-jsonrpc` ^8.2.1, `zod` ^4.3.6

Source files studied (from repo root `nodejs/src/`):
- `index.ts` -- public exports
- `client.ts` -- `CopilotClient` class
- `session.ts` -- `CopilotSession` class
- `types.ts` -- all type definitions
- `extension.ts` -- `joinSession` for child-process extensions
- `generated/rpc.ts` -- auto-generated JSON-RPC types and helper functions
- `generated/session-events.ts` -- **全セッションイベントの型定義の権威的ソース**。イベントの追加・変更を調査する際はこのファイルを参照すること（`{{copilot-sdk-repo}}/github/copilot-sdk/nodejs/src/generated/session-events.ts` でローカル参照可能）

---

## Session Context

### What is included in a session

When `createSession` is called, the SDK sends a `session.create` RPC to the Copilot CLI with the following fields:

```typescript
{
  model,
  sessionId,
  clientName,
  reasoningEffort,        // "low" | "medium" | "high" | "xhigh"
  tools,                  // SDK-external tools (name, description, JSON schema params)
  commands,               // slash commands (name, description)
  systemMessage,          // system prompt config (append/replace/customize)
  availableTools,         // allowlist of tool names
  excludedTools,          // denylist of tool names
  provider,               // BYOK provider config
  requestPermission: true,
  requestUserInput,       // boolean
  hooks,                  // boolean (whether hooks are registered)
  workingDirectory,
  streaming,
  mcpServers,             // Record<string, MCPServerConfig>
  customAgents,           // CustomAgentConfig[]
  agent,                  // name of custom agent to activate at start
  configDir,
  skillDirectories,       // string[]
  disabledSkills,         // string[]
  infiniteSessions,       // InfiniteSessionConfig
  envValueMode: "direct",
  traceparent,            // W3C trace context (optional)
  tracestate,
}
```

The CLI itself constructs the system prompt. The SDK controls it via `systemMessage`:

**System prompt sections** (managed by the CLI):
`identity`, `tone`, `tool_efficiency`, `environment_context`, `code_change_rules`, `guidelines`, `safety`, `tool_instructions`, `custom_instructions`, `last_instructions`

### Persistent context across turns

Context persists through conversation history within a session. The SDK does not provide a separate "persistent context" API -- context is the session itself. You can:

- Resume a session with `client.resumeSession(sessionId, config)` to continue with all history intact.
- Use `session.getMessages()` to retrieve the full event/message history.
- Inject additional context through the `systemMessage` configuration.
- Use `session.log(message)` to add messages to the session timeline.

### Skills loading

Skills are loaded via:
- `skillDirectories: string[]` in `SessionConfig` -- directories to load skills from
- `disabledSkills: string[]` -- skills to exclude
- Runtime management via `session.rpc.skills.list()`, `.enable()`, `.disable()`, `.reload()`

---

## Session Mutability

### Tools/hooks after session starts

Tools, hooks, commands, and permission handlers are registered on the `CopilotSession` object **before** the `session.create` RPC is issued. They are fixed at creation time -- there is no public API to add or remove tools from an active session.

However, the internal methods exist:

```typescript
// Internal methods on CopilotSession (marked @internal)
session.registerTools(tools?: Tool[]): void          // clears all and re-registers
session.registerCommands(commands?): void             // clears all and re-registers
session.registerPermissionHandler(handler?): void
session.registerUserInputHandler(handler?): void
session.registerHooks(hooks?): void
session.registerTransformCallbacks(callbacks?): void
```

These are called by `CopilotClient` during creation/resume. They are not part of the public API. Calling `registerTools` after session start would update SDK-side handlers but would NOT re-register them with the CLI server (the CLI only receives tool definitions during `session.create` / `session.resume`).

For MCP servers, runtime management IS available:
```typescript
session.rpc.mcp.list()
session.rpc.mcp.enable({ serverName, config })
session.rpc.mcp.disable({ serverName })
session.rpc.mcp.reload()
```

For extensions:
```typescript
session.rpc.extensions.list()
session.rpc.extensions.enable({ name })
session.rpc.extensions.disable({ name })
session.rpc.extensions.reload()
```

### createSession API

```typescript
async createSession(config: SessionConfig): Promise<CopilotSession>
```

`SessionConfig`:
```typescript
interface SessionConfig {
  sessionId?: string;
  clientName?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  configDir?: string;
  tools?: Tool<any>[];
  commands?: CommandDefinition[];
  systemMessage?: SystemMessageConfig;
  availableTools?: string[];
  excludedTools?: string[];
  provider?: ProviderConfig;
  onPermissionRequest: PermissionHandler;   // REQUIRED
  onUserInputRequest?: UserInputHandler;
  hooks?: SessionHooks;
  workingDirectory?: string;
  streaming?: boolean;
  mcpServers?: Record<string, MCPServerConfig>;
  customAgents?: CustomAgentConfig[];
  agent?: string;
  skillDirectories?: string[];
  disabledSkills?: string[];
  infiniteSessions?: InfiniteSessionConfig;
  onEvent?: SessionEventHandler;
}
```

### resumeSession API

```typescript
async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>
```

`ResumeSessionConfig` is a `Pick` of `SessionConfig` with the same fields except `sessionId`, plus:
```typescript
disableResume?: boolean;  // skip emitting session.resume event (default: false)
```

When resuming, the session's conversation history is preserved. New tools, system message, model, etc. can be provided to override the original config. The CLI receives all new config via the `session.resume` RPC.

---

## Subagent / Custom Agent Control

### Custom Agents (subagents)

The SDK supports **custom agents** -- these are defined in `SessionConfig.customAgents` and are the "subagent" mechanism. They are NOT a tool that you call; they are agent personas managed by the CLI runtime.

```typescript
interface CustomAgentConfig {
  name: string;                              // unique identifier
  displayName?: string;                      // UI label
  description?: string;                      // what the agent does
  tools?: string[] | null;                   // allowed tools (null = all)
  prompt: string;                            // system prompt for the agent
  mcpServers?: Record<string, MCPServerConfig>; // agent-specific MCP servers
  infer?: boolean;                           // available for model inference (default: true)
}
```

### Runtime agent management (session.rpc.agent)

```typescript
session.rpc.agent.list()       // -> { agents: [{name, displayName, description}] }
session.rpc.agent.getCurrent() // -> { agent: {name, displayName, description} | null }
session.rpc.agent.select({ name })  // -> { agent: {name, displayName, description} }
session.rpc.agent.deselect()   // -> {}
session.rpc.agent.reload()     // -> { agents: [...] }
```

### Subagent events (emitted by CLI runtime)

The CLI runtime autonomously spawns subagents as tool calls. The SDK observes them via session events:

```
subagent.started     -> { toolCallId, agentName, agentDisplayName, agentDescription }
subagent.completed   -> { toolCallId, agentName, agentDisplayName, model?, totalToolCalls?, totalTokens?, durationMs? }
subagent.failed      -> { toolCallId, agentName, agentDisplayName, error, model?, totalToolCalls?, totalTokens?, durationMs? }
subagent.selected    -> { agentName, agentDisplayName, tools: string[] | null }
subagent.deselected  -> {}
```

### There is no `runSubagent` tool in the SDK

The SDK does not expose a `runSubagent` tool or method. Subagents are an internal mechanism of the Copilot CLI runtime -- the runtime decides when to spawn a subagent based on the `customAgents` config and the `infer` flag. You cannot programmatically invoke a subagent from the SDK side; you can only `select` a custom agent to make it the active agent for subsequent messages, or the CLI may spawn one internally as a tool call.

### Model per subagent

You cannot specify the model for a custom agent in `CustomAgentConfig` -- there is no `model` field. The subagent uses whatever model the session is configured with. However, `subagent.completed` events report which `model` was used.

### Can a subagent spawn another subagent?

The SDK does not prevent this conceptually. Since subagents are spawned by the CLI runtime as tool invocations, and custom agents can have access to tools, whether nesting occurs depends on the CLI runtime's internal behavior. The SDK provides no control or configuration for this.

### Fleet mode

There is an experimental `session.rpc.fleet.start({ prompt? })` RPC. Its interface is minimal:

```typescript
interface SessionFleetStartParams {
  sessionId: string;
  prompt?: string;  // optional user prompt combined with fleet instructions
}
interface SessionFleetStartResult {
  started: boolean;
}
```

This appears to be a parallel execution mode, but the SDK surface is very thin -- it only has a `start` method.

---

## Context Compaction

### Automatic compaction (Infinite Sessions)

Compaction is handled automatically via the `infiniteSessions` config:

```typescript
interface InfiniteSessionConfig {
  enabled?: boolean;                          // default: true
  backgroundCompactionThreshold?: number;     // 0.0-1.0, default: 0.80
  bufferExhaustionThreshold?: number;         // 0.0-1.0, default: 0.95
}
```

When context utilization reaches `backgroundCompactionThreshold`, the CLI starts an async LLM-powered compaction. When it reaches `bufferExhaustionThreshold`, the session blocks until compaction completes.

### Manual compaction

```typescript
const result = await session.rpc.compaction.compact();
// Returns: { success: boolean, tokensRemoved: number, messagesRemoved: number }
```

This is marked `@experimental`.

### What happens during compaction

Compaction events provide details:

**`session.compaction_start`** data:
- `systemTokens` -- token count from system messages
- `messageTokens` -- token count from non-system messages
- `toolDefinitionTokens` -- token count from tool definitions

**`session.compaction_complete`** data:
- `success: boolean`
- `error?: string`
- `preCompactionTokens`, `postCompactionTokens`
- `preCompactionMessagesLength`, `messagesRemoved`, `tokensRemoved`
- `summary?: string` -- LLM-generated summary of compacted history
- `compactionTokensUsed` -- { inputTokens, outputTokens, cachedTokens }
- `postCompactionSystemTokens`, `postCompactionMessageTokens`, `postCompactionToolDefinitionTokens`

After compaction, the system prompt and tool definitions remain. Older conversation messages are replaced by an LLM-generated summary.

---

## Dynamic Context Modification

### System message transform callbacks

Beyond the static `append`/`replace`/`remove`/`prepend` actions, you can register **transform callbacks** that run dynamically:

```typescript
systemMessage: {
  mode: "customize",
  sections: {
    guidelines: {
      action: (currentContent: string) => {
        // Dynamically transform the section content
        return currentContent + "\n* Additional dynamic rule";
      }
    }
  }
}
```

These callbacks are invoked by the CLI via the `systemMessage.transform` RPC whenever the system message is being assembled.

### Session log injection

```typescript
await session.log("Processing started");
await session.log("Disk usage high", { level: "warning" });
await session.log("Debug info", { ephemeral: true });
```

Log messages appear in the session event stream. Non-ephemeral logs are persisted to the session event log on disk.

### Attachments on each message

Each `send()` / `sendAndWait()` call can include attachments:

```typescript
await session.send({
  prompt: "Analyze this",
  attachments: [
    { type: "file", path: "./src/index.ts", displayName?: string },
    { type: "directory", path: "./src" },
    { type: "selection", filePath, displayName, selection?, text? },
    { type: "blob", data: "base64...", mimeType: "image/png" },
  ]
});
```

### Model switching mid-session

```typescript
await session.setModel("gpt-4.1");
await session.setModel("claude-sonnet-4.6", { reasoningEffort: "high" });
```

### Mode switching

```typescript
const { mode } = await session.rpc.mode.get();      // "interactive" | "plan" | "autopilot"
await session.rpc.mode.set({ mode: "plan" });
```

### Plan management

```typescript
await session.rpc.plan.read();
await session.rpc.plan.update({ content: "..." });
await session.rpc.plan.delete();
```

### Workspace file management

```typescript
await session.rpc.workspace.listFiles();
await session.rpc.workspace.readFile({ path: "..." });
await session.rpc.workspace.createFile({ path: "...", content: "..." });
```

---

## Authentication

### Authentication methods

**Option: Direct token**
```typescript
const client = new CopilotClient({ githubToken: "ghp_..." });
```
When provided, the token is passed to the CLI via environment variable `COPILOT_SDK_AUTH_TOKEN` and the CLI flag `--auth-token-env COPILOT_SDK_AUTH_TOKEN`. This takes priority over other auth methods.

**Option: Logged-in user** (default)
```typescript
const client = new CopilotClient({ useLoggedInUser: true }); // default when no githubToken
```
Uses stored OAuth tokens or `gh` CLI auth.

**Option: Custom provider (BYOK)**
```typescript
const client = new CopilotClient();
const session = await client.createSession({
  model: "gpt-4",
  provider: {
    type: "openai" | "azure" | "anthropic",
    baseUrl: "https://...",
    apiKey?: "...",
    bearerToken?: "...",      // takes precedence over apiKey
    wireApi?: "completions" | "responses",
    azure?: { apiVersion?: "2024-10-21" }
  }
});
```

### Constraints

- `githubToken` and `useLoggedInUser` cannot be used with `cliUrl` (external server manages its own auth).
- When `githubToken` is provided, `useLoggedInUser` defaults to `false`.
- Auth status can be queried: `await client.getAuthStatus()` returns `{ isAuthenticated, authType, host, login, statusMessage }`.
- `authType` values: `"user" | "env" | "gh-cli" | "hmac" | "api-key" | "token"`.

### Multiple auth credentials

There is no built-in mechanism to switch credentials mid-session. The `githubToken` is set at `CopilotClient` construction time. To use different credentials, create separate `CopilotClient` instances.

For per-session BYOK, pass `provider` in `SessionConfig` -- each session can use a different provider/key.

---

## Dependencies

### What the SDK depends on

- **`@github/copilot` ^1.0.10** -- the Copilot CLI binary. The SDK spawns it as a child process (using `--headless --no-auto-update --stdio` flags).
- **`vscode-jsonrpc` ^8.2.1** -- JSON-RPC transport layer for communication with the CLI.
- **`zod` ^4.3.6** -- for schema validation with `defineTool`.

### What needs to be installed

- Node.js >= 20.0.0
- `@github/copilot-sdk` (installs `@github/copilot` as transitive dependency)
- GitHub authentication (one of: `githubToken`, `gh` CLI login, environment variables)

The SDK does NOT require VS Code. It works standalone as a Node.js library.

### Connection modes

- **stdio** (default): SDK spawns the CLI process, communicates via stdin/stdout pipes.
- **TCP**: SDK spawns CLI with `--port`, connects via TCP socket.
- **External server**: SDK connects to a pre-existing CLI server via `cliUrl` (no process spawning).
- **Child process** (`isChildProcess: true`): SDK runs as a child of the CLI and uses its own stdio for bidirectional communication. Used by the `joinSession()` extension API.

---

## Hook System

```typescript
interface SessionHooks {
  onPreToolUse?: PreToolUseHandler;
  onPostToolUse?: PostToolUseHandler;
  onUserPromptSubmitted?: UserPromptSubmittedHandler;
  onSessionStart?: SessionStartHandler;
  onSessionEnd?: SessionEndHandler;
  onErrorOccurred?: ErrorOccurredHandler;
}
```

### preToolUse

```typescript
(input: { timestamp, cwd, toolName, toolArgs }, invocation: { sessionId }) =>
  { permissionDecision?, permissionDecisionReason?, modifiedArgs?, additionalContext?, suppressOutput? }
```

Can intercept and modify tool arguments, override permission decisions, or inject additional context.

### postToolUse

```typescript
(input: { timestamp, cwd, toolName, toolArgs, toolResult: ToolResultObject }, invocation) =>
  { modifiedResult?, additionalContext?, suppressOutput? }
```

Can modify tool results after execution.

### userPromptSubmitted

```typescript
(input: { timestamp, cwd, prompt }, invocation) =>
  { modifiedPrompt?, additionalContext?, suppressOutput? }
```

Can rewrite user prompts before they reach the model.

### sessionStart

```typescript
(input: { timestamp, cwd, source: "startup" | "resume" | "new", initialPrompt? }, invocation) =>
  { additionalContext?, modifiedConfig? }
```

### sessionEnd

```typescript
(input: { timestamp, cwd, reason: "complete" | "error" | "abort" | "timeout" | "user_exit", finalMessage?, error? }, invocation) =>
  { suppressOutput?, cleanupActions?, sessionSummary? }
```

### errorOccurred

```typescript
(input: { timestamp, cwd, error, errorContext: "model_call" | "tool_execution" | "system" | "user_input", recoverable }, invocation) =>
  { suppressOutput?, errorHandling?: "retry" | "skip" | "abort", retryCount?, userNotification? }
```

---

## Tool Definition

```typescript
interface Tool<TArgs = unknown> {
  name: string;
  description?: string;
  parameters?: ZodSchema<TArgs> | Record<string, unknown>;  // Zod schema or raw JSON Schema
  handler: ToolHandler<TArgs>;
  overridesBuiltInTool?: boolean;   // explicitly override a built-in tool of same name
  skipPermission?: boolean;         // execute without permission prompt
}

// Type-safe helper
const myTool = defineTool("get_weather", {
  description: "Get weather for a location",
  parameters: z.object({ location: z.string() }),
  handler: async (args) => ({ temperature: 72 }),
});
```

The `ToolHandler` signature:
```typescript
type ToolHandler<TArgs> = (
  args: TArgs,
  invocation: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    arguments: unknown;
    traceparent?: string;
    tracestate?: string;
  }
) => Promise<unknown> | unknown;
```

Return value can be: `string`, `ToolResultObject`, any JSON-serializable object, or `null`/`undefined`.

---

## Extension API

For child-process extensions that join an existing CLI session:

```typescript
import { joinSession } from "@github/copilot-sdk/extension";

const session = await joinSession({
  tools: [myTool],
  onPermissionRequest: myHandler,
});
```

Uses `isChildProcess: true` internally, reads `SESSION_ID` from env.

---

## Session-scoped RPC namespace summary

All accessible via `session.rpc.*`:

| Namespace | Methods |
|---|---|
| `model` | `getCurrent()`, `switchTo({ modelId, reasoningEffort? })` |
| `mode` | `get()`, `set({ mode })` |
| `plan` | `read()`, `update({ content })`, `delete()` |
| `workspace` | `listFiles()`, `readFile({ path })`, `createFile({ path, content })` |
| `fleet` | `start({ prompt? })` |
| `agent` | `list()`, `getCurrent()`, `select({ name })`, `deselect()`, `reload()` |
| `skills` | `list()`, `enable({ name })`, `disable({ name })`, `reload()` |
| `mcp` | `list()`, `enable({ serverName, config })`, `disable({ serverName })`, `reload()` |
| `plugins` | `list()` |
| `extensions` | `list()`, `enable({ name })`, `disable({ name })`, `reload()` |
| `compaction` | `compact()` |
| `tools` | `handlePendingToolCall(...)` (internal) |
| `commands` | `handlePendingCommand(...)` (internal) |
| `ui` | `elicitation(...)` |
| `permissions` | `handlePendingPermissionRequest(...)` (internal) |
| `log` | `log({ message, level?, ephemeral? })` |
| `shell` | `exec({ command, ... })`, `kill({ processId, signal? })` |

Server-scoped (via `client.rpc.*`):
| Namespace | Methods |
|---|---|
| `ping` | `ping({ message? })` |
| `models` | `list()` |
| `tools` | `list({ sessionId })` |
| `account` | `getQuota()` |

---

## Event Types (session events)

Key event types from the session event union:

- `session.start`, `session.idle`, `session.error`, `session.end`
- `session.compaction_start`, `session.compaction_complete`
- `assistant.message`, `assistant.message_delta`, `assistant.reasoning_delta`
- `user.message`
- `tool.execute`, `tool.result`
- `external_tool.requested`
- `permission.requested`
- `command.execute`
- `subagent.started`, `subagent.completed`, `subagent.failed`, `subagent.selected`, `subagent.deselected`
- `hook.start`, `hook.complete`
- `model.switched`
- `session.usage_info` (ephemeral) — コンテキストウィンドウ使用状況: `tokenLimit`, `currentTokens`, `messagesLength`, `systemTokens?`, `conversationTokens?`, `toolDefinitionsTokens?`, `isInitial?`
- `session.shutdown` — 最終トークンスナップショット: `currentTokens?`, `systemTokens?`, `conversationTokens?`, `toolDefinitionsTokens?`
- `assistant.usage` (ephemeral) — LLM API コールごとの使用量メトリクス（下記参照）

### assistant.usage イベント詳細

LLM API コールが完了するたびに発火する ephemeral イベント。累計消費トークン数の積算、リアルタイムのプレミアムリクエスト残量追跡、API コールごとのコスト追跡に利用可能。

| フィールド | 型 | 意味 |
| :--- | :--- | :--- |
| `model` | `string` | 使用されたモデル |
| `inputTokens?` | `number` | 入力トークン数 |
| `outputTokens?` | `number` | 出力トークン数 |
| `cacheReadTokens?` | `number` | キャッシュから読み取ったトークン数 |
| `cacheWriteTokens?` | `number` | キャッシュに書き込んだトークン数 |
| `cost?` | `number` | billing multiplier コスト |
| `duration?` | `number` | API コール時間（ms） |
| `initiator?` | `string` | 呼び出し元（例: `"sub-agent"`。ユーザー起因の場合は absent） |
| `parentToolCallId?` | `string` | subagent からの呼び出しの場合、親ツールコール ID |
| `quotaSnapshots?` | `Record<string, QuotaSnapshot>` | クオータごとのリアルタイムスナップショット |
| `copilotUsage?` | `{ tokenDetails, totalNanoAiu }` | 従量課金の詳細（nano-AIU 単位） |

QuotaSnapshot:

| フィールド | 型 | 意味 |
| :--- | :--- | :--- |
| `isUnlimitedEntitlement` | `boolean` | 無制限プランか |
| `entitlementRequests` | `number` | 上限リクエスト数 |
| `usedRequests` | `number` | 消費済みリクエスト数 |
| `remainingPercentage` | `number` | 残量割合 (0.0〜1.0) |
| `overage` | `number` | 超過リクエスト数 |
| `resetDate?` | `string` | リセット日時 |

copilotclaw での活用:
- `inputTokens` + `outputTokens` を積算 → 累計消費トークン数
- `quotaSnapshots` → `/api/quota` の IPC 往復なしでリアルタイムのプレミアムリクエスト残量を取得可能
- `cost` → API コールごとのコスト追跡
- `parentToolCallId` → subagent のコスト分離
