import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import type { PhysicalSessionSummary, SubagentInfo } from "./ipc-client.js";
import type { AbstractSessionWorldState, AbstractSessionStatus } from "./session-events.js";
import { reduceAbstractSession } from "./session-reducer.js";
import type { Store } from "./store.js";

export type { AbstractSessionStatus };

export interface AbstractSession {
  sessionId: string;
  status: AbstractSessionStatus;
  channelId?: string | undefined;
  startedAt: string;
  /** @deprecated use physicalSessionId instead. Kept for schema migration compatibility only. */
  copilotSessionId?: string | undefined;
  /** Physical session ID used for resumeSession. Renamed from copilotSessionId in v0.79.0. */
  physicalSessionId?: string | undefined;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  physicalSession?: PhysicalSessionSummary | undefined;
  physicalSessionHistory: PhysicalSessionSummary[];
  subagentSessions?: SubagentInfo[] | undefined;
  processingStartedAt?: string | undefined;
  /** True when copilotclaw_wait is currently executing (drain not yet complete). */
  waitingOnWaitTool: boolean;
  /** True once at least one physical session has started on this abstract session. */
  hasHadPhysicalSession: boolean;
}

export interface SessionOrchestratorOptions {
  /** Path to SQLite database file. When omitted, uses in-memory database. */
  persistPath?: string;
  /** Path to legacy agent-bindings.json for one-time migration. */
  legacyBindingsPath?: string;
  /** Store instance for channel backoff persistence (v0.82.0). */
  store?: Store;
}

export class SessionOrchestrator {
  private readonly sessions = new Map<string, AbstractSession>();
  private readonly channelBindings = new Map<string, string>(); // channelId → sessionId
  private readonly channelBackoff = new Map<string, number>(); // channelId → expiresAt timestamp
  private readonly db: Database.Database;
  private readonly store: Store | undefined;

  constructor(options?: SessionOrchestratorOptions) {
    const dbPath = options?.persistPath ?? ":memory:";
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.store = options?.store;
    this.initSchema();

    // One-time migration from legacy agent-bindings.json (must run before data migrations
    // so that imported legacy data is included in the migration scope)
    if (options?.legacyBindingsPath !== undefined) {
      this.migrateFromLegacyBindings(options.legacyBindingsPath);
    }

    this.runDataMigrations();
    this.loadFromDb();
    this.loadBackoffsFromStore();
  }

  private static readonly LATEST_SCHEMA_VERSION = 4;

  /**
   * Normalize all channel-bound session statuses to the v0.58.0 idle/new model.
   * Idempotent — WHERE clauses exclude already-normalized sessions.
   * Called from multiple migration versions because the migration was consolidated
   * after v0.58.0 development. All three versions (v0→v1, v1→v2, v2→v3) perform
   * the same idempotent normalization so that any DB version reaches the correct state.
   */
  private static normalizeSessionStatuses(db: Database.Database): void {
    db.prepare(
      `UPDATE abstract_sessions SET status = 'idle' WHERE status NOT IN ('idle', 'new') AND channelId IS NOT NULL AND physicalSessionHistory != '[]'`,
    ).run();
    db.prepare(
      `UPDATE abstract_sessions SET status = 'new' WHERE status NOT IN ('idle', 'new') AND channelId IS NOT NULL AND physicalSessionHistory = '[]'`,
    ).run();
  }

