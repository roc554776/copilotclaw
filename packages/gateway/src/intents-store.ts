/**
 * IntentsStore: bridges copilotclaw_intent tool calls to SQLite persistence via Store.
 *
 * v0.79.0: migrated from in-memory Map to SQLite persistence via Store.recordIntent().
 * The store.db intents table (schema v5→v6) holds all intent entries across restarts.
 */

import type { Store } from "./store.js";

/**
 * An intent entry recorded via copilotclaw_intent tool.
 */
export interface IntentEntry {
  sessionId: string;
  channelId: string;
  agentId: string;
  agentDisplayName?: string | undefined;
  intent: string;
  timestamp: string;
  toolCallId?: string | undefined;
}

export class IntentsStore {
  private store: Store | null = null;

  /** Bind to the Store instance for SQLite persistence. Must be called once before use. */
  init(store: Store): void {
    this.store = store;
  }

  recordIntent(entry: IntentEntry): void {
    if (this.store !== null) {
      const storeEntry: Parameters<Store["recordIntent"]>[0] = {
        channelId: entry.channelId,
        sessionId: entry.sessionId,
        agentId: entry.agentId,
        intent: entry.intent,
        timestamp: entry.timestamp,
      };
      if (entry.agentDisplayName !== undefined) storeEntry.agentDisplayName = entry.agentDisplayName;
      if (entry.toolCallId !== undefined) storeEntry.toolCallId = entry.toolCallId;
      this.store.recordIntent(storeEntry);
    }
    // If store not yet initialized (should not happen in production), silently drop
  }

  listIntents(channelId: string, agentId: string, limit = 50): IntentEntry[] {
    if (this.store === null) return [];
    return this.store.listIntents(channelId, agentId, limit).map((row) => {
      const entry: IntentEntry = {
        sessionId: row.sessionId,
        channelId: row.channelId,
        agentId: row.agentId,
        intent: row.intent,
        timestamp: row.timestamp,
      };
      if (row.agentDisplayName !== null) entry.agentDisplayName = row.agentDisplayName;
      if (row.toolCallId !== null) entry.toolCallId = row.toolCallId;
      return entry;
    });
  }

  /** Legacy method — kept for backward compat with test code. Returns empty (use listIntents). */
  getIntentsBySession(_sessionId: string): readonly IntentEntry[] {
    // Cannot efficiently query by sessionId without index; return empty for legacy compat
    return [];
  }
}

/** Singleton instance for use across the gateway process. */
export const intentsStore = new IntentsStore();
