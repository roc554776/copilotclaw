import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

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

export interface SessionOrchestratorOptions {
  /** Path to SQLite database file. When omitted, uses in-memory database. */
  persistPath?: string;
  /** Path to legacy agent-bindings.json for one-time migration. */
  legacyBindingsPath?: string;
}

export class SessionOrchestrator {
  private readonly sessions = new Map<string, AbstractSession>();
  private readonly channelBindings = new Map<string, string>(); // channelId → sessionId
  private readonly channelBackoff = new Map<string, number>(); // channelId → expiresAt timestamp
  private readonly db: Database.Database;

  constructor(options?: SessionOrchestratorOptions) {
    const dbPath = options?.persistPath ?? ":memory:";
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
    this.loadFromDb();

    // One-time migration from legacy agent-bindings.json
    if (options?.legacyBindingsPath !== undefined) {
      this.migrateFromLegacyBindings(options.legacyBindingsPath);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS abstract_sessions (
        sessionId TEXT PRIMARY KEY,
        channelId TEXT,
        status TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        copilotSessionId TEXT,
        cumulativeInputTokens INTEGER NOT NULL DEFAULT 0,
        cumulativeOutputTokens INTEGER NOT NULL DEFAULT 0,
        physicalSessionHistory TEXT NOT NULL DEFAULT '[]'
      )
    `);
  }

  /** Load all sessions from SQLite into in-memory maps on construction. */
  private loadFromDb(): void {
    const rows = this.db.prepare(
      "SELECT sessionId, channelId, status, startedAt, copilotSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory FROM abstract_sessions",
    ).all() as Array<{
      sessionId: string;
      channelId: string | null;
      status: string;
      startedAt: string;
      copilotSessionId: string | null;
      cumulativeInputTokens: number;
      cumulativeOutputTokens: number;
      physicalSessionHistory: string;
    }>;

    for (const row of rows) {
      let history: PhysicalSessionSummary[] = [];
      try {
        history = JSON.parse(row.physicalSessionHistory) as PhysicalSessionSummary[];
      } catch {
        // Invalid JSON — use empty array
      }

      const session: AbstractSession = {
        sessionId: row.sessionId,
        status: (row.status as AbstractSessionStatus) ?? "suspended",
        channelId: row.channelId ?? undefined,
        startedAt: row.startedAt,
        copilotSessionId: row.copilotSessionId ?? undefined,
        cumulativeInputTokens: row.cumulativeInputTokens,
        cumulativeOutputTokens: row.cumulativeOutputTokens,
        physicalSessionHistory: history,
      };
      this.sessions.set(session.sessionId, session);

      if (session.channelId !== undefined) {
        this.channelBindings.set(session.channelId, session.sessionId);
      }
    }
  }

  /** Persist a single session to SQLite (upsert). */
  private persistSession(session: AbstractSession): void {
    this.db.prepare(`
      INSERT INTO abstract_sessions (sessionId, channelId, status, startedAt, copilotSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        channelId = excluded.channelId,
        status = excluded.status,
        startedAt = excluded.startedAt,
        copilotSessionId = excluded.copilotSessionId,
        cumulativeInputTokens = excluded.cumulativeInputTokens,
        cumulativeOutputTokens = excluded.cumulativeOutputTokens,
        physicalSessionHistory = excluded.physicalSessionHistory
    `).run(
      session.sessionId,
      session.channelId ?? null,
      session.status,
      session.startedAt,
      session.copilotSessionId ?? null,
      session.cumulativeInputTokens,
      session.cumulativeOutputTokens,
      JSON.stringify(session.physicalSessionHistory),
    );
  }

  /** Remove a session from SQLite. */
  private deleteSessionFromDb(sessionId: string): void {
    this.db.prepare("DELETE FROM abstract_sessions WHERE sessionId = ?").run(sessionId);
  }

  /** Migrate data from legacy agent-bindings.json if it exists. */
  private migrateFromLegacyBindings(jsonPath: string): void {
    if (!existsSync(jsonPath)) return;

    // Only migrate if DB has no sessions (fresh DB)
    const count = this.db.prepare("SELECT COUNT(*) as c FROM abstract_sessions").get() as { c: number };
    if (count.c > 0) return;

    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Legacy format: { sessions: [...], channelBindings: {...}, ... }
      // or the old agent-bindings format: { entries: [...] }
      const sessions = parsed["sessions"] as Array<Record<string, unknown>> | undefined;
      const entries = parsed["entries"] as Array<Record<string, unknown>> | undefined;

      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO abstract_sessions (sessionId, channelId, status, startedAt, copilotSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let migrated = 0;

      this.db.transaction(() => {
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            if (typeof s["sessionId"] !== "string") continue;
            insertStmt.run(
              s["sessionId"],
              typeof s["channelId"] === "string" ? s["channelId"] : null,
              typeof s["status"] === "string" ? s["status"] : "suspended",
              typeof s["startedAt"] === "string" ? s["startedAt"] : new Date().toISOString(),
              typeof s["copilotSessionId"] === "string" ? s["copilotSessionId"] : null,
              typeof s["cumulativeInputTokens"] === "number" ? s["cumulativeInputTokens"] : 0,
              typeof s["cumulativeOutputTokens"] === "number" ? s["cumulativeOutputTokens"] : 0,
              Array.isArray(s["physicalSessionHistory"]) ? JSON.stringify(s["physicalSessionHistory"]) : "[]",
            );
            migrated++;
          }
        } else if (Array.isArray(entries)) {
          // Old agent-bindings.json format
          for (const e of entries) {
            if (typeof e["sessionId"] !== "string") continue;
            insertStmt.run(
              e["sessionId"],
              typeof e["channelId"] === "string" ? e["channelId"] : null,
              typeof e["status"] === "string" ? e["status"] : "suspended",
              typeof e["startedAt"] === "string" ? e["startedAt"] : new Date().toISOString(),
              typeof e["copilotSessionId"] === "string" ? e["copilotSessionId"] : null,
              typeof e["cumulativeInputTokens"] === "number" ? e["cumulativeInputTokens"] : 0,
              typeof e["cumulativeOutputTokens"] === "number" ? e["cumulativeOutputTokens"] : 0,
              Array.isArray(e["physicalSessionHistory"]) ? JSON.stringify(e["physicalSessionHistory"]) : "[]",
            );
            migrated++;
          }
        }
      })();

      if (migrated > 0) {
        // Reload from DB to populate in-memory state
        this.loadFromDb();
        console.error(`[orchestrator] migrated ${migrated} sessions from legacy bindings`);
      }

      // Rename the file to prevent re-migration
      try {
        renameSync(jsonPath, `${jsonPath}.migrated`);
      } catch {
        // Best-effort rename
      }
    } catch (err: unknown) {
      console.error(`[orchestrator] WARNING: failed to migrate legacy bindings: ${String(err)}`);
    }
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
          this.persistSession(existing);
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
    this.persistSession(session);
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
    this.persistSession(session);
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
    this.persistSession(session);
  }

  /** Update the status of an abstract session. */
  updateSessionStatus(sessionId: string, status: AbstractSessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.status = status;
    this.persistSession(session);
  }

  // --- Real-time physical session state updates from forwarded SDK events ---
  // These allow the gateway to maintain the dashboard-visible state without
  // relying on the agent's IPC status RPC.

  /** Update physical session's currentState from tool events. */
  updatePhysicalSessionState(sessionId: string, currentState: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.physicalSession !== undefined) {
      session.physicalSession.currentState = currentState;
    }
  }

  /** Update physical session's token usage from usage_info events. */
  updatePhysicalSessionTokens(sessionId: string, currentTokens: number, tokenLimit: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.physicalSession !== undefined) {
      session.physicalSession.currentTokens = currentTokens;
      session.physicalSession.tokenLimit = tokenLimit;
    }
  }

  /** Accumulate assistant.usage tokens on the physical session. */
  accumulateUsageTokens(sessionId: string, inputTokens: number, outputTokens: number, quotaSnapshots?: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (session?.physicalSession !== undefined) {
      const ps = session.physicalSession;
      ps.totalInputTokens = (ps.totalInputTokens ?? 0) + inputTokens;
      ps.totalOutputTokens = (ps.totalOutputTokens ?? 0) + outputTokens;
      if (quotaSnapshots !== undefined) {
        ps.latestQuotaSnapshots = quotaSnapshots;
      }
    }
  }

  /** Update model on physical session from model_change events. */
  updatePhysicalSessionModel(sessionId: string, newModel: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.physicalSession !== undefined) {
      session.physicalSession.model = newModel;
    }
  }

  /** Track a subagent session start. */
  addSubagentSession(sessionId: string, info: SubagentInfo): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.subagentSessions === undefined) session.subagentSessions = [];
    session.subagentSessions.push(info);
    if (session.subagentSessions.length > 50) {
      session.subagentSessions.splice(0, session.subagentSessions.length - 50);
    }
  }

  /** Update a subagent session status. */
  updateSubagentStatus(sessionId: string, toolCallId: string, status: "completed" | "failed"): void {
    const session = this.sessions.get(sessionId);
    const sub = session?.subagentSessions?.find((s) => s.toolCallId === toolCallId);
    if (sub !== undefined) sub.status = status;
  }

  /** Fully remove a session and its channel binding. */
  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.channelId !== undefined) {
      this.channelBindings.delete(session.channelId);
    }
    this.sessions.delete(sessionId);
    this.deleteSessionFromDb(sessionId);
  }

  /**
   * Suspend all non-suspended sessions.
   * Used when the agent stream disconnects (agent restart) to mark all
   * physical sessions as ended while keeping abstract sessions alive.
   */
  suspendAllActive(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.status !== "suspended") {
        this.suspendSession(sessionId);
      }
    }
  }

  /**
   * Reconcile orchestrator state with actually-running sessions reported by agent.
   * Called when agent stream (re)connects to prevent dual-session on gateway restart.
   *
   * The agent reports sessionId (opaque token originally assigned by gateway) and status.
   * For each running session:
   *   - If orchestrator has a suspended session with that sessionId, revive it
   *   - Unknown sessionIds are logged and skipped (orphaned agent sessions)
   * This ensures the orchestrator knows about sessions that survived a gateway restart.
   */
  reconcileWithAgent(runningSessions: Array<{ sessionId: string; status: string }>): void {
    for (const running of runningSessions) {
      const existing = this.sessions.get(running.sessionId);
      if (existing !== undefined) {
        if (existing.status === "suspended") {
          // Revive the suspended session — the physical session is still alive in agent
          existing.status = running.status === "waiting" ? "waiting" : running.status === "processing" ? "processing" : "starting";
          this.persistSession(existing);
          console.error(`[orchestrator] reconciled: revived session ${running.sessionId.slice(0, 8)}`);
        }
        // If already active, no action needed
      } else {
        // Unknown sessionId — agent has a session we don't know about (orphan)
        console.error(`[orchestrator] reconciled: unknown session ${running.sessionId.slice(0, 8)}, skipping`);
      }
    }
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
