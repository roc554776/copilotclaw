# Copilot SDK: LLM Context Construction and Message Retrieval

SDK: `@github/copilot-sdk` ^0.2.0
Source: `https://github.com/github/copilot-sdk.git`
Authoritative event types: `nodejs/src/generated/session-events.ts`

This document covers how the Copilot CLI constructs the LLM context, how to retrieve conversation history, and what real-time visibility the SDK provides into the context window.

---

## Architecture: SDK declares, CLI constructs

The SDK does NOT directly construct the LLM API request. It declares intent to the Copilot CLI server via `session.create` JSON-RPC, and the CLI assembles the actual request (system prompt, tool definitions, conversation history) for the LLM provider.

```
SDK Client  →  session.create (tools, systemMessage, model, mcpServers, ...)  →  Copilot CLI
Copilot CLI →  Builds LLM Request (system prompt sections + tool defs + conversation history)  →  LLM API
Copilot CLI →  session.event stream (assistant.message, session.usage_info, ...)  →  SDK Client
```

The SDK's role is **configuration and event observation**, not request construction.

---

## System Prompt Construction

The CLI manages a structured system prompt divided into named sections. The SDK controls it via the `systemMessage` field in `SessionConfig`.

### System Prompt Sections

The system prompt consists of sections, each identified by a well-known ID:

| Section ID | Purpose |
|---|---|
| `identity` | Agent identity preamble and mode statement |
| `tone` | Response style, conciseness rules, output formatting preferences |
| `tool_efficiency` | Tool usage patterns, parallel calling, batching guidelines |
| `environment_context` | CWD, OS, git root, directory listing, **available tools** |
| `code_change_rules` | Coding rules, linting/testing, ecosystem tools, style |
| `guidelines` | Tips, behavioral best practices, behavioral guidelines |
| `safety` | Environment limitations, prohibited actions, security policies |
| `tool_instructions` | Per-tool usage instructions |
| `custom_instructions` | Repository and organization custom instructions |
| `last_instructions` | End-of-prompt instructions: parallel tool calling, persistence, task completion |

Source: `nodejs/src/types.ts` — `SystemPromptSection` type and `SYSTEM_PROMPT_SECTIONS` constant.

The `environment_context` section is where the CLI automatically injects runtime context (CWD, OS, git root, directory listing, available tool names), making tool discovery part of the system prompt itself.

### Three Configuration Modes

**Append** (default): SDK-managed foundation prompt + optional caller-appended content.
```typescript
systemMessage: { mode: "append", content: "Additional instructions..." }
```

**Replace**: Caller supplies the entire system message. All SDK guardrails including security restrictions are removed.
```typescript
systemMessage: { mode: "replace", content: "Complete system prompt..." }
```

**Customize**: Section-level overrides while keeping the SDK-managed structure.
```typescript
systemMessage: {
  mode: "customize",
  sections: {
    guidelines: { action: "append", content: "Extra guideline" },
    safety: { action: "remove" },
    tone: { action: (currentContent) => currentContent + "\nBe concise." },
  },
  content: "Additional content appended after all sections",
}
```

Available actions: `"replace"`, `"remove"`, `"append"`, `"prepend"`, or a transform callback `(currentContent: string) => string | Promise<string>`.

Unknown section IDs gracefully fall back: content-bearing overrides are appended to additional instructions, and `"remove"` on unknown sections is a silent no-op.

### Dynamic Section Transforms

When the customize mode uses a **callback function** as an action, the SDK extracts those callbacks before sending the payload to the CLI. The callable is replaced with the string `"transform"` on the wire. When the CLI needs the system prompt, it calls back via `systemMessage.transform` JSON-RPC, and the SDK invokes the registered callback.

Source: `nodejs/src/client.ts` — `extractTransformCallbacks()`.

---

## Tool Definitions Sent to the LLM

Each tool definition sent in `session.create` has:

```typescript
{
  name: string;                    // tool name
  description?: string;            // shown verbatim to the LLM
  parameters?: JsonSchema;         // JSON Schema of the tool's parameters
  overridesBuiltInTool?: boolean;  // explicitly override a built-in tool
  skipPermission?: boolean;        // execute without permission prompt
}
```

The `handler` field exists only locally for execution — it is never sent over the wire.

When using Zod schemas in `parameters`, the SDK converts them to JSON Schema via `toJsonSchema()` before sending.

### Tool Filtering

Callers can filter which built-in tools are available to the LLM:
- `availableTools: string[]` — allowlist (takes precedence over excludedTools)
- `excludedTools: string[]` — denylist

---

## Conversation History Retrieval

### `session.getMessages()` — Full History Snapshot

```typescript
const events: SessionEvent[] = await session.getMessages();
```

Returns the **complete** session event history in chronological order. Includes: user messages, assistant responses, tool executions, system messages, and all other persisted events.

