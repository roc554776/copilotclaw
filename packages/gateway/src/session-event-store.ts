import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export interface SessionEvent {
  /** Database row ID (used as cursor for pagination). */
  id?: number;
  /** SDK session event type (e.g. "tool.execution_start", "assistant.message"). */
  type: string;
  /** Event timestamp (ISO 8601). */
  timestamp: string;
  /** Event data payload. */
  data: Record<string, unknown>;
  /** Parent event ID for nesting (if applicable). */
  parentId?: string;
}

export interface SystemPromptSnapshot {
  model: string;
  prompt: string;
  capturedAt: string;
}

const DEFAULT_MAX_EVENTS = 100_000; // max total events across all sessions

export class SessionEventStore {
  private readonly db: Database.Database;
  private readonly promptDir: string;
  private readonly maxEvents: number;

  constructor(dataDir: string, maxEvents?: number) {
    this.promptDir = join(dataDir, "prompts");
    mkdirSync(this.promptDir, { recursive: true });

    const dbPath = join(dataDir, "session-events.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.maxEvents = maxEvents ?? DEFAULT_MAX_EVENTS;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL,
        parentId TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(sessionId);
      CREATE INDEX IF NOT EXISTS idx_events_session_time ON session_events(sessionId, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type ON session_events(type);
    `);
  }

  /** Append an event for a session. */
  appendEvent(sessionId: string, event: SessionEvent): void {
    const stmt = this.db.prepare("INSERT INTO session_events (sessionId, type, timestamp, data, parentId) VALUES (?, ?, ?, ?, ?)");
    stmt.run(sessionId, event.type, event.timestamp, JSON.stringify(event.data), event.parentId ?? null);
    this.maybeEnforceStorageCap();
  }

  private insertCount = 0;
  private maybeEnforceStorageCap(): void {
    this.insertCount++;
    if (this.insertCount % 500 === 0) {
      this.enforceStorageCap();
    }
  }

  /** Get all events for a session. */
  getEvents(sessionId: string): SessionEvent[] {
    const rows = this.db.prepare("SELECT id, type, timestamp, data, parentId FROM session_events WHERE sessionId = ? ORDER BY id ASC").all(sessionId) as Array<{ id: number; type: string; timestamp: string; data: string; parentId: string | null }>;
    return rows.map((r) => this.rowToEvent(r));
  }

  /** Get paginated events for a session. Returns newest N events when no cursor, or events before/after a cursor. */
  getEventsPaginated(sessionId: string, limit: number, options?: { before?: number; after?: number }): SessionEvent[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
    let rows: Array<{ id: number; type: string; timestamp: string; data: string; parentId: string | null }>;
    if (options?.before !== undefined) {
      // Older events (ascending order, before cursor)
      rows = this.db.prepare(
        "SELECT id, type, timestamp, data, parentId FROM session_events WHERE sessionId = ? AND id < ? ORDER BY id DESC LIMIT ?",
      ).all(sessionId, options.before, safeLimit) as typeof rows;
      rows.reverse(); // Return in ascending order
    } else if (options?.after !== undefined) {
      // Newer events (after cursor)
      rows = this.db.prepare(
        "SELECT id, type, timestamp, data, parentId FROM session_events WHERE sessionId = ? AND id > ? ORDER BY id ASC LIMIT ?",
      ).all(sessionId, options.after, safeLimit) as typeof rows;
    } else {
      // Latest N events
      rows = this.db.prepare(
        "SELECT id, type, timestamp, data, parentId FROM session_events WHERE sessionId = ? ORDER BY id DESC LIMIT ?",
      ).all(sessionId, safeLimit) as typeof rows;
      rows.reverse(); // Return in ascending order
    }
    return rows.map((r) => this.rowToEvent(r));
  }

  /** Get total event count for a session. */
  getEventCount(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM session_events WHERE sessionId = ?").get(sessionId) as { c: number };
    return row.c;
  }

  private rowToEvent(r: { id: number; type: string; timestamp: string; data: string; parentId: string | null }): SessionEvent {
    const event: SessionEvent = {
      id: r.id,
      type: r.type,
      timestamp: r.timestamp,
      data: JSON.parse(r.data) as Record<string, unknown>,
    };
    if (r.parentId !== null) event.parentId = r.parentId;
    return event;
  }

  /** List all session IDs that have events. */
  listSessions(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT sessionId FROM session_events").all() as Array<{ sessionId: string }>;
    return rows.map((r) => r.sessionId);
  }

  /** Enforce storage cap by deleting oldest events. */
  enforceStorageCap(): void {
    try {
      const countRow = this.db.prepare("SELECT COUNT(*) as c FROM session_events").get() as { c: number };
      if (countRow.c <= this.maxEvents) return;
      const excess = countRow.c - this.maxEvents;
      this.db.prepare("DELETE FROM session_events WHERE id IN (SELECT id FROM session_events ORDER BY id ASC LIMIT ?)").run(excess);
    } catch {
      // Non-fatal
    }
  }

  /** Save original system prompt snapshot for a model. */
  saveOriginalPrompt(snapshot: SystemPromptSnapshot): void {
    const safe = snapshot.model.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = join(this.promptDir, `${safe}.json`);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  }

  /** Get original system prompt snapshot for a model. */
  getOriginalPrompt(model: string): SystemPromptSnapshot | undefined {
    const safe = model.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = join(this.promptDir, `${safe}.json`);
    if (!existsSync(filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as SystemPromptSnapshot;
    } catch {
      return undefined;
    }
  }

  /** List all original system prompt snapshots. */
  listOriginalPrompts(): SystemPromptSnapshot[] {
    try {
      return readdirSync(this.promptDir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("session-"))
        .map((f) => {
          try {
            return JSON.parse(readFileSync(join(this.promptDir, f), "utf-8")) as SystemPromptSnapshot;
          } catch {
            return undefined;
          }
        })
        .filter((s): s is SystemPromptSnapshot => s !== undefined);
    } catch {
      return [];
    }
  }

  /** Save session system prompt (may differ from original in the future). */
  saveSessionPrompt(sessionId: string, prompt: string, model: string): void {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(this.promptDir, `session-${safe}.json`);
    writeFileSync(filePath, JSON.stringify({ sessionId, model, prompt, capturedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  }

  /** Get session system prompt. */
  getSessionPrompt(sessionId: string): { sessionId: string; model: string; prompt: string; capturedAt: string } | undefined {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(this.promptDir, `session-${safe}.json`);
    if (!existsSync(filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as { sessionId: string; model: string; prompt: string; capturedAt: string };
    } catch {
      return undefined;
    }
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
