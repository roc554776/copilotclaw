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

/** Replicates the daemon's onSessionEvent handler logic for session.idle. */
function handleSessionIdleEvent(
  orchSessionId: string,
  data: Record<string, unknown>,
  lastIdleHasBackgroundTasks: Map<string, boolean>,
  updateState: (state: string) => void,
): void {
  const bgTasks = data["backgroundTasks"];
  lastIdleHasBackgroundTasks.set(orchSessionId, bgTasks != null);
  if (bgTasks == null) {
    updateState("idle");
  }
}

describe("daemon onSessionEvent — session.idle state update", () => {
  it("sets state to idle when no backgroundTasks", () => {
    const bgMap = new Map<string, boolean>();
    let state = "tool:copilotclaw_wait";
    handleSessionIdleEvent("s1", {}, bgMap, (s) => { state = s; });
    expect(state).toBe("idle");
    expect(bgMap.get("s1")).toBe(false);
  });

  it("preserves current state when backgroundTasks is present", () => {
    const bgMap = new Map<string, boolean>();
    let state = "tool:copilotclaw_wait";
    handleSessionIdleEvent("s1", { backgroundTasks: [{ id: "sub1" }] }, bgMap, (s) => { state = s; });
    expect(state).toBe("tool:copilotclaw_wait");
    expect(bgMap.get("s1")).toBe(true);
  });

  it("preserves state even when backgroundTasks is an empty array", () => {
    const bgMap = new Map<string, boolean>();
    let state = "tool:copilotclaw_wait";
    handleSessionIdleEvent("s1", { backgroundTasks: [] }, bgMap, (s) => { state = s; });
    // Empty array is still != null, so state is preserved
    expect(state).toBe("tool:copilotclaw_wait");
    expect(bgMap.get("s1")).toBe(true);
  });

  it("sets state to idle when backgroundTasks is null", () => {
    const bgMap = new Map<string, boolean>();
    let state = "tool:copilotclaw_wait";
    handleSessionIdleEvent("s1", { backgroundTasks: null }, bgMap, (s) => { state = s; });
    expect(state).toBe("idle");
    expect(bgMap.get("s1")).toBe(false);
  });
});

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

describe("end-to-end: session.idle event then lifecycle check", () => {
  it("subagent stop: session.idle with backgroundTasks preserves state and lifecycle returns wait", () => {
    const bgMap = new Map<string, boolean>();
    let currentState = "tool:copilotclaw_wait";

    // session.idle event arrives first (with backgroundTasks)
    handleSessionIdleEvent("s1", { backgroundTasks: [{ id: "sub1" }] }, bgMap, (s) => { currentState = s; });

    // State should be preserved (not overwritten to "idle")
    expect(currentState).toBe("tool:copilotclaw_wait");

    // lifecycle RPC arrives after
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, currentState);
    expect(result).toEqual({ action: "wait" });
  });

  it("true idle: session.idle without backgroundTasks sets idle state and lifecycle returns stop", () => {
    const bgMap = new Map<string, boolean>();
    let currentState = "tool:copilotclaw_wait";

    // session.idle event arrives (no backgroundTasks)
    handleSessionIdleEvent("s1", {}, bgMap, (s) => { currentState = s; });

    expect(currentState).toBe("idle");

    // lifecycle RPC arrives after
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, currentState);
    expect(result).toEqual({ action: "stop" });
  });

  it("fallback: session.idle without backgroundTasks but copilotclaw_wait still active returns wait", () => {
    const bgMap = new Map<string, boolean>();
    // Simulate a case where session.idle fires without backgroundTasks field
    // but the session state was NOT overwritten (e.g. event processing anomaly)
    // In practice this shouldn't happen, but the fallback check protects against it
    const result = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, "tool:copilotclaw_wait");
    expect(result).toEqual({ action: "wait" });
  });

  it("multiple rapid idle events: only the first with backgroundTasks triggers wait", () => {
    const bgMap = new Map<string, boolean>();
    let currentState = "tool:copilotclaw_wait";

    // First idle event (subagent stop)
    handleSessionIdleEvent("s1", { backgroundTasks: [{ id: "sub1" }] }, bgMap, (s) => { currentState = s; });
    const result1 = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, currentState);
    expect(result1).toEqual({ action: "wait" });
    // backgroundTasks flag is cleared by handleLifecycle
    expect(bgMap.has("s1")).toBe(false);

    // Second idle event (true idle, no backgroundTasks)
    handleSessionIdleEvent("s1", {}, bgMap, (s) => { currentState = s; });
    expect(currentState).toBe("idle");
    const result2 = handleLifecycle({ event: "idle", sessionId: "s1" }, bgMap, currentState);
    expect(result2).toEqual({ action: "stop" });
  });

  it("error after idle: error always takes precedence", () => {
    const bgMap = new Map<string, boolean>([["s1", true]]);
    const result = handleLifecycle({ event: "error", sessionId: "s1" }, bgMap, "tool:copilotclaw_wait");
    expect(result).toEqual({ action: "stop", clearCopilotSessionId: true });
    // backgroundTasks flag is NOT cleared on error (but doesn't matter — session will stop)
    expect(bgMap.get("s1")).toBe(true);
  });
});