The RPC payload is:
```json
{ "sessionId": "..." }
```

**No cursor/pagination support**: There is no `afterEventId`, `since`, or other cursor parameter. The API always returns all events. This is a limitation across all SDK languages (Node.js, Python, Go, .NET).

### Client-Side Filtering Pattern

Since there is no server-side delta API, the recommended pattern is to retrieve all events and filter client-side. The Go test harness demonstrates this pattern:

```go
// Get all messages, then slice from the last user.message onward
messages, _ := session.GetMessages(ctx)
finalUserMessageIndex := -1
for i := len(messages) - 1; i >= 0; i-- {
    if messages[i].Type == "user.message" {
        finalUserMessageIndex = i
        break
    }
}
currentTurnMessages := messages[finalUserMessageIndex:]
```

Source: `go/internal/e2e/testharness/helper.go`.

### Real-Time Delta: Event Subscription

For real-time updates during a turn, subscribe to the event stream instead of polling `getMessages()`:

```typescript
// All events
const unsubscribe = session.on((event) => { ... });

// Specific event type (with type narrowing)
const unsubscribe = session.on("assistant.message_delta", (event) => {
    process.stdout.write(event.data.deltaContent);
});
```

---

## Real-Time Context Window Visibility

### `session.usage_info` Event (ephemeral)

Emitted by the CLI to expose live context window metrics. Directly reflects what the LLM "sees" in terms of token distribution.

| Field | Type | Required | Description |
|---|---|---|---|
| `tokenLimit` | `number` | yes | Maximum token count for the model's context window |
| `currentTokens` | `number` | yes | Total tokens currently in context window |
| `messagesLength` | `number` | yes | Number of conversation messages |
| `systemTokens` | `number` | no | Tokens consumed by system message(s) |
| `conversationTokens` | `number` | no | Tokens from user/assistant/tool messages |
| `toolDefinitionsTokens` | `number` | no | Tokens consumed by all tool definitions |
| `isInitial` | `boolean` | no | Whether this is the first usage_info event in the session |

### `assistant.usage` Event (ephemeral)

Emitted per LLM API call with token consumption, cost, and quota information.

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | `string` | yes | Model identifier used |
| `inputTokens` | `number` | no | Input tokens consumed |
| `outputTokens` | `number` | no | Output tokens produced |
| `cacheReadTokens` | `number` | no | Tokens read from prompt cache |
| `cacheWriteTokens` | `number` | no | Tokens written to prompt cache |
| `cost` | `number` | no | Model multiplier cost for billing |
| `duration` | `number` | no | API call duration in milliseconds |
| `initiator` | `string` | no | What initiated this call (e.g., "sub-agent"); absent for user-initiated |
| `apiCallId` | `string` | no | Completion ID from provider (e.g., chatcmpl-abc123) |
| `providerCallId` | `string` | no | GitHub request tracing ID (x-github-request-id) |
| `parentToolCallId` | `string` | no | Parent tool call ID when from a sub-agent |
| `reasoningEffort` | `string` | no | Reasoning effort level used |
| `quotaSnapshots` | `object` | no | Per-quota usage snapshots (see below) |
| `copilotUsage` | `object` | no | Per-request cost data from CAPI |

**`quotaSnapshots`** — keyed by quota identifier:

| Field | Type | Description |
|---|---|---|
| `isUnlimitedEntitlement` | `boolean` | Whether user has unlimited usage |
| `entitlementRequests` | `number` | Total requests allowed |
| `usedRequests` | `number` | Requests already consumed |
| `usageAllowedWithExhaustedQuota` | `boolean` | Whether usage continues after quota exhaustion |
| `overage` | `number` | Requests over the limit |
| `overageAllowedWithExhaustedQuota` | `boolean` | Whether overage is allowed |
| `remainingPercentage` | `number` | Quota remaining (0.0 to 1.0) |
| `resetDate` | `string` | Date when quota resets |

**`copilotUsage`** — per-request cost data:

| Field | Type | Description |
|---|---|---|
| `tokenDetails` | `array` | Itemized token usage: `{ batchSize, costPerBatch, tokenCount, tokenType }` |
| `totalNanoAiu` | `number` | Total cost in nano-AIU (AI Units) |

### `session.context_changed` Event

Emitted when the session's working directory or repository context changes.

| Field | Type | Required | Description |
|---|---|---|---|
| `cwd` | `string` | yes | Current working directory path |
| `gitRoot` | `string` | no | Git repository root |
| `repository` | `string` | no | Repository in "owner/name" format |
| `hostType` | `"github" \| "ado"` | no | Hosting platform type |
| `branch` | `string` | no | Current git branch name |

---

## Session Metadata (Static Context)

### `SessionContext` — Working Directory Context

