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
    this.insertStmt = this.db.prepare("INSERT INTO session_events (sessionId, type, timestamp, data, parentId) VALUES (?, ?, ?, ?, ?)");
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

  private readonly insertStmt;

  /** Append an event for a session. */
  appendEvent(sessionId: string, event: SessionEvent): void {
    this.insertStmt.run(sessionId, event.type, event.timestamp, JSON.stringify(event.data), event.parentId ?? null);
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
        .filter((f) => f.endsWith(".json") && !f.startsWith("effective-") && !f.startsWith("session-"))
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

  /** Save effective system prompt for a physical session. */
  saveEffectivePrompt(sessionId: string, prompt: string, model: string): void {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(this.promptDir, `effective-${safe}.json`);
    writeFileSync(filePath, JSON.stringify({ sessionId, model, prompt, capturedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  }

  /** Get effective system prompt for a physical session. */
  getEffectivePrompt(sessionId: string): { sessionId: string; model: string; prompt: string; capturedAt: string } | undefined {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Try new naming first, fall back to legacy "session-" prefix
    const effectivePath = join(this.promptDir, `effective-${safe}.json`);
    const legacyPath = join(this.promptDir, `session-${safe}.json`);
    const filePath = existsSync(effectivePath) ? effectivePath : existsSync(legacyPath) ? legacyPath : undefined;
    if (filePath === undefined) return undefined;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as { sessionId: string; model: string; prompt: string; capturedAt: string };
    } catch {
      return undefined;
    }
  }

  /** Aggregate token usage from assistant.usage events within a time range, grouped by model. */
  getTokenUsage(from: string, to: string): Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; multiplier: number }> {
    const rows = this.db.prepare(
      "SELECT data FROM session_events WHERE type = 'assistant.usage' AND timestamp >= ? AND timestamp <= ? ORDER BY id ASC",
    ).all(from, to) as Array<{ data: string }>;

    const byModel = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; multiplier: number }>();
    for (const row of rows) {
      try {
        const d = JSON.parse(row.data) as { model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; multiplier?: number };
        const model = d.model ?? "unknown";
        const entry = byModel.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, multiplier: d.multiplier ?? 0 };
        entry.inputTokens += d.inputTokens ?? 0;
        entry.outputTokens += d.outputTokens ?? 0;
        entry.cacheReadTokens += d.cacheReadTokens ?? 0;
        entry.cacheWriteTokens += d.cacheWriteTokens ?? 0;
        if (d.multiplier !== undefined) entry.multiplier = d.multiplier;
        byModel.set(model, entry);
      } catch {
        // skip malformed
      }
    }
    return Array.from(byModel.entries()).map(([model, usage]) => ({ model, ...usage }));
  }

  /** Aggregate token usage as a timeseries: split the time range into `points` buckets, each with per-model usage. */
  getTokenUsageTimeseries(
    from: string,
    to: string,
    points: number,
    movingAverageWindowSec?: number,
  ): Array<{
    timestamp: string;
    models: Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; multiplier: number }>;
    index: number;
    movingAverage?: number;
  }> {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return [];
    }
    const safePoints = Math.max(1, Math.min(points, 1000));
    const bucketMs = (toMs - fromMs) / safePoints;

    const rows = this.db.prepare(
      "SELECT timestamp, data FROM session_events WHERE type = 'assistant.usage' AND timestamp >= ? AND timestamp <= ? ORDER BY id ASC",
    ).all(from, to) as Array<{ timestamp: string; data: string }>;

    // Initialize buckets
    const buckets: Array<{
      timestamp: string;
      byModel: Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; multiplier: number }>;
    }> = [];
    for (let i = 0; i < safePoints; i++) {
      buckets.push({
        timestamp: new Date(fromMs + i * bucketMs).toISOString(),
        byModel: new Map(),
      });
    }

    // Distribute events into buckets
    for (const row of rows) {
      try {
        const ts = new Date(row.timestamp).getTime();
        const bucketIdx = Math.min(Math.floor((ts - fromMs) / bucketMs), safePoints - 1);
        if (bucketIdx < 0) continue;
        const d = JSON.parse(row.data) as { model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; multiplier?: number };
        const model = d.model ?? "unknown";
        const bucket = buckets[bucketIdx]!;
        const entry = bucket.byModel.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, multiplier: d.multiplier ?? 0 };
        entry.inputTokens += d.inputTokens ?? 0;
        entry.outputTokens += d.outputTokens ?? 0;
        entry.cacheReadTokens += d.cacheReadTokens ?? 0;
        entry.cacheWriteTokens += d.cacheWriteTokens ?? 0;
        if (d.multiplier !== undefined) entry.multiplier = d.multiplier;
        bucket.byModel.set(model, entry);
      } catch { /* skip malformed */ }
    }

    // Compute index per bucket using consumedTokens = (input - cacheRead) + (output - cacheWrite)
    const computeIndex = (byModel: Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; multiplier: number }>): number => {
      let idx = 0;
      for (const [, v] of byModel) {
        const consumed = (v.inputTokens - v.cacheReadTokens) + (v.outputTokens - v.cacheWriteTokens);
        idx += Math.max(v.multiplier, 0.1) * consumed;
      }
      return idx;
    };

    const result = buckets.map((b) => ({
      timestamp: b.timestamp,
      models: Array.from(b.byModel.entries()).map(([model, v]) => ({ model, ...v })),
      index: computeIndex(b.byModel),
    }));

    // Compute moving average if requested
    if (movingAverageWindowSec !== undefined && movingAverageWindowSec > 0) {
      const windowBuckets = Math.max(1, Math.round((movingAverageWindowSec * 1000) / bucketMs));
      for (let i = 0; i < result.length; i++) {
        const start = Math.max(0, i - windowBuckets + 1);
        let sum = 0;
        for (let j = start; j <= i; j++) {
          sum += result[j]!.index;
        }
        // Always divide by full window size — treat missing (pre-range) buckets as 0
        (result[i] as { movingAverage?: number }).movingAverage = sum / windowBuckets;
      }
    }

    return result as Array<{
      timestamp: string;
      models: Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; multiplier: number }>;
      index: number;
      movingAverage?: number;
    }>;
  }

  /** Get the latest quotaSnapshots from the most recent assistant.usage event. */
  getLatestQuota(): Record<string, unknown> | null {
    const row = this.db.prepare(
      "SELECT data FROM session_events WHERE type = 'assistant.usage' ORDER BY id DESC LIMIT 1",
    ).get() as { data: string } | undefined;
    if (row === undefined) return null;
    try {
      const d = JSON.parse(row.data) as Record<string, unknown>;
      if (d["quotaSnapshots"] !== undefined) {
        return { quotaSnapshots: d["quotaSnapshots"] };
      }
    } catch { /* ignore */ }
    return null;
  }

  /** Get distinct models seen in assistant.usage events with their latest billing multiplier. */
  getKnownModels(): Array<{ id: string; billing?: { multiplier?: number } }> {
    // Get the latest assistant.usage event for each distinct model
    const rows = this.db.prepare(
      "SELECT data FROM session_events WHERE type = 'assistant.usage' GROUP BY json_extract(data, '$.model') ORDER BY id DESC",
    ).all() as Array<{ data: string }>;
    const models: Array<{ id: string; billing?: { multiplier?: number } }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      try {
        const d = JSON.parse(row.data) as Record<string, unknown>;
        const model = d["model"] as string | undefined;
        if (model !== undefined && !seen.has(model)) {
          seen.add(model);
          models.push({ id: model });
        }
      } catch { /* ignore */ }
    }
    return models;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
