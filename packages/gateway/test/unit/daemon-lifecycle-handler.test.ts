/**
 * Tests for the daemon's onLifecycle handler logic.
 *
 * The handler lives inline in daemon.ts main(), so these tests replicate
 * its behavior to verify:
 *  - subagent stop (backgroundTasks present) returns "wait"
 *  - copilotclaw_wait active returns "wait"
 *  - true parent-agent idle returns "stop"
 *  - error always returns "stop" with clearCopilotSessionId
 */
import { describe, expect, it } from "vitest";

interface LifecycleRequest {
  event: "idle" | "error";
  sessionId: string;
}

interface LifecycleResponse {
  action: "stop" | "reinject" | "wait";
  clearCopilotSessionId?: boolean;
}

/** Replicates the daemon's onLifecycle handler logic. */
function handleLifecycle(
  request: LifecycleRequest,
  lastIdleHasBackgroundTasks: Map<string, boolean>,
  currentState: string | undefined,
): LifecycleResponse {
  if (request.event === "error") {
    return { action: "stop", clearCopilotSessionId: true };
  }

  if (lastIdleHasBackgroundTasks.get(request.sessionId) === true) {
    lastIdleHasBackgroundTasks.delete(request.sessionId);
    return { action: "wait" };
  }

  if (currentState === "tool:copilotclaw_wait") {
    return { action: "wait" };
  }

  return { action: "stop" };
}

describe("daemon onLifecycle — subagent idle vs parent idle", () => {
  it("returns stop on error event", () => {
    const bgMap = new Map<string, boolean>();
    const result = handleLifecycle({ event: "error", sessionId: "s1" }, bgMap, undefined);
    expect(result).toEqual({ action: "stop", clearCopilotSessionId: true });
  });

  it("returns stop on true parent-agent idle", () => {
    const bgMap = new Map<string, boolean>();
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, "idle");
    expect(result).toEqual({ action: "stop" });
  });

  it("returns wait when session.idle had backgroundTasks (subagent stop)", () => {
    const bgMap = new Map<string, boolean>([["s1", true]]);
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, "idle");
    expect(result).toEqual({ action: "wait" });
    // backgroundTasks flag should be cleared after use
    expect(bgMap.has("s1")).toBe(false);
  });

  it("returns wait when copilotclaw_wait is active", () => {
    const bgMap = new Map<string, boolean>();
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, "tool:copilotclaw_wait");
    expect(result).toEqual({ action: "wait" });
  });

  it("returns stop when backgroundTasks was false", () => {
    const bgMap = new Map<string, boolean>([["s1", false]]);
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, "idle");
    expect(result).toEqual({ action: "stop" });
  });

  it("returns stop when no backgroundTasks info and state is not copilotclaw_wait", () => {
    const bgMap = new Map<string, boolean>();
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, "tool:some_other_tool");
    expect(result).toEqual({ action: "stop" });
  });

  it("backgroundTasks check takes priority over currentState check", () => {
    // Even if currentState is not copilotclaw_wait, backgroundTasks should trigger wait
    const bgMap = new Map<string, boolean>([["s1", true]]);
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, "tool:some_tool");
    expect(result).toEqual({ action: "wait" });
  });
});