  private static readonly SCHEMA_MIGRATIONS: Record<number, (db: Database.Database) => void> = {
    // v0→v1, v1→v2, v2→v3: All perform the same idempotent session status normalization.
    // Three versions exist because the migration was developed incrementally during v0.58.0
    // and some DBs were persisted at version 1, 2, or 3 with incomplete normalization.
    0: (db) => SessionOrchestrator.normalizeSessionStatuses(db),
    1: (db) => SessionOrchestrator.normalizeSessionStatuses(db),
    2: (db) => SessionOrchestrator.normalizeSessionStatuses(db),
    // v3→v4: Rename copilotSessionId column to physicalSessionId (v0.79.0).
    // SQLite 3.25.0+ supports RENAME COLUMN. The old copilotSessionId column stored the
    // physical Copilot session ID for resumeSession — now named physicalSessionId.
    3: (db) => {
      try {
        db.exec("ALTER TABLE abstract_sessions RENAME COLUMN copilotSessionId TO physicalSessionId");
      } catch {
        // Column may not exist or already renamed — check and add if missing
        const cols = db.pragma("table_info(abstract_sessions)") as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "physicalSessionId")) {
          db.exec("ALTER TABLE abstract_sessions ADD COLUMN physicalSessionId TEXT");
        }
      }
    },
  };

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS abstract_sessions (
        sessionId TEXT PRIMARY KEY,
        channelId TEXT,
        status TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        physicalSessionId TEXT,
        cumulativeInputTokens INTEGER NOT NULL DEFAULT 0,
        cumulativeOutputTokens INTEGER NOT NULL DEFAULT 0,
        physicalSessionHistory TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS orchestrator_schema_version (
        version INTEGER NOT NULL
      )
    `);
  }

  /** Apply sequential data migrations from the current version to LATEST_SCHEMA_VERSION. */
  private runDataMigrations(): void {
    const row = this.db.prepare("SELECT version FROM orchestrator_schema_version LIMIT 1").get() as { version: number } | undefined;
    let version = row?.version ?? 0;

    while (version < SessionOrchestrator.LATEST_SCHEMA_VERSION) {
      const fn = SessionOrchestrator.SCHEMA_MIGRATIONS[version];
      if (fn === undefined) break;
      fn(this.db);
      version++;
    }

    if (row === undefined) {
      this.db.prepare("INSERT INTO orchestrator_schema_version (version) VALUES (?)").run(version);
    } else if (version !== row.version) {
      this.db.prepare("UPDATE orchestrator_schema_version SET version = ?").run(version);
    }
  }

  /** Load all sessions from SQLite into in-memory maps on construction. */
  private loadFromDb(): void {
    const rows = this.db.prepare(
      "SELECT sessionId, channelId, status, startedAt, physicalSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory FROM abstract_sessions",
    ).all() as Array<{
      sessionId: string;
      channelId: string | null;
      status: string;
      startedAt: string;
      physicalSessionId: string | null;
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

      const status = (row.status as AbstractSessionStatus) ?? "suspended";

      // For "idle" sessions (including those migrated from "suspended" by schema migration v0→v1),
      // restore the last physical session from history so it remains visible in the UI.
      let physicalSession: PhysicalSessionSummary | undefined;
      if (status === "idle" && history.length > 0) {
        physicalSession = { ...history[history.length - 1]!, currentState: "stopped" };
      }

      const session: AbstractSession = {
        sessionId: row.sessionId,
        status,
        channelId: row.channelId ?? undefined,
        startedAt: row.startedAt,
        physicalSessionId: row.physicalSessionId ?? undefined,
        cumulativeInputTokens: row.cumulativeInputTokens,
        cumulativeOutputTokens: row.cumulativeOutputTokens,
        physicalSession,
        physicalSessionHistory: history,
        waitingOnWaitTool: false,
        hasHadPhysicalSession: history.length > 0,
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
      INSERT INTO abstract_sessions (sessionId, channelId, status, startedAt, physicalSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        channelId = excluded.channelId,
        status = excluded.status,
        startedAt = excluded.startedAt,
        physicalSessionId = excluded.physicalSessionId,
        cumulativeInputTokens = excluded.cumulativeInputTokens,
        cumulativeOutputTokens = excluded.cumulativeOutputTokens,
        physicalSessionHistory = excluded.physicalSessionHistory
    `).run(
      session.sessionId,
      session.channelId ?? null,
      session.status,
      session.startedAt,
      session.physicalSessionId ?? null,
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
        INSERT OR IGNORE INTO abstract_sessions (sessionId, channelId, status, startedAt, physicalSessionId, cumulativeInputTokens, cumulativeOutputTokens, physicalSessionHistory)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let migrated = 0;

      this.db.transaction(() => {
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            if (typeof s["sessionId"] !== "string") continue;
            // Support both old copilotSessionId and new physicalSessionId field names
            const physSessId = typeof s["physicalSessionId"] === "string" ? s["physicalSessionId"]
              : typeof s["copilotSessionId"] === "string" ? s["copilotSessionId"] : null;
            insertStmt.run(
              s["sessionId"],
              typeof s["channelId"] === "string" ? s["channelId"] : null,
              typeof s["status"] === "string" ? s["status"] : "suspended",
              typeof s["startedAt"] === "string" ? s["startedAt"] : new Date().toISOString(),
              physSessId,
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
            const physSessId = typeof e["physicalSessionId"] === "string" ? e["physicalSessionId"]
              : typeof e["copilotSessionId"] === "string" ? e["copilotSessionId"] : null;
            insertStmt.run(
              e["sessionId"],
              typeof e["channelId"] === "string" ? e["channelId"] : null,
              typeof e["status"] === "string" ? e["status"] : "suspended",
              typeof e["startedAt"] === "string" ? e["startedAt"] : new Date().toISOString(),
              physSessId,
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
   * Create a new abstract session bound to the given channel, or revive a suspended/idle/new
   * session that is already bound to it. Returns the sessionId.
   *
   * This is the sole method that can create new sessions. Reviving uses applyWorldState
   * to keep the single write-path invariant.
   */
  startSession(channelId: string): string {
    const existingSessionId = this.channelBindings.get(channelId);
    if (existingSessionId !== undefined) {
      const existing = this.sessions.get(existingSessionId);
      if (existing !== undefined) {
        if (existing.status === "suspended" || existing.status === "idle" || existing.status === "new") {
          // Revive from suspended, idle, or new via applyWorldState (single write path)
          const worldState = this.sessionToWorldState(existing);
          const revived: AbstractSessionWorldState = { ...worldState, status: "starting" };
          this.applyWorldState(revived);
          return existingSessionId;
        }
        // Already active — return as-is
        return existingSessionId;
      }
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const newState: AbstractSessionWorldState = {
      sessionId,
      status: "new",
      channelId,
      startedAt: now,
      physicalSessionId: undefined,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      physicalSession: undefined,
      physicalSessionHistory: [],
      subagentSessions: undefined,
      processingStartedAt: undefined,
      waitingOnWaitTool: false,
      hasHadPhysicalSession: false,
    };
    this.applyWorldState(newState);
    return sessionId;
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
    return session !== undefined && session.status !== "suspended" && session.status !== "idle" && session.status !== "new";
  }

  /** Whether the channel is currently in a backoff period.
   *  When backoff has expired, clears it via the channel reducer (BackoffReset event). */
  isChannelInBackoff(channelId: string): boolean {
    const expiresAt = this.channelBackoff.get(channelId);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.channelBackoff.delete(channelId);
      // Route through channel reducer: BackoffReset event emits ClearBackoff command (SQL delete).
      this.store?.dispatchChannelEvent(channelId, { type: "BackoffReset" });
      return false;
    }
    return true;
  }

  /** Record a backoff period for the channel. Persists to store if available.
   *  Routes through the channel reducer (SessionStartFailed event) so the reducer
   *  accumulates failure counts and emits the PersistBackoff command. */
  recordBackoff(channelId: string, durationMs: number): void {
    const expiresAt = Date.now() + durationMs;
    this.channelBackoff.set(channelId, expiresAt);
    // Route through channel reducer: SessionStartFailed event handles failure count
    // accumulation + PersistBackoff command (SQL write). Direct persistChannelBackoff
    // call is no longer needed — the reducer emits PersistBackoff which the store executes.
    this.store?.dispatchChannelEvent(channelId, {
      type: "SessionStartFailed",
      reason: `backoff ${durationMs}ms`,
      backoffDurationMs: durationMs,
    });
  }

  /** Load persisted channel backoffs from store on startup (v0.82.0). */
  private loadBackoffsFromStore(): void {
    if (this.store === undefined) return;
    const backoffs = this.store.loadChannelBackoffs();
    const now = Date.now();
    for (const b of backoffs) {
      if (b.nextRetryAt > now) {
        this.channelBackoff.set(b.channelId, b.nextRetryAt);
      } else {
        // Expired backoff — clear via channel reducer (BackoffReset event emits ClearBackoff command).
        this.store.dispatchChannelEvent(b.channelId, { type: "BackoffReset" });
      }
    }
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

  /**
   * Look up a subagent by its toolCallId within a session.
   * Returns the subagent's name and display name if found, or undefined if not tracked.
   * Used by message-sender.ts to resolve MessageSenderMeta for assistant.message events
   * that carry parentToolCallId (indicating a subagent message).
   */
  getSubagentInfo(sessionId: string, toolCallId: string): { agentName: string; agentDisplayName: string } | undefined {
    const session = this.sessions.get(sessionId);
    const sub = session?.subagentSessions?.find((s) => s.toolCallId === toolCallId);
    if (sub === undefined) return undefined;
    return { agentName: sub.agentName, agentDisplayName: sub.agentDisplayName };
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
   * Transition all active sessions to idle (not suspended).
   * Used when the agent stream disconnects (agent restart) — physical sessions
   * are gone but abstract sessions should remain visible with their last state.
   * Routes each session through the reducer's PhysicalSessionEnded(reason="idle") event.
   */
  idleAllActive(): void {
    for (const [, session] of this.sessions) {
      if (session.status !== "suspended" && session.status !== "idle" && session.status !== "new") {
        const state = this.sessionToWorldState(session);
        const { newState } = reduceAbstractSession(state, {
          type: "PhysicalSessionEnded",
          physicalSessionId: session.physicalSessionId ?? "",
          reason: "idle",
          elapsedMs: 0,
        });
        this.applyWorldState(newState);
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
  reconcileWithAgent(runningSessions: Array<{ sessionId: string; status: string }>): Array<{ sessionId: string; targetStatus: AbstractSessionStatus }> {
    const reportedIds = new Set(runningSessions.map((r) => r.sessionId));

    // Idle any sessions that orchestrator thinks are active but agent doesn't report.
    // This handles: gateway restart → orchestrator loads stale "active" state from SQLite
    // → agent is a new process with no sessions → stale active sessions must be idled.
    for (const [sessionId, session] of this.sessions) {
      if (session.status !== "suspended" && session.status !== "idle" && session.status !== "new" && !reportedIds.has(sessionId)) {
        console.error(`[orchestrator] reconciled: idling stale session ${sessionId.slice(0, 8)} (not reported by agent)`);
        const state = this.sessionToWorldState(session);
        const { newState } = reduceAbstractSession(state, {
          type: "PhysicalSessionEnded",
          physicalSessionId: session.physicalSessionId ?? "",
          reason: "idle",
          elapsedMs: 0,
        });
        this.applyWorldState(newState);
      }
    }

    // Revive suspended/idle sessions that agent reports as running.
    // Returns the list of sessions that need revival so SessionController can route them
    // through the reducer (Reconcile event → BroadcastStatusChange + PersistSession commands).
    const toRevive: Array<{ sessionId: string; targetStatus: AbstractSessionStatus }> = [];
    for (const running of runningSessions) {
      const existing = this.sessions.get(running.sessionId);
      if (existing !== undefined) {
        if (existing.status === "suspended" || existing.status === "idle") {
          // Map agent-reported status to abstract session status
          const targetStatus: AbstractSessionStatus =
            running.status === "waiting" ? "waiting"
            : running.status === "processing" ? "processing"
            : "starting";
          toRevive.push({ sessionId: running.sessionId, targetStatus });
        }
      } else {
        console.error(`[orchestrator] reconciled: unknown session ${running.sessionId.slice(0, 8)}, skipping`);
      }
    }
    return toRevive;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /**
   * Get a single session by ID (direct reference, not a copy).
   * Used by the effect runtime to read current state without cloning.
   */
  getSession(sessionId: string): AbstractSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Apply a world state snapshot to the in-memory map and persist it to SQLite.
   * This is the single write path for all session state changes.
   * Used by the effect runtime after reducer execution, and internally by
   * startSession / idleAllActive / reconcileWithAgent.
   *
   * The orchestrator's channelBindings map is kept consistent: if the channelId
   * changes (e.g., a session becomes unbound), the binding is updated accordingly.
   */
  applyWorldState(state: AbstractSessionWorldState): void {
    const existing = this.sessions.get(state.sessionId);

    const session: AbstractSession = {
      sessionId: state.sessionId,
      status: state.status,
      channelId: state.channelId,
      startedAt: state.startedAt,
      physicalSessionId: state.physicalSessionId,
      cumulativeInputTokens: state.cumulativeInputTokens,
      cumulativeOutputTokens: state.cumulativeOutputTokens,
      physicalSession: state.physicalSession,
      physicalSessionHistory: state.physicalSessionHistory,
      subagentSessions: state.subagentSessions,
      processingStartedAt: state.processingStartedAt,
      waitingOnWaitTool: state.waitingOnWaitTool,
      hasHadPhysicalSession: state.hasHadPhysicalSession,
    };

    // Update channel bindings if channelId changed
    if (existing?.channelId !== state.channelId) {
      if (existing?.channelId !== undefined) {
        this.channelBindings.delete(existing.channelId);
      }
      if (state.channelId !== undefined) {
        this.channelBindings.set(state.channelId, state.sessionId);
      }
    }

    this.sessions.set(state.sessionId, session);
    this.persistSession(session);
  }

  /** Convert an AbstractSession to its world-state representation. */
  private sessionToWorldState(session: AbstractSession): AbstractSessionWorldState {
    return {
      sessionId: session.sessionId,
      channelId: session.channelId,
      status: session.status,
      waitingOnWaitTool: session.waitingOnWaitTool,
      hasHadPhysicalSession: session.hasHadPhysicalSession,
      physicalSessionId: session.physicalSessionId,
      physicalSession: session.physicalSession,
      physicalSessionHistory: session.physicalSessionHistory,
      cumulativeInputTokens: session.cumulativeInputTokens,
      cumulativeOutputTokens: session.cumulativeOutputTokens,
      subagentSessions: session.subagentSessions,
      processingStartedAt: session.processingStartedAt,
      startedAt: session.startedAt,
    };
  }
}
