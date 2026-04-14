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
    copilotSessionId: undefined,
    physicalSession: undefined,
    physicalSessionHistory: [],
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

  it('returns "no-physical-session-initial" when no copilotSessionId, no physicalSession, and no history', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        copilotSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [],
      }),
      hasPending: false,
    });
    expect(result).toBe("no-physical-session-initial");
  });

  it('returns "no-physical-session-after-stop" when no copilotSessionId, no physicalSession, but has history', () => {
    const result = selectDerivedChannelStatus({
      session: makeSession({
        copilotSessionId: undefined,
        physicalSession: undefined,
        physicalSessionHistory: [
          { sessionId: "prev-session", model: "gpt-4.1", startedAt: "2026-01-01T00:00:00Z", currentState: "stopped" },
        ],
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
});
