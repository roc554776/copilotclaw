/**
 * Unit tests for the Channel reducer (pure function).
 *
 * Covers all event types and guard conditions.
 */

import { describe, expect, it } from "vitest";
import { reduceChannel } from "../../src/channel-reducer.js";
import type { ChannelWorldState } from "../../src/channel-events.js";

function makeState(overrides: Partial<ChannelWorldState> = {}): ChannelWorldState {
  return {
    channelId: "channel-abc",
    archivedAt: undefined,
    model: undefined,
    draft: undefined,
    backoff: undefined,
    ...overrides,
  };
}

// ── MessagePosted ─────────────────────────────────────────────────────────────

describe("reduceChannel — MessagePosted", () => {
  it("active channel with no draft: no state change, no commands", () => {
    const state = makeState();
    const { newState, commands } = reduceChannel(state, {
      type: "MessagePosted",
      sender: "user",
      content: "hello",
    });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });

  it("active channel with draft: clears draft and emits PersistDraft", () => {
    const state = makeState({ draft: "some draft text" });
    const { newState, commands } = reduceChannel(state, {
      type: "MessagePosted",
      sender: "user",
      content: "hello",
    });
    expect(newState.draft).toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "PersistDraft", channelId: "channel-abc", draft: undefined });
  });

  it("archived channel: silently drops message (no commands)", () => {
    const state = makeState({ archivedAt: Date.now(), draft: "draft text" });
    const { newState, commands } = reduceChannel(state, {
      type: "MessagePosted",
      sender: "user",
      content: "hello",
    });
    // draft remains unchanged (archived channels drop messages)
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});

// ── Archived ──────────────────────────────────────────────────────────────────

describe("reduceChannel — Archived", () => {
  it("active channel: sets archivedAt", () => {
    const state = makeState();
    const before = Date.now();
    const { newState, commands } = reduceChannel(state, { type: "Archived" });
    const after = Date.now();
    expect(newState.archivedAt).toBeDefined();
    expect(newState.archivedAt!).toBeGreaterThanOrEqual(before);
    expect(newState.archivedAt!).toBeLessThanOrEqual(after);
    expect(commands).toHaveLength(0);
  });

  it("already archived channel: idempotent (no state change)", () => {
    const archivedAt = Date.now() - 1000;
    const state = makeState({ archivedAt });
    const { newState, commands } = reduceChannel(state, { type: "Archived" });
    expect(newState.archivedAt).toBe(archivedAt);
    expect(commands).toHaveLength(0);
  });
});

// ── Unarchived ────────────────────────────────────────────────────────────────

describe("reduceChannel — Unarchived", () => {
  it("archived channel: clears archivedAt", () => {
    const state = makeState({ archivedAt: Date.now() });
    const { newState, commands } = reduceChannel(state, { type: "Unarchived" });
    expect(newState.archivedAt).toBeUndefined();
    expect(commands).toHaveLength(0);
  });

  it("active channel: idempotent (no state change)", () => {
    const state = makeState();
    const { newState, commands } = reduceChannel(state, { type: "Unarchived" });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});

// ── DefaultModelSet ───────────────────────────────────────────────────────────

describe("reduceChannel — DefaultModelSet", () => {
  it("sets the model", () => {
    const state = makeState();
    const { newState, commands } = reduceChannel(state, {
      type: "DefaultModelSet",
      model: "gpt-4.1",
    });
    expect(newState.model).toBe("gpt-4.1");
    expect(commands).toHaveLength(0);
  });

  it("clears the model when set to undefined", () => {
    const state = makeState({ model: "gpt-4.1" });
    const { newState, commands } = reduceChannel(state, {
      type: "DefaultModelSet",
      model: undefined,
    });
    expect(newState.model).toBeUndefined();
    expect(commands).toHaveLength(0);
  });
});

// ── DraftUpdated ──────────────────────────────────────────────────────────────

describe("reduceChannel — DraftUpdated", () => {
  it("sets draft and emits PersistDraft", () => {
    const state = makeState();
    const { newState, commands } = reduceChannel(state, {
      type: "DraftUpdated",
      draft: "new draft",
    });
    expect(newState.draft).toBe("new draft");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "PersistDraft", channelId: "channel-abc", draft: "new draft" });
  });

  it("clears draft and emits PersistDraft with undefined", () => {
    const state = makeState({ draft: "old draft" });
    const { newState, commands } = reduceChannel(state, {
      type: "DraftUpdated",
      draft: undefined,
    });
    expect(newState.draft).toBeUndefined();
    expect(commands[0]).toEqual({ type: "PersistDraft", channelId: "channel-abc", draft: undefined });
  });
});

// ── SessionStartFailed ────────────────────────────────────────────────────────

describe("reduceChannel — SessionStartFailed", () => {
  it("first failure: creates backoff state and emits PersistBackoff", () => {
    const state = makeState();
    const { newState, commands } = reduceChannel(state, {
      type: "SessionStartFailed",
      reason: "connection refused",
      backoffDurationMs: 1000,
    });
    expect(newState.backoff).toBeDefined();
    expect(newState.backoff!.failureCount).toBe(1);
    expect(newState.backoff!.lastFailureReason).toBe("connection refused");
    expect(newState.backoff!.nextRetryAt).toBeGreaterThan(Date.now());
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("PersistBackoff");
  });

  it("subsequent failure: increments failureCount with exponential backoff", () => {
    const state = makeState({
      backoff: { failureCount: 2, nextRetryAt: Date.now() - 1, lastFailureReason: "prev" },
    });
    const before = Date.now();
    const { newState } = reduceChannel(state, {
      type: "SessionStartFailed",
      reason: "timeout",
      backoffDurationMs: 1000,
    });
    // failureCount 3, baseDuration 1000ms, factor = 2^2 = 4 → 4000ms
    expect(newState.backoff!.failureCount).toBe(3);
    expect(newState.backoff!.nextRetryAt).toBeGreaterThan(before + 3000);
  });

  it("caps backoff at 5 minutes", () => {
    const state = makeState({
      backoff: { failureCount: 20, nextRetryAt: Date.now(), lastFailureReason: "timeout" },
    });
    const before = Date.now();
    const { newState } = reduceChannel(state, {
      type: "SessionStartFailed",
      reason: "timeout",
      backoffDurationMs: 1000,
    });
    const fiveMinutes = 5 * 60 * 1000;
    expect(newState.backoff!.nextRetryAt).toBeLessThanOrEqual(before + fiveMinutes + 100);
  });
});

// ── BackoffReset ──────────────────────────────────────────────────────────────

describe("reduceChannel — BackoffReset", () => {
  it("clears backoff state and emits ClearBackoff", () => {
    const state = makeState({
      backoff: { failureCount: 2, nextRetryAt: Date.now(), lastFailureReason: "timeout" },
    });
    const { newState, commands } = reduceChannel(state, { type: "BackoffReset" });
    expect(newState.backoff).toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ type: "ClearBackoff", channelId: "channel-abc" });
  });

  it("no backoff present: idempotent (no state change, no commands)", () => {
    const state = makeState();
    const { newState, commands } = reduceChannel(state, { type: "BackoffReset" });
    expect(newState).toEqual(state);
    expect(commands).toHaveLength(0);
  });
});