```typescript
interface SessionContext {
  cwd: string;           // Working directory where session was created
  gitRoot?: string;      // Git repository root
  repository?: string;   // "owner/repo" format
  branch?: string;       // Current git branch
}
```

### `SessionMetadata` — Session Summary

```typescript
interface SessionMetadata {
  sessionId: string;
  startTime: Date;
  modifiedTime: Date;
  summary?: string;
  isRemote: boolean;
  context?: SessionContext;
}
```

### `listSessions` — Query Sessions

```typescript
const sessions: SessionMetadata[] = await client.listSessions(filter?);
```

Filter options (`SessionListFilter`):
- `cwd?: string` — exact match
- `gitRoot?: string`
- `repository?: string`
- `branch?: string`

---

## Session Shutdown Metrics

The `session.shutdown` event provides comprehensive session-end metrics:

| Field | Type | Description |
|---|---|---|
| `shutdownType` | `"routine" \| "error"` | Normal or crash shutdown |
| `errorReason` | `string` | Error description (when error) |
| `totalPremiumRequests` | `number` | Total premium API requests used |
| `totalApiDurationMs` | `number` | Cumulative API call time |
| `sessionStartTime` | `number` | Unix timestamp (ms) |
| `codeChanges` | `object` | `{ linesAdded, linesRemoved, filesModified: string[] }` |
| `modelMetrics` | `object` | Per-model breakdown: `{ requests: { count, cost }, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }` |
| `currentModel` | `string` | Model at shutdown |
| `currentTokens` | `number` | Context window tokens at shutdown |
| `systemTokens` | `number` | System message tokens at shutdown |
| `conversationTokens` | `number` | Non-system message tokens at shutdown |
| `toolDefinitionsTokens` | `number` | Tool definitions tokens at shutdown |

---

## Attachments as Context

User messages can include attachments that expand the LLM's visible context:

| Type | Fields | Description |
|---|---|---|
| `file` | `path, displayName?` | Single file content |
| `directory` | `path, displayName` | Directory listing |
| `selection` | `filePath, displayName, selection?, text?` | Text selection from a file |
| `blob` | `data (base64), mimeType, displayName?` | Inline binary content (images, etc.) |
| `github_reference` | `number, url, ...` | GitHub issue/PR reference (in getMessages response) |

Attachments are sent with each `session.send()` call:

```typescript
await session.send({
  prompt: "Analyze this file",
  attachments: [
    { type: "file", path: "/absolute/path/to/file.ts" },
    { type: "blob", data: "base64...", mimeType: "image/png" },
  ]
});
```

---

## Complete Session Event Type Reference

All event types defined in `nodejs/src/generated/session-events.ts`:

### Session Lifecycle
| Event | Ephemeral | Description |
|---|---|---|
| `session.start` | no | Session initialization with context and config |
| `session.resume` | no | Session resumed from previous state |
| `session.error` | no | Session-level error |
| `session.idle` | **yes** | Session waiting for input (turn completed) |
| `session.title_changed` | no | Session title updated |
| `session.info` | no | Informational message |
| `session.warning` | no | Warning message |
| `session.model_change` | no | Model changed mid-session |
| `session.mode_changed` | no | Mode changed (interactive/plan/autopilot) |
| `session.plan_changed` | no | Plan content updated |
| `session.workspace_file_changed` | no | Workspace file modified |
| `session.handoff` | no | Session handed off |
| `session.truncation` | no | Context truncated |
| `session.snapshot_rewind` | no | Snapshot rewound |
| `session.shutdown` | no | Session terminated with metrics |
| `session.context_changed` | no | CWD/git context changed |
| `session.usage_info` | **yes** | Context window token metrics |
| `session.compaction_start` | no | Compaction started |
| `session.compaction_complete` | no | Compaction finished with metrics |
| `session.task_complete` | no | Background task completed |

### User
| Event | Ephemeral | Description |
|---|---|---|
| `user.message` | no | User's input with attachments |
| `pending_messages.modified` | no | Pending message queue changed |

### Assistant
| Event | Ephemeral | Description |
|---|---|---|
| `assistant.turn_start` | no | Assistant turn begins |
| `assistant.intent` | **yes** | Intent classification |
| `assistant.reasoning` | no | Complete reasoning content |
| `assistant.reasoning_delta` | **yes** | Streaming reasoning chunk |
| `assistant.streaming_delta` | **yes** | Streaming text chunk |
| `assistant.message` | no | Complete assistant response (may include toolRequests) |
| `assistant.message_delta` | **yes** | Streaming message chunk |
| `assistant.turn_end` | no | Assistant turn ends |
| `assistant.usage` | **yes** | Per-API-call token/cost metrics |

