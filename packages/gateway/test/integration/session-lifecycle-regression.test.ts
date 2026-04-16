/**
 * Integration regression tests for the 7 original state-management bugs.
 *
 * Each test scenario verifies that a specific class of bug does not recur by
 * exercising the REAL SessionOrchestrator + REAL Store + REAL SessionController
 * with MOCK AgentManager and MOCK SseBroadcaster.
 *
 * Copilot SDK is never used — all physical session interactions are mocked.
 * These tests run entirely in-process against SQLite in-memory databases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentManager } from "../../src/agent-manager.js";
import { SessionController } from "../../src/session-controller.js";
import { SessionOrchestrator } from "../../src/session-orchestrator.js";
import { Store } from "../../src/store.js";

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeMockAgentManager() {
  return {
    startPhysicalSession: vi.fn(),
    stopPhysicalSession: vi.fn(),
    notifyAgent: vi.fn(),
    disconnectPhysicalSession: vi.fn(),
    getModels: vi.fn().mockResolvedValue(null),
  } as unknown as AgentManager;
}

/**
 * Create a fully-wired test rig: real Store + real SessionOrchestrator + real
 * SessionController, with mocked AgentManager and SseBroadcaster.
 *
 * All components use SQLite in-memory databases — no files are written.
 */
function makeRig() {
  const store = new Store(); // in-memory SQLite
  const orchestrator = new SessionOrchestrator(); // in-memory (no persistPath)
  const agentManager = makeMockAgentManager();
  const sseBroadcast = vi.fn();

  const controller = new SessionController({
    orchestrator,
    store,
    agentManager,
    resolveModelForChannel: async () => "gpt-4.1-mock",
  });
  controller.setSseBroadcast(sseBroadcast);

  const channelId = store.createChannel().id;

  return { store, orchestrator, controller, agentManager, sseBroadcast, channelId };
}

// ── Scenario helpers ──────────────────────────────────────────────────────────

