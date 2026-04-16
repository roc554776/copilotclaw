/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type AgentRole = "channel-operator" | "worker" | "subagent" | "unknown";

export interface MessageSenderMeta {
  agentId: string;
  agentDisplayName: string;
  agentRole: AgentRole;
}

export interface Message {
  id: string;
  channelId: string;
  sender: "user" | "agent" | "cron" | "system";
  senderMeta?: MessageSenderMeta;
  message: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  createdAt: string;
  archivedAt?: string | null;
  model?: string | null;
  draft?: string | null;
}

export interface StoreOptions {
  /** Path to the SQLite database file. When omitted, uses in-memory database. */
  persistPath?: string;
  /** Path to legacy JSON store file for one-time migration. */
  legacyJsonPath?: string;
}

export class Store {
  private readonly db: Database.Database;
  private onChannelListChange?: () => void;

  constructor(options?: StoreOptions) {
    const dbPath = options?.persistPath ?? ":memory:";
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();

    // One-time migration from legacy JSON store
    if (options?.legacyJsonPath !== undefined) {
      this.migrateFromJson(options.legacyJsonPath);
    }
  }

  private static readonly LATEST_STORE_VERSION = 6;

  private static readonly STORE_MIGRATIONS: Record<number, (db: Database.Database) => void> = {
    // v0 → v1: Add archivedAt column to channels
    0: (db) => {
      const columns = db.pragma("table_info(channels)") as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "archivedAt")) {
        db.exec("ALTER TABLE channels ADD COLUMN archivedAt TEXT");
      }
    },
    // v1 → v2: Replace CHECK constraint with message_senders FK table, add 'cron' sender
    1: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_senders (sender TEXT PRIMARY KEY);
        INSERT OR IGNORE INTO message_senders (sender) VALUES ('user'), ('agent'), ('cron'), ('system');
      `);
      const checkInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get() as { sql: string } | undefined;
      if (checkInfo?.sql && checkInfo.sql.includes("CHECK")) {
        db.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE messages_migrated (
            id TEXT PRIMARY KEY,
            channelId TEXT NOT NULL,
            sender TEXT NOT NULL REFERENCES message_senders(sender),
            message TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (channelId) REFERENCES channels(id)
          );
          INSERT INTO messages_migrated SELECT * FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_migrated RENAME TO messages;
          CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channelId, createdAt);
          PRAGMA foreign_keys = ON;
        `);
      }
    },
    // v2 → v3: Add model column to channels for per-channel model setting
    2: (db) => {
      const columns = db.pragma("table_info(channels)") as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "model")) {
        db.exec("ALTER TABLE channels ADD COLUMN model TEXT");
      }
    },
    // v3 → v4: Add draft column to channels for draft message persistence
    3: (db) => {
      const columns = db.pragma("table_info(channels)") as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "draft")) {
        db.exec("ALTER TABLE channels ADD COLUMN draft TEXT");
      }
    },
    // v4 → v5: Add senderMeta column to messages for agent identity tracking
    4: (db) => {
      const cols = db.pragma("table_info(messages)") as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "senderMeta")) {
        db.exec("ALTER TABLE messages ADD COLUMN senderMeta TEXT");
        // Backfill existing agent rows with default channel-operator meta
        db.exec(`UPDATE messages SET senderMeta = '{"agentId":"unknown","agentDisplayName":"Agent","agentRole":"channel-operator"}' WHERE sender = 'agent' AND senderMeta IS NULL`);
      }
    },
    // v5 → v6: Add intents table for copilotclaw_intent tool persistence (v0.79.0)
    5: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS intents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channelId TEXT NOT NULL,
          sessionId TEXT NOT NULL,
          agentId TEXT NOT NULL,
          agentDisplayName TEXT,
          intent TEXT NOT NULL,
          toolCallId TEXT,
          timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intents_channel_agent ON intents(channelId, agentId);
      `);
    },
  };

  private initSchema(): void {
    // Base schema (version 0)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_schema_version (
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_senders (
        sender TEXT PRIMARY KEY
      );
      INSERT OR IGNORE INTO message_senders (sender) VALUES ('user'), ('agent'), ('cron'), ('system');
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channelId TEXT NOT NULL,
        sender TEXT NOT NULL REFERENCES message_senders(sender),
        message TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (channelId) REFERENCES channels(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channelId, createdAt);
      CREATE TABLE IF NOT EXISTS pending_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channelId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        FOREIGN KEY (channelId) REFERENCES channels(id),
        FOREIGN KEY (messageId) REFERENCES messages(id)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_channel ON pending_queue(channelId);
    `);

    // Determine current version
    const row = this.db.prepare("SELECT version FROM store_schema_version LIMIT 1").get() as { version: number } | undefined;
    let version = row?.version ?? 0;

    // Apply sequential migrations
    while (version < Store.LATEST_STORE_VERSION) {
      const fn = Store.STORE_MIGRATIONS[version];
      if (fn === undefined) break;
      fn(this.db);
      version++;
    }

    // Persist version
    if (row === undefined) {
      this.db.prepare("INSERT INTO store_schema_version (version) VALUES (?)").run(version);
    } else if (version !== row.version) {
      this.db.prepare("UPDATE store_schema_version SET version = ?").run(version);
    }
  }

  /** Migrate data from legacy store.json if it exists and the DB is empty. */
  private migrateFromJson(jsonPath: string): void {
    if (!existsSync(jsonPath)) return;
    // Only migrate if DB has no channels (fresh DB)
    const count = this.db.prepare("SELECT COUNT(*) as c FROM channels").get() as { c: number };
    if (count.c > 0) return;

    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const snapshot = JSON.parse(raw) as {
        channels?: Array<{ id: string; createdAt: string }>;
        messages?: Record<string, Array<{ id: string; channelId: string; sender: string; message: string; createdAt: string }>>;
        pendingQueues?: Record<string, string[]>;
      };

      const insertChannel = this.db.prepare("INSERT OR IGNORE INTO channels (id, createdAt) VALUES (?, ?)");
      const insertMessage = this.db.prepare("INSERT OR IGNORE INTO messages (id, channelId, sender, message, createdAt) VALUES (?, ?, ?, ?, ?)");
      const insertPending = this.db.prepare("INSERT INTO pending_queue (channelId, messageId) VALUES (?, ?)");

      this.db.transaction(() => {
        for (const ch of snapshot.channels ?? []) {
          insertChannel.run(ch.id, ch.createdAt);
        }
        for (const [channelId, msgs] of Object.entries(snapshot.messages ?? {})) {
          for (const msg of msgs) {
            insertMessage.run(msg.id, channelId, msg.sender, msg.message, msg.createdAt);
          }
        }
        for (const [channelId, queue] of Object.entries(snapshot.pendingQueues ?? {})) {
          for (const msgId of queue) {
            insertPending.run(channelId, msgId);
          }
        }
      })();

      console.error(`[store] migrated ${snapshot.channels?.length ?? 0} channels from legacy JSON store`);
    } catch (err: unknown) {
      console.error(`[store] WARNING: failed to migrate legacy JSON store: ${String(err)}`);
    }
  }

  /** Register a callback to be called when the channel list changes (create/archive/unarchive/model update). */
  setOnChannelListChange(cb: () => void): void {
    this.onChannelListChange = cb;
  }

  /** Invoke the channel list change callback safely. Exceptions are caught and logged so
   *  callers (e.g. API handlers) are never disrupted by a misbehaving callback. */
  private notifyChannelListChange(): void {
    if (this.onChannelListChange === undefined) return;
    try {
      this.onChannelListChange();
    } catch (err) {
      console.error("channel list change callback failed", err);
    }
  }

  createChannel(): Channel {
    const channel: Channel = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT INTO channels (id, createdAt) VALUES (?, ?)").run(channel.id, channel.createdAt);
    this.notifyChannelListChange();
    return channel;
  }

  getChannel(channelId: string): Channel | undefined {
    return this.db.prepare("SELECT id, createdAt, archivedAt, model, draft FROM channels WHERE id = ?").get(channelId) as Channel | undefined;
  }

  listChannels(options?: { includeArchived?: boolean }): Channel[] {
    if (options?.includeArchived) {
      return this.db.prepare("SELECT id, createdAt, archivedAt, model, draft FROM channels ORDER BY createdAt ASC").all() as Channel[];
    }
    return this.db.prepare("SELECT id, createdAt, archivedAt, model, draft FROM channels WHERE archivedAt IS NULL ORDER BY createdAt ASC").all() as Channel[];
  }

  /** Update the model setting for a channel. Pass null to clear (use global default). */
  updateChannelModel(channelId: string, model: string | null): boolean {
    const result = this.db.prepare("UPDATE channels SET model = ? WHERE id = ?").run(model, channelId);
    if (result.changes > 0) this.notifyChannelListChange();
    return result.changes > 0;
  }

  /** Save a draft message for a channel. Pass null or empty string to clear. */
  saveDraft(channelId: string, draft: string | null): boolean {
    const value = draft !== null && draft.length > 0 ? draft : null;
    const result = this.db.prepare("UPDATE channels SET draft = ? WHERE id = ?").run(value, channelId);
    return result.changes > 0;
  }

  archiveChannel(channelId: string): boolean {
    const result = this.db.prepare("UPDATE channels SET archivedAt = ? WHERE id = ? AND archivedAt IS NULL").run(new Date().toISOString(), channelId);
    if (result.changes > 0) this.notifyChannelListChange();
    return result.changes > 0;
  }

  unarchiveChannel(channelId: string): boolean {
    const result = this.db.prepare("UPDATE channels SET archivedAt = NULL WHERE id = ? AND archivedAt IS NOT NULL").run(channelId);
    if (result.changes > 0) this.notifyChannelListChange();
    return result.changes > 0;
  }

  addMessage(channelId: string, sender: "user" | "agent" | "cron" | "system", message: string, senderMeta?: MessageSenderMeta): Message | undefined {
    const ch = this.getChannel(channelId);
    if (ch === undefined) return undefined;
    const msg: Message = {
      id: randomUUID(),
      channelId,
      sender,
      message,
      createdAt: new Date().toISOString(),
    };
    if (senderMeta !== undefined) {
      msg.senderMeta = senderMeta;
    }
    const senderMetaJson = senderMeta !== undefined ? JSON.stringify(senderMeta) : null;
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO messages (id, channelId, sender, message, createdAt, senderMeta) VALUES (?, ?, ?, ?, ?, ?)").run(msg.id, msg.channelId, msg.sender, msg.message, msg.createdAt, senderMetaJson);
      if (sender === "user" || sender === "cron" || sender === "system") {
        this.db.prepare("INSERT INTO pending_queue (channelId, messageId) VALUES (?, ?)").run(channelId, msg.id);
      }
    })();
    return msg;
  }

  private parseMessageRow(row: { id: string; channelId: string; sender: "user" | "agent" | "cron" | "system"; message: string; createdAt: string; senderMeta?: string | null }): Message {
    const msg: Message = {
      id: row.id,
      channelId: row.channelId,
      sender: row.sender,
      message: row.message,
      createdAt: row.createdAt,
    };
    if (row.senderMeta !== null && row.senderMeta !== undefined) {
      try {
        msg.senderMeta = JSON.parse(row.senderMeta) as MessageSenderMeta;
      } catch {
        // Invalid JSON — omit senderMeta
      }
    }
    return msg;
  }

  listMessages(channelId: string, limit = 5, before?: string): Message[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5;
    // Return newest N messages in reverse chronological order.
    // When `before` is specified, return messages older than the given message ID (cursor-based pagination).
    type RawRow = { id: string; channelId: string; sender: "user" | "agent" | "cron" | "system"; message: string; createdAt: string; senderMeta?: string | null };
    if (before !== undefined) {
      const rows = this.db.prepare(
        "SELECT id, channelId, sender, message, createdAt, senderMeta FROM messages WHERE channelId = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC LIMIT ?",
      ).all(channelId, before, safeLimit) as RawRow[];
      return rows.map((r) => this.parseMessageRow(r));
    }
    const rows = this.db.prepare(
      "SELECT id, channelId, sender, message, createdAt, senderMeta FROM messages WHERE channelId = ? ORDER BY rowid DESC LIMIT ?",
    ).all(channelId, safeLimit) as RawRow[];
    return rows.map((r) => this.parseMessageRow(r));
  }

  drainPending(channelId: string): Message[] {
    type RawRow = { id: string; channelId: string; sender: "user" | "agent" | "cron" | "system"; message: string; createdAt: string; senderMeta?: string | null };
    let rawRows: RawRow[] = [];
    this.db.transaction(() => {
      rawRows = this.db.prepare(
        "SELECT m.id, m.channelId, m.sender, m.message, m.createdAt, m.senderMeta FROM pending_queue p JOIN messages m ON p.messageId = m.id WHERE p.channelId = ? ORDER BY p.id ASC",
      ).all(channelId) as RawRow[];
      if (rawRows.length > 0) {
        this.db.prepare("DELETE FROM pending_queue WHERE channelId = ?").run(channelId);
      }
    })();
    return rawRows.map((r) => this.parseMessageRow(r));
  }

  peekOldestPending(channelId: string): Message | undefined {
    type RawRow = { id: string; channelId: string; sender: "user" | "agent" | "cron" | "system"; message: string; createdAt: string; senderMeta?: string | null };
    const row = this.db.prepare(
      "SELECT m.id, m.channelId, m.sender, m.message, m.createdAt, m.senderMeta FROM pending_queue p JOIN messages m ON p.messageId = m.id WHERE p.channelId = ? ORDER BY p.id ASC LIMIT 1",
    ).get(channelId) as RawRow | undefined;
    if (row === undefined) return undefined;
    return this.parseMessageRow(row);
  }

  flushPending(channelId: string): number {
    const result = this.db.prepare("DELETE FROM pending_queue WHERE channelId = ?").run(channelId);
    return result.changes;
  }

  pendingCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT channelId, COUNT(*) as cnt FROM pending_queue GROUP BY channelId").all() as Array<{ channelId: string; cnt: number }>;
    const counts: Record<string, number> = {};
    // Include channels with 0 pending
    for (const ch of this.listChannels()) {
      counts[ch.id] = 0;
    }
    for (const row of rows) {
      counts[row.channelId] = row.cnt;
    }
    return counts;
  }

  hasPending(channelId: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM pending_queue WHERE channelId = ?").get(channelId) as { cnt: number } | undefined;
    return row !== undefined && row.cnt > 0;
  }

  /** Check if a cron message with the given prefix is already pending for a channel. */
  hasPendingCronMessage(channelId: string, cronIdPrefix: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM pending_queue p JOIN messages m ON p.messageId = m.id WHERE p.channelId = ? AND m.sender = 'cron' AND m.message LIKE ?",
    ).get(channelId, `${cronIdPrefix}%`) as { cnt: number } | undefined;
    return row !== undefined && row.cnt > 0;
  }

  // --- Intents (copilotclaw_intent tool persistence, v0.79.0) ---

  /** Record a new intent entry from copilotclaw_intent tool call. */
  recordIntent(entry: {
    channelId: string;
    sessionId: string;
    agentId: string;
    agentDisplayName?: string;
    intent: string;
    toolCallId?: string;
    timestamp: string;
  }): void {
    this.db.prepare(
      `INSERT INTO intents (channelId, sessionId, agentId, agentDisplayName, intent, toolCallId, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.channelId,
      entry.sessionId,
      entry.agentId,
      entry.agentDisplayName ?? null,
      entry.intent,
      entry.toolCallId ?? null,
      entry.timestamp,
    );
  }

  /** List intent entries for a channel and agent, newest first. */
  listIntents(channelId: string, agentId: string, limit = 50): Array<{
    id: number;
    channelId: string;
    sessionId: string;
    agentId: string;
    agentDisplayName: string | null;
    intent: string;
    toolCallId: string | null;
    timestamp: string;
  }> {
    return this.db.prepare(
      `SELECT id, channelId, sessionId, agentId, agentDisplayName, intent, toolCallId, timestamp
       FROM intents WHERE channelId = ? AND agentId = ? ORDER BY id DESC LIMIT ?`
    ).all(channelId, agentId, limit) as Array<{
      id: number;
      channelId: string;
      sessionId: string;
      agentId: string;
      agentDisplayName: string | null;
      intent: string;
      toolCallId: string | null;
      timestamp: string;
    }>;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
