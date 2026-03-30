import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PhysicalSessionSummary, SubagentInfo } from "./ipc-client.js";

export type AbstractSessionStatus = "starting" | "waiting" | "processing" | "suspended";

export interface AbstractSession {
  sessionId: string;
  status: AbstractSessionStatus;
  channelId?: string | undefined;
  startedAt: string;
  copilotSessionId?: string | undefined;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  physicalSession?: PhysicalSessionSummary | undefined;
  physicalSessionHistory: PhysicalSessionSummary[];
  subagentSessions?: SubagentInfo[] | undefined;
  processingStartedAt?: string | undefined;
}

interface SessionSnapshot {
  sessionId: string;
  status: AbstractSessionStatus;
  channelId?: string | undefined;
  startedAt: string;
  copilotSessionId?: string | undefined;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  physicalSessionHistory: PhysicalSessionSummary[];
}

interface PersistenceSnapshot {
  sessions: SessionSnapshot[];
  channelBindings: Record<string, string>;
  channelBackoff: Record<string, number>;
}

export class SessionOrchestrator {
  private readonly sessions = new Map<string, AbstractSession>();
  private readonly channelBindings = new Map<string, string>(); // channelId → sessionId
  private readonly channelBackoff = new Map<string, number>(); // channelId → expiresAt timestamp
  private readonly persistPath: string | undefined;

  constructor(options?: { persistPath?: string }) {
    this.persistPath = options?.persistPath;
  }

  /**
   * Create a new session bound to the given channel, or revive a suspended
   * session that is already bound to it.  Returns the sessionId.
   */
  startSession(channelId: string): string {
    const existingSessionId = this.channelBindings.get(channelId);
    if (existingSessionId !== undefined) {
      const existing = this.sessions.get(existingSessionId);
      if (existing !== undefined) {
        if (existing.status === "suspended") {
          // Revive
          existing.status = "starting";
          existing.channelId = channelId;
          return existingSessionId;
        }
        // Already active — return as-is
        return existingSessionId;
      }
    }

    const sessionId = randomUUID();
    const session: AbstractSession = {
      sessionId,
      status: "starting",
      channelId,
      startedAt: new Date().toISOString(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      physicalSessionHistory: [],
    };
    this.sessions.set(sessionId, session);
    this.channelBindings.set(channelId, sessionId);
    return sessionId;
  }

  /**
   * Transition a session to suspended.  Accumulates token counts from the
   * current physical session (if any) and moves it to history.
   */
  suspendSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;

    if (session.physicalSession !== undefined) {
      session.cumulativeInputTokens += session.physicalSession.totalInputTokens ?? 0;
      session.cumulativeOutputTokens += session.physicalSession.totalOutputTokens ?? 0;
      session.physicalSessionHistory.push(session.physicalSession);
      session.physicalSession = undefined;
    }
    session.subagentSessions = undefined;
    session.processingStartedAt = undefined;
    session.status = "suspended";
  }

  /** Return a snapshot of all sessions keyed by sessionId. */
  getSessionStatuses(): Record<string, AbstractSession> {
    const result: Record<string, AbstractSession> = {};
    for (const [id, session] of this.sessions) {
      result[id] = { ...session, physicalSessionHistory: [...session.physicalSessionHistory] };
    }
    return result;
  }

  /** Whether any session (active or suspended) is bound to the channel. */
  hasSessionForChannel(channelId: string): boolean {
    return this.channelBindings.has(channelId);
  }

  /** Whether the channel has a non-suspended session. */
  hasActiveSessionForChannel(channelId: string): boolean {
    const sessionId = this.channelBindings.get(channelId);
    if (sessionId === undefined) return false;
    const session = this.sessions.get(sessionId);
    return session !== undefined && session.status !== "suspended";
  }