/** Cast agentManager spy references for convenient assertion. */
function spies(agentManager: AgentManager) {
  const am = agentManager as unknown as {
    startPhysicalSession: ReturnType<typeof vi.fn>;
    stopPhysicalSession: ReturnType<typeof vi.fn>;
    notifyAgent: ReturnType<typeof vi.fn>;
  };
  return am;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Session lifecycle regression: 7 original bugs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bug 1: POST handler がセッション起動する（メッセージ詰まり防止）
  // The message delivery path must enqueue the message in the pending queue AND
  // initiate a physical session. Without this, messages silently accumulate with
  // no agent to process them.
  // ────────────────────────────────────────────────────────────────────────────

  it("deliverMessage starts a physical session and enqueues message to pending queue", async () => {
    const { controller, orchestrator, store, agentManager, channelId } = makeRig();
    const am = spies(agentManager);

    // Deliver a user message to a channel with no active session
    const { msg, delivery } = await controller.deliverMessage(channelId, "user", "Hello");

    // Message is returned and stored
    expect(msg).toBeDefined();
    expect(msg!.sender).toBe("user");

    // Session was launched
    expect(delivery).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalledOnce();

    // Session status is now "starting"
    const sessionId = orchestrator.getSessionIdForChannel(channelId);
    expect(sessionId).toBeDefined();
    expect(orchestrator.getSessionStatuses()[sessionId!]?.status).toBe("starting");

    // Message sits in the pending queue (not yet drained)
    const oldest = store.peekOldestPending(channelId);
    expect(oldest).toBeDefined();
    expect(oldest!.message).toBe("Hello");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bug 2: session ended で pending を無条件 flush しない（データ消失防止）
  // An idle end must NOT flush the pending queue; only an error end should flush.
  // Flushing on idle would silently discard messages that arrived while the
  // session was shutting down.
  // ────────────────────────────────────────────────────────────────────────────

  describe("session ended: pending queue behaviour by end reason", () => {
    it("idle end does NOT flush the pending queue (messages are preserved)", async () => {
      const { controller, orchestrator, store, channelId } = makeRig();

      // Bring up a full session
      await controller.deliverMessage(channelId, "user", "first message");
      const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
      controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
      controller.onToolExecutionStart(sessionId, "bash");
      // Drain the original message from the pending queue
      store.drainPending(channelId);

      // Add a new pending message that arrives DURING processing
      store.addMessage(channelId, "user", "pending during processing");
      expect(store.peekOldestPending(channelId)).toBeDefined();

      // Session ends with idle reason
      controller.onPhysicalSessionEnded(sessionId, "idle", 60_000);
      expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("idle");

      // Pending queue must still contain the message (not flushed)
      expect(store.peekOldestPending(channelId)).toBeDefined();
    });

    it("error end DOES flush the pending queue (contrast with idle end)", async () => {
      const { controller, orchestrator, store, channelId } = makeRig();

      await controller.deliverMessage(channelId, "user", "first message");
      const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
      controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
      controller.onToolExecutionStart(sessionId, "bash");
      // Drain original message
      store.drainPending(channelId);

      // Add a new pending message
      store.addMessage(channelId, "user", "pending during error");
      expect(store.peekOldestPending(channelId)).toBeDefined();

      // Session ends with error reason — should flush pending
      controller.onPhysicalSessionEnded(sessionId, "error", 5_000, "crash");
      expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");

      // Pending queue must be empty after error flush
      expect(store.peekOldestPending(channelId)).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bug 3: wait 中に idle が来てもゾンビにならない（wait/idle race）
  // When the copilotclaw_wait drain is in progress (waitingOnWaitTool=true),
  // a spurious session.idle event must be suppressed. If accepted, the session
  // would transition to idle while messages are still being drained — a zombie.
  // ────────────────────────────────────────────────────────────────────────────

  describe("wait/idle race prevention (v0.79.0)", () => {
    it("idle signal during copilotclaw_wait drain is suppressed", async () => {
      const { controller, orchestrator, channelId } = makeRig();

      // Bring session to waiting via copilotclaw_wait
      await controller.deliverMessage(channelId, "user", "start");
      const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
      controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
      controller.onToolExecutionStart(sessionId, "bash"); // → processing
      controller.onToolExecutionStart(sessionId, "copilotclaw_wait"); // → waiting, waitingOnWaitTool=true

      // Verify flag is set
      expect(orchestrator.getSessionStatuses()[sessionId]?.waitingOnWaitTool).toBe(true);

      // Spurious idle arrives — must be ignored
      controller.onSessionIdle(sessionId, false);

      // Session must NOT have transitioned to idle; it stays in "waiting" (copilotclaw_wait sets status=waiting)
      const status = orchestrator.getSessionStatuses()[sessionId]?.status;
      expect(status).toBe("waiting");
      expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("tool:copilotclaw_wait");
    });

    it("idle signal is accepted after copilotclaw_wait drain completes", async () => {
      const { controller, orchestrator, channelId } = makeRig();

      await controller.deliverMessage(channelId, "user", "start");
      const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
      controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
      controller.onToolExecutionStart(sessionId, "copilotclaw_wait"); // → waiting, waitingOnWaitTool=true

      // Drain completes → waitingOnWaitTool cleared
      controller.onToolExecutionComplete(sessionId);
      expect(orchestrator.getSessionStatuses()[sessionId]?.waitingOnWaitTool).toBe(false);

      // Now idle is accepted: physical state transitions to idle
      controller.onSessionIdle(sessionId, false);
      expect(orchestrator.getSessionStatuses()[sessionId]?.physicalSession?.currentState).toBe("idle");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bug 4: starting timeout で永久スタックしない
  // If startPhysicalSession is called but the agent never acknowledges with
  // physical_session_started, the session would remain stuck in "starting"
  // forever. The 30-second timeout must transition it to "suspended".
  // ────────────────────────────────────────────────────────────────────────────

  describe("starting timeout prevents permanent stuck state (v0.83.0)", () => {
    it("session transitions to suspended after 30s without physical_session_started ACK", async () => {
      vi.useFakeTimers();
      const { controller, orchestrator, channelId } = makeRig();

      // Start session — agentManager.startPhysicalSession is called but never ACKed
      await controller.ensureSessionForChannel(channelId);
      const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
      expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");

      // Advance past the 30-second ACK timeout
      vi.advanceTimersByTime(30_001);

      // Session must have transitioned to "suspended" via StartTimeout
      expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");
    });

    it("timeout is cancelled when ACK arrives in time", async () => {
      vi.useFakeTimers();
      const { controller, orchestrator, channelId } = makeRig();

      await controller.ensureSessionForChannel(channelId);
      const sessionId = orchestrator.getSessionIdForChannel(channelId)!;

      // ACK arrives before timeout
      controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
      expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");

      // Advance past the timeout window — session must remain in "waiting"
      vi.advanceTimersByTime(30_001);
      expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("waiting");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bug 5: double drain が構造的に防止される
  // Two concurrent copilotclaw_wait calls must not both drain the pending queue.
  // drainPending is atomic (DrainStarted + DrainCompleted in a single call), so
  // by the time a second drain runs, DrainCompleted has already removed all messages
  // via SQL DELETE — the second drain finds an empty queue and returns nothing.
  // ────────────────────────────────────────────────────────────────────────────

  it("double drain is structurally prevented: second drain returns empty", async () => {
    const { store, channelId } = makeRig();

    // Put messages into the pending queue
    store.addMessage(channelId, "user", "message A");
    store.addMessage(channelId, "user", "message B");

    // First drain — succeeds and returns all pending messages
    const firstDrain = store.drainPending(channelId);
    expect(firstDrain).toHaveLength(2);

    // Second drain — queue is now empty because DrainCompleted removed the messages
    // via SQL DELETE, so this returns nothing (no double-delivery).
    const secondDrain = store.drainPending(channelId);
    expect(secondDrain).toHaveLength(0);

    // Total drained == original count (no double-delivery)
    expect(firstDrain.length + secondDrain.length).toBe(2);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bug 6: processing デッドロック防止（session ended → recovery）
  // If a session ends unexpectedly while in "processing" state, the abstract
  // session must transition to "suspended" (not stay stuck in "processing").
  // A subsequent message must be able to restart the session normally.
  // ────────────────────────────────────────────────────────────────────────────

  it("processing deadlock recovery: error end transitions to suspended and new message restarts session", async () => {
    const { controller, orchestrator, agentManager, channelId } = makeRig();
    const am = spies(agentManager);

    // Bring session to processing
    await controller.deliverMessage(channelId, "user", "start");
    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
    controller.onToolExecutionStart(sessionId, "bash"); // → processing
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("processing");

    // Unexpected session end while processing.
    // Use elapsedMs >= 30_000 to avoid triggering backoff (backoff only fires when
    // elapsedMs < 30_000 in the reducer). Backoff would block ensureSessionForChannel.
    controller.onPhysicalSessionEnded(sessionId, "error", 30_001, "unexpected crash");

    // Must transition to "suspended", not remain stuck in "processing"
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");

    // New message must revive the session and call startPhysicalSession again
    am.startPhysicalSession.mockClear();
    const { delivery } = await controller.deliverMessage(channelId, "user", "try again");
    expect(delivery).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalledOnce();

    // Session must now be in "starting" — no deadlock
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");
  });

  it("processing deadlock recovery with backoff: elapsedMs < 30s triggers 60s backoff, new message is blocked until backoff expires", async () => {
    vi.useFakeTimers();
    const { controller, orchestrator, agentManager, channelId } = makeRig();
    const am = spies(agentManager);

    // Bring session to processing
    await controller.deliverMessage(channelId, "user", "start");
    const sessionId = orchestrator.getSessionIdForChannel(channelId)!;
    controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1");
    controller.onToolExecutionStart(sessionId, "bash"); // → processing
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("processing");

    // Unexpected session end with elapsedMs < 30_000 → triggers 60s backoff
    controller.onPhysicalSessionEnded(sessionId, "error", 3_000, "rapid failure");
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");

    // Channel is now in backoff — ensureSessionForChannel returns early without calling startPhysicalSession
    am.startPhysicalSession.mockClear();
    await controller.deliverMessage(channelId, "user", "blocked during backoff");
    expect(am.startPhysicalSession).not.toHaveBeenCalled();

    // Advance past the 60s backoff window → backoff expires
    vi.advanceTimersByTime(60_001);

    // After backoff expires, a new message must be able to restart the session
    am.startPhysicalSession.mockClear();
    const { delivery: afterBackoff } = await controller.deliverMessage(channelId, "user", "try again after backoff");
    expect(afterBackoff).toBe("session-started");
    expect(am.startPhysicalSession).toHaveBeenCalledOnce();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bug 7: gateway 再起動後のセッション紐付け（reconcile）
  // After a gateway restart, the orchestrator's in-memory state is gone. The
  // agent may still have sessions running. onReconcile must restore the correct
  // abstract session state so that sessions are not abandoned or duplicated.
  // ────────────────────────────────────────────────────────────────────────────

  it("reconcile: stale starting session is idled and pending message restarts it", async () => {
    const { controller, orchestrator, agentManager, store, channelId } = makeRig();
    const am = spies(agentManager);

    // Create a session stuck in "starting" (e.g. gateway crashed before ACK)
    const sessionId = orchestrator.startSession(channelId);
    // Transition to starting via ReviveRequested
    controller.dispatchEvent(sessionId, { type: "ReviveRequested" });
    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("starting");

    // Add a pending message that was queued before the crash
    store.addMessage(channelId, "user", "queued before restart");

    // Reconcile with empty running sessions (agent has no session for this channel)
    am.startPhysicalSession.mockClear();
    controller.onReconcile([]);

    // Wait a tick for the async ensureSessionForChannel triggered by checkAllChannelsPending
    await new Promise((r) => setTimeout(r, 10));

    // Session should be revived: stale "starting" → idled → new "starting" via pending check
    expect(am.startPhysicalSession).toHaveBeenCalledOnce();
    const currentStatus = orchestrator.getSessionStatuses()[sessionId]?.status;
    expect(currentStatus).toBe("starting");
  });

  it("reconcile: suspended session is revived when agent reports it as running", () => {
    const { controller, orchestrator, channelId } = makeRig();

    // Create a suspended session (simulates a gateway restart where the session was active)
    const sessionId = orchestrator.startSession(channelId);
    controller.dispatchEvent(sessionId, { type: "ReviveRequested" }); // new → starting
    controller.onPhysicalSessionStarted(sessionId, "phys-1", "gpt-4.1"); // starting → waiting
    controller.onPhysicalSessionEnded(sessionId, "error", 0); // waiting → suspended

    expect(orchestrator.getSessionStatuses()[sessionId]?.status).toBe("suspended");

    // Agent reports the session is still running (e.g. physicalSession survived restart)
    controller.onReconcile([{ sessionId, status: "waiting" }]);

    // Session must be reconciled back to an active state
    const reconciledStatus = orchestrator.getSessionStatuses()[sessionId]?.status;
    expect(["waiting", "processing", "starting"]).toContain(reconciledStatus);
    expect(orchestrator.hasActiveSessionForChannel(channelId)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Scope note: raw-requirements bugs not covered by this integration test file
  //
  // The following two MEDIUM-priority bugs from docs/raw-requirements/message-status-bugs.md
  // are fixed as of v0.64.0 (SessionController introduction) and covered by unit tests:
  //
  // - "notifyAgent が死んだセッションに通知して無視される":
  //   Fixed in v0.64.0. The MessageDelivered reducer event no-ops on suspended/idle/new
  //   sessions (no NotifyAgent command is emitted). Covered by:
  //   packages/gateway/test/unit/session-reducer.test.ts — "idle session: no commands"
  //
  // - "swallowed-message 検出が cron/system メッセージで誤発火":
  //   Fixed in v0.64.0. onAgentDrainedMessages() only sets pendingReplyExpected when
  //   a user-sender message is included in the drain. Covered by:
  //   packages/gateway/test/unit/session-controller.test.ts — "swallowed message detection only fires for user messages, not cron/system"
  // ────────────────────────────────────────────────────────────────────────────
});