### Tool Execution
| Event | Ephemeral | Description |
|---|---|---|
| `tool.user_requested` | no | User explicitly requested a tool |
| `tool.execution_start` | no | Tool execution begins |
| `tool.execution_partial_result` | **yes** | Intermediate result during execution |
| `tool.execution_progress` | **yes** | Progress update during execution |
| `tool.execution_complete` | no | Tool execution finished with result |

### Skill
| Event | Ephemeral | Description |
|---|---|---|
| `skill.invoked` | no | Skill context injected (content, allowedTools) |

### Sub-Agent
| Event | Ephemeral | Description |
|---|---|---|
| `subagent.started` | no | Sub-agent spawned |
| `subagent.completed` | no | Sub-agent finished |
| `subagent.failed` | no | Sub-agent failed |
| `subagent.selected` | no | Agent selected as active |
| `subagent.deselected` | no | Agent deselected |

### Hook
| Event | Ephemeral | Description |
|---|---|---|
| `hook.start` | **yes** | Hook execution started |
| `hook.end` | **yes** | Hook execution ended |

### System
| Event | Ephemeral | Description |
|---|---|---|
| `system.message` | no | System/developer prompt in timeline |
| `system.notification` | no | System notification (agent_completed, agent_idle, shell_completed, shell_detached_completed) |

### Permission & User Input
| Event | Ephemeral | Description |
|---|---|---|
| `permission.requested` | **yes** | Permission prompt for tool execution |
| `permission.completed` | **yes** | Permission decision |
| `user_input.requested` | **yes** | User input prompt (ask_user tool) |
| `user_input.completed` | **yes** | User input response |
| `elicitation.requested` | **yes** | Structured user input prompt |
| `elicitation.completed` | **yes** | Structured user input response |

### MCP
| Event | Ephemeral | Description |
|---|---|---|
| `mcp.oauth_required` | **yes** | MCP server needs OAuth |
| `mcp.oauth_completed` | **yes** | MCP OAuth completed |

### External Tool
| Event | Ephemeral | Description |
|---|---|---|
| `external_tool.requested` | **yes** | External tool invocation |
| `external_tool.completed` | **yes** | External tool result |

### Command
| Event | Ephemeral | Description |
|---|---|---|
| `command.queued` | **yes** | Command queued |
| `command.execute` | **yes** | Command executing |
| `command.completed` | no | Command finished |
| `commands.changed` | **yes** | Available commands updated |

### Plan Mode
| Event | Ephemeral | Description |
|---|---|---|
| `exit_plan_mode.requested` | **yes** | Exit plan mode requested |
| `exit_plan_mode.completed` | **yes** | Exit plan mode completed |

### Session Management
| Event | Ephemeral | Description |
|---|---|---|
| `session.tools_updated` | **yes** | Tool definitions updated |
| `session.background_tasks_changed` | **yes** | Background task state changed |
| `session.skills_loaded` | no | Skills loaded |
| `session.custom_agents_updated` | **yes** | Custom agents updated |
| `session.mcp_servers_loaded` | no | MCP servers loaded |
| `session.mcp_server_status_changed` | **yes** | MCP server status changed |
| `session.extensions_loaded` | no | Extensions loaded |

### Control
| Event | Ephemeral | Description |
|---|---|---|
| `abort` | no | Turn aborted with reason |

---

## Typical Turn Flow

```
assistant.turn_start
├── assistant.intent (ephemeral)
├── assistant.reasoning_delta (ephemeral, repeated)
├── assistant.reasoning
├── assistant.message_delta (ephemeral, repeated)
├── assistant.message (may include toolRequests)
├── assistant.usage (ephemeral)
├── [If tools requested:]
│   ├── permission.requested (ephemeral)
│   ├── permission.completed (ephemeral)
│   ├── tool.execution_start
│   ├── tool.execution_partial_result (ephemeral, repeated)
│   ├── tool.execution_progress (ephemeral, repeated)
│   ├── tool.execution_complete
│   └── [Agent loops: more reasoning → message → tool calls...]
assistant.turn_end
session.idle (ephemeral)
```

---

## Key Distinctions

- **`SessionContext` (cwd/gitRoot/repository/branch)** and **session event history (`getMessages()`)** are separate concepts. The former is session metadata; the latter is the conversation log.

- **Server-side delta retrieval does not exist**. There is no `afterEventId` or `since` cursor. Use `getMessages()` for full history + client-side filtering, or `session.on()` for real-time streaming.

- **`system.message` events** in the timeline show the actual system prompt content (distinguishing `"system"` vs `"developer"` roles), but these are diagnostic — the `systemMessage` config in `session.create` is the input, `system.message` events are the output.

- **`assistant.message_delta` events** are streaming chunks of the LLM response (ephemeral). They are NOT "conversation history deltas."

- **Ephemeral events** are transient — they are NOT persisted to disk and are NOT replayed on session resume. They exist only during the live event stream.
