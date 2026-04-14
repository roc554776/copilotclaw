/**
 * In-memory store for agent intent declarations.
 * Records intent entries keyed by sessionId for later lookup.
 * Future tasks (API exposure, UI display, SQLite persistence) can extend
 * this without changing the recording interface.
 */

/**
 * An intent entry recorded via copilotclaw_intent tool.
 *
 * Note: toolCallId is declared as optional for future use. As of v0.70.0,
 * the ToolCallRequest interface in agent-manager.ts does not carry
 * toolCallId through to handlers, so it is not currently recorded.
 * When ToolCallRequest is extended to include toolCallId (for tracing/
 * correlation), the daemon handler should populate this field.
 */
export interface IntentEntry {
  sessionId: string;
  intent: string;
  timestamp: string;
  toolCallId?: string;
}

export class IntentsStore {
  private readonly entries = new Map<string, IntentEntry[]>();

  recordIntent(entry: IntentEntry): void {
    const existing = this.entries.get(entry.sessionId);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      this.entries.set(entry.sessionId, [entry]);
    }
  }

  getIntentsBySession(sessionId: string): readonly IntentEntry[] {
    return this.entries.get(sessionId) ?? [];
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Singleton instance for use across the gateway process. */
export const intentsStore = new IntentsStore();
