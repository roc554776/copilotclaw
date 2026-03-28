/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface Message {
  id: string;
  channelId: string;
  sender: "user" | "agent";
  message: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  createdAt: string;
  archivedAt?: string | null;
}

export interface StoreOptions {
  /** Path to the SQLite database file. When omitted, uses in-memory database. */
  persistPath?: string;
  /** Path to legacy JSON store file for one-time migration. */
  legacyJsonPath?: string;
}

export class Store {
  private readonly db: Database.Database;

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

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channelId TEXT NOT NULL,
        sender TEXT NOT NULL CHECK(sender IN ('user', 'agent')),
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
    // Migration: add archivedAt column if missing
    const columns = this.db.pragma("table_info(channels)") as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "archivedAt")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN archivedAt TEXT");
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

  createChannel(): Channel {
    const channel: Channel = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT INTO channels (id, createdAt) VALUES (?, ?)").run(channel.id, channel.createdAt);
    return channel;
  }

  getChannel(channelId: string): Channel | undefined {
    return this.db.prepare("SELECT id, createdAt, archivedAt FROM channels WHERE id = ?").get(channelId) as Channel | undefined;
  }

  listChannels(options?: { includeArchived?: boolean }): Channel[] {
    if (options?.includeArchived) {
      return this.db.prepare("SELECT id, createdAt, archivedAt FROM channels ORDER BY createdAt ASC").all() as Channel[];
    }
    return this.db.prepare("SELECT id, createdAt, archivedAt FROM channels WHERE archivedAt IS NULL ORDER BY createdAt ASC").all() as Channel[];
  }

  archiveChannel(channelId: string): boolean {
    const result = this.db.prepare("UPDATE channels SET archivedAt = ? WHERE id = ? AND archivedAt IS NULL").run(new Date().toISOString(), channelId);
    return result.changes > 0;
  }

  unarchiveChannel(channelId: string): boolean {
    const result = this.db.prepare("UPDATE channels SET archivedAt = NULL WHERE id = ? AND archivedAt IS NOT NULL").run(channelId);
    return result.changes > 0;
  }

  addMessage(channelId: string, sender: "user" | "agent", message: string): Message | undefined {
    const ch = this.getChannel(channelId);
    if (ch === undefined) return undefined;
    const msg: Message = {
      id: randomUUID(),
      channelId,
      sender,
      message,
      createdAt: new Date().toISOString(),
    };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO messages (id, channelId, sender, message, createdAt) VALUES (?, ?, ?, ?, ?)").run(msg.id, msg.channelId, msg.sender, msg.message, msg.createdAt);
      if (sender === "user") {
        this.db.prepare("INSERT INTO pending_queue (channelId, messageId) VALUES (?, ?)").run(channelId, msg.id);
      }
    })();
    return msg;
  }

  listMessages(channelId: string, limit = 5): Message[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5;
    // Return newest N messages in reverse chronological order
    return this.db.prepare(
      "SELECT id, channelId, sender, message, createdAt FROM messages WHERE channelId = ? ORDER BY createdAt DESC LIMIT ?",
    ).all(channelId, safeLimit) as Message[];
  }

  drainPending(channelId: string): Message[] {
    let rows: Message[] = [];
    this.db.transaction(() => {
      rows = this.db.prepare(
        "SELECT m.id, m.channelId, m.sender, m.message, m.createdAt FROM pending_queue p JOIN messages m ON p.messageId = m.id WHERE p.channelId = ? ORDER BY p.id ASC",
      ).all(channelId) as Message[];
      if (rows.length > 0) {
        this.db.prepare("DELETE FROM pending_queue WHERE channelId = ?").run(channelId);
      }
    })();
    return rows;
  }

  peekOldestPending(channelId: string): Message | undefined {
    return this.db.prepare(
      "SELECT m.id, m.channelId, m.sender, m.message, m.createdAt FROM pending_queue p JOIN messages m ON p.messageId = m.id WHERE p.channelId = ? ORDER BY p.id ASC LIMIT 1",
    ).get(channelId) as Message | undefined;
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

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