  /** Whether the channel is currently in a backoff period. */
  isChannelInBackoff(channelId: string): boolean {
    const expiresAt = this.channelBackoff.get(channelId);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.channelBackoff.delete(channelId);
      return false;
    }
    return true;
  }

  /** Record a backoff period for the channel. */
  recordBackoff(channelId: string, durationMs: number): void {
    this.channelBackoff.set(channelId, Date.now() + durationMs);
  }

  /**
   * Check whether the session has exceeded the given max age.
   * Returns true if the session's age exceeds maxAgeMs.
   */
  checkSessionMaxAge(sessionId: string, maxAgeMs: number): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    const age = Date.now() - new Date(session.startedAt).getTime();
    return age > maxAgeMs;
  }

  /** Get the sessionId bound to a channel, if any. */
  getSessionIdForChannel(channelId: string): string | undefined {
    return this.channelBindings.get(channelId);
  }

  /** Update the current physical session on an abstract session. */
  updatePhysicalSession(sessionId: string, physicalSession: PhysicalSessionSummary): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.physicalSession = physicalSession;
  }

  /** Update the status of an abstract session. */
  updateSessionStatus(sessionId: string, status: AbstractSessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.status = status;
  }

  /** Fully remove a session and its channel binding. */
  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.channelId !== undefined) {
      this.channelBindings.delete(session.channelId);
    }
    this.sessions.delete(sessionId);
  }

  /** Persist orchestrator state to a JSON file. */
  saveState(path?: string): void {
    const filePath = path ?? this.persistPath;
    if (filePath === undefined) return;

    const sessions: SessionSnapshot[] = [];
    for (const [, session] of this.sessions) {
      sessions.push({
        sessionId: session.sessionId,
        status: session.status,
        channelId: session.channelId,
        startedAt: session.startedAt,
        copilotSessionId: session.copilotSessionId,
        cumulativeInputTokens: session.cumulativeInputTokens,
        cumulativeOutputTokens: session.cumulativeOutputTokens,
        physicalSessionHistory: session.physicalSessionHistory,
      });
    }

    const channelBindingsObj: Record<string, string> = {};
    for (const [k, v] of this.channelBindings) {
      channelBindingsObj[k] = v;
    }

    const channelBackoffObj: Record<string, number> = {};
    for (const [k, v] of this.channelBackoff) {
      channelBackoffObj[k] = v;
    }

    const snapshot: PersistenceSnapshot = {
      sessions,
      channelBindings: channelBindingsObj,
      channelBackoff: channelBackoffObj,
    };

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
      renameSync(tmp, filePath);
    } catch {
      // Caller can handle errors; this matches agent's saveBindings pattern.
    }
  }

  /** Load orchestrator state from a JSON file. */
  loadState(path?: string): void {
    const filePath = path ?? this.persistPath;
    if (filePath === undefined) return;

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return; // File not found or unreadable — normal on first run.
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Invalid JSON — skip.
    }

    if (typeof parsed !== "object" || parsed === null) return;
    const snap = parsed as Partial<PersistenceSnapshot>;

    // Restore sessions
    if (Array.isArray(snap.sessions)) {
      for (const s of snap.sessions) {
        if (typeof s !== "object" || s === null) continue;
        const rec = s as SessionSnapshot;
        if (typeof rec.sessionId !== "string" || typeof rec.startedAt !== "string") continue;
        const session: AbstractSession = {
          sessionId: rec.sessionId,
          status: rec.status ?? "suspended",
          channelId: rec.channelId,
          startedAt: rec.startedAt,
          copilotSessionId: rec.copilotSessionId,
          cumulativeInputTokens: typeof rec.cumulativeInputTokens === "number" ? rec.cumulativeInputTokens : 0,
          cumulativeOutputTokens: typeof rec.cumulativeOutputTokens === "number" ? rec.cumulativeOutputTokens : 0,
          physicalSessionHistory: Array.isArray(rec.physicalSessionHistory)
            ? rec.physicalSessionHistory
            : [],
        };
        this.sessions.set(session.sessionId, session);
      }
    }

    // Restore channel bindings
    if (typeof snap.channelBindings === "object" && snap.channelBindings !== null) {
      for (const [k, v] of Object.entries(snap.channelBindings)) {
        if (typeof v === "string") {
          this.channelBindings.set(k, v);
        }
      }
    }

    // Restore channel backoff (only future entries)
    if (typeof snap.channelBackoff === "object" && snap.channelBackoff !== null) {
      const now = Date.now();
      for (const [k, v] of Object.entries(snap.channelBackoff)) {
        if (typeof v === "number" && v > now) {
          this.channelBackoff.set(k, v);
        }
      }
    }
  }
}
