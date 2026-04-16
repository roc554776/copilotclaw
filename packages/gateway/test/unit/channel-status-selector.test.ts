import { describe, expect, it } from "vitest";
import {
  selectDerivedChannelStatus,
  type SelectDerivedChannelStatusInput,
} from "../../src/channel-status-selector.js";

function makeSession(
  overrides: Partial<SelectDerivedChannelStatusInput["session"]> = {},
): SelectDerivedChannelStatusInput["session"] {
  return {
    status: "waiting",
    physicalSessionId: undefined,
    physicalSession: undefined,
    physicalSessionHistory: [],
    hasHadPhysicalSession: false,
    waitingOnWaitTool: false,
    ...overrides,
  };
}

describe("selectDerivedChannelStatus", () => {
  it('returns "client-not-started" when clientStarted is false', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession(),
      hasPending: false,
      clientStarted: false,
    });
    expect(result).toBe("client-not-started");
  });

  it('returns "no-physical-session-initial" when status is "new", no physicalSession, and no history', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "new",
        copilotSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [],
      }),
      hasPending: false,
    });
    expect(result).toBe("no-physical-session-initial");
  });

  it('returns "no-physical-session-initial" when status is "starting", no physicalSession, and no history', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "starting",
        copilotSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [],
      }),
      hasPending: false,
    });
    expect(result).toBe("no-physical-session-initial");
  });

  it('returns "no-physical-session-after-stop" when status is "new", no physicalSession, but hasHadPhysicalSession=true', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "new",
        physicalSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [
          { sessionId: "prev-session", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "stopped" },
        ],
        hasHadPhysicalSession: true,
      }),
      hasPending: false,
    });
    expect(result).toBe("no-physical-session-after-stop");
  });

  it('returns "no-physical-session-after-stop" when status is "suspended", no physicalSession, but hasHadPhysicalSession=true', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "suspended",
        physicalSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [
          { sessionId: "prev-session", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "stopped" },
        ],
        hasHadPhysicalSession: true,
      }),
      hasPending: false,
    });
    expect(result).toBe("no-physical-session-after-stop");
  });

  it('returns "running" when status is "notified"', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "notified",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "idle" },
      }),
      hasPending: false,
    });
    expect(result).toBe("running");
  });

  it('returns "running" when status is "processing"', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "processing",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "idle" },
      }),
      hasPending: false,
    });
    expect(result).toBe("running");
  });

  it('returns "pending-trigger" when status is "waiting" and hasPending is true', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "waiting",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "idle" },
      }),
      hasPending: true,
    });
    expect(result).toBe("pending-trigger");
  });

  it('returns "idle-no-trigger" when status is "waiting" and hasPending is false', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "waiting",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "idle" },
      }),
      hasPending: false,
    });
    expect(result).toBe("idle-no-trigger");
  });

  it('returns "idle-no-trigger" when status is "idle" and hasPending is false', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "idle",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "stopped" },
      }),
      hasPending: false,
    });
    expect(result).toBe("idle-no-trigger");
  });

  it('returns "pending-trigger" when status is "idle" and hasPending is true', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "idle",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "stopped" },
      }),
      hasPending: true,
    });
    expect(result).toBe("pending-trigger");
  });

  it('defaults clientStarted to true when not provided', () => {
    // Should not return "client-not-started" when clientStarted is omitted
    const result = selectDerivedChannelStatus({
      session: makeSession(),
      hasPending: false,
    });
    expect(result).not.toBe("client-not-started");
  });

  // v0.79.0: hasHadPhysicalSession and waitingOnWaitTool parameter combinations
  it('returns "no-physical-session-initial" when hasHadPhysicalSession=false, no physicalSession (status=starting)', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "starting",
        physicalSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [],
        hasHadPhysicalSession: false,
      }),
      hasPending: false,
    });
    expect(result).toBe("no-physical-session-initial");
  });

  it('returns "no-physical-session-after-stop" when hasHadPhysicalSession=true, no physicalSession (status=suspended)', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "suspended",
        physicalSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [],
        hasHadPhysicalSession: true,
      }),
      hasPending: false,
    });
    expect(result).toBe("no-physical-session-after-stop");
  });

  it('returns "running" when waitingOnWaitTool=true but status is processing (tool started during wait tool drain)', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "processing",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "idle" },
        waitingOnWaitTool: true,
      }),
      hasPending: false,
    });
    expect(result).toBe("running");
  });

  it('returns "idle-no-trigger" when waitingOnWaitTool=false and hasPending=false (normal waiting)', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        status: "waiting",
        physicalSession: { sessionId: "ps-1", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "idle" },
        waitingOnWaitTool: false,
      }),
      hasPending: false,
    });
    expect(result).toBe("idle-no-trigger");
  });
});
