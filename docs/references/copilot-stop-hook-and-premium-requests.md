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

## Copilot SDK: No Stop Hook Block Available

The SDK provides 6 hooks: `onSessionStart`, `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, `onSessionEnd`, `onErrorOccurred`.

- None of these hooks can block a stop
- `onSessionEnd` is notification-only (`suppressOutput`, `cleanupActions`, `sessionSummary`)
- No API to mark a request as user-initiated or non-premium
- Premium request accounting is automatic and not controllable via hooks

## Current copilotclaw Behavior

The current implementation uses `session.send({ prompt: continuePrompt, mode: "enqueue" })` on every idle event to keep the agent alive. Each `session.send()` consumes a premium request.

## Future Improvement Candidates

### disconnect/resumeSession Pattern

- On idle: `session.disconnect()` (saves session state to disk, no premium cost)
- Agent process polls gateway for new input
- On input: `client.resumeSession(sessionId)` (loads state from disk, no premium cost) + `session.send()` (premium cost)
- Premium requests consumed only when actual user input arrives

### Trade-offs

- `disconnect/resumeSession` adds latency (disk I/O, session reconstruction)
- Current tool-handler polling has lower latency but consumes premium requests on every idle cycle
- `resumeSession()` itself does NOT consume premium requests (confirmed in SDK source)
