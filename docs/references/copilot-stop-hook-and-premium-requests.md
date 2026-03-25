# Copilot Stop Hook and Premium Requests

Investigation into how VSCode Copilot Chat handles stop blocking and premium request avoidance, and whether this is available in the Copilot SDK.

## VSCode Copilot Chat: Stop Hook Block (Internal Implementation)

VSCode Copilot Chat supports a Stop hook that can block the agent from stopping:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "decision": "block",
    "reason": "Run the test suite before finishing"
  }
}
```

### How it works

```
Agent attempts to stop
  → Stop hook fires
  → Hook returns { decision: "block", reason: "..." }
  → Reason is formatted and injected as next LLM prompt:
    "You were about to complete but a hook blocked you..."
  → Continuation is marked as stopHookUserInitiated = true
  → userInitiatedRequest: true → X-Initiator: user header
  → Premium request NOT consumed
```

### Key source files (microsoft/vscode-copilot-chat)

- `src/platform/chat/common/chatHookService.ts` — `StopHookOutput` interface with `decision: 'block'`
- `src/extension/intents/node/toolCallingLoop.ts` — `executeStopHook()`, `stopHookUserInitiated` flag, continuation logic

## GitHub Copilot CLI Hooks

The CLI reads hooks from `.github/hooks/hooks.json` in the working directory. Six event types are supported:

| Hook | Can block? | Notes |
|:---|:---|:---|
| `sessionStart` | No | Output ignored |
| `sessionEnd` | No | Output ignored |
| `userPromptSubmitted` | No | Output ignored |
| `preToolUse` | **Yes** | `permissionDecision`: `"allow"`, `"deny"`, `"ask"` |
| `postToolUse` | No | Output ignored |
| `errorOccurred` | No | Output ignored |

**Stop hook does NOT exist in CLI.** Requested in [github/copilot-cli#1157](https://github.com/github/copilot-cli/issues/1157), still open as of March 2026.

When using the SDK, the CLI subprocess still reads `.github/hooks/hooks.json` from the working directory.

## SDK-CLI Hooks Architecture

The SDK spawns the CLI as a child process and communicates via JSON-RPC (stdio or TCP).

- **SDK hooks** (`onPreToolUse`, `onPostToolUse`, etc.) are in-process callbacks registered via `createSession({ hooks })`. The SDK sends a boolean `hooks: true/false` flag to the CLI to indicate hooks are present.
- **CLI hooks** (`.github/hooks/hooks.json`) are shell commands executed by the CLI process directly.
- These are **two separate hook systems**. SDK hooks and CLI hooks coexist but do not interact.

## Copilot SDK: No Stop Hook Block Available

The SDK provides 6 hooks: `onSessionStart`, `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, `onSessionEnd`, `onErrorOccurred`.

- None of these hooks can block a stop
- `onSessionEnd` is notification-only (`suppressOutput`, `cleanupActions`, `sessionSummary`)
- No API to mark a request as user-initiated or non-premium
- Premium request accounting is automatic and not controllable via hooks

## Current copilotclaw Behavior

The current implementation uses `session.send({ prompt: continuePrompt, mode: "enqueue" })` on every idle event to keep the agent alive. Each `session.send()` consumes a premium request.

## resumeSession Behavior

`client.resumeSession(sessionId)` restores session state from disk and returns an idle session object. It does NOT automatically resume processing.

- `session.send()` is required to trigger new work after resume
- `session.idle` event does not fire automatically on resume
- In-memory queued items are lost on disconnect (queue is not persisted)

## Current Design and Future Considerations

The current implementation uses `session.send()` on every idle event, consuming a premium request each time. This is known to be suboptimal.

The disconnect/resumeSession pattern (disconnect on idle, resume + send on new input) would require a `session.send()` per user input, which is also not cost-effective.

Future improvement will require a fundamentally different approach. Both the current idle-loop pattern and the disconnect/resumeSession pattern have premium request cost issues that make them unsuitable as long-term solutions.

## Session Idle Timeout

The CLI enforces a 30-minute idle timeout on sessions. This is a built-in CLI behavior and cannot be configured.

```
Last activity → 25 min: timeout_warning event → 30 min: session destroyed
```

- **What gets destroyed:** In-memory session resources on the CLI side
- **What survives:** Session state on disk (conversation history, tool results, planning state, artifacts) — can be resumed via `client.resumeSession(sessionId)`
- **Current copilotclaw impact:** Tool handler polling keeps the session active (tool is executing), so this timeout does not apply. If switching to disconnect/resumeSession, the session would be disconnected before timeout applies.
