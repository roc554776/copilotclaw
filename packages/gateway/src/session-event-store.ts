import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionEvent {
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

const DEFAULT_MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB

export class SessionEventStore {
  private readonly dir: string;
  private readonly promptDir: string;
  private readonly maxStorageBytes: number;

  constructor(dataDir: string, maxStorageBytes?: number) {
    this.dir = join(dataDir, "events");
    this.promptDir = join(dataDir, "prompts");
    this.maxStorageBytes = maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES;
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.promptDir, { recursive: true });
  }

  private sessionFilePath(sessionId: string): string {
    // Sanitize sessionId to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.jsonl`);
  }

  /** Append an event for a session. */
  appendEvent(sessionId: string, event: SessionEvent): void {
    const filePath = this.sessionFilePath(sessionId);
    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
    this.maybeEnforceStorageCap();
  }

  /**
   * Periodically check and enforce the storage cap.
   * Runs the actual enforcement every ~100 appends to avoid stat overhead on every write.
   */
  private appendCount = 0;
  private maybeEnforceStorageCap(): void {
    this.appendCount++;
    if (this.appendCount % 100 === 0) {
      this.enforceStorageCap();
    }
  }

  /** Get all events for a session. */
  getEvents(sessionId: string): SessionEvent[] {
    const filePath = this.sessionFilePath(sessionId);
    if (!existsSync(filePath)) return [];
    try {
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      return lines.filter((l) => l.length > 0).map((l) => JSON.parse(l) as SessionEvent);
    } catch {
      return [];
    }
  }

  /** List all session IDs that have events. */
  listSessions(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -6)); // remove .jsonl
    } catch {
      return [];
    }
  }

  /** Enforce storage cap by deleting oldest session event files. */
  enforceStorageCap(): void {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const p = join(this.dir, f);
          const s = statSync(p);
          return { path: p, size: s.size, mtime: s.mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime); // oldest first

      let totalSize = files.reduce((sum, f) => sum + f.size, 0);
      for (const file of files) {
        if (totalSize <= this.maxStorageBytes) break;
        unlinkSync(file.path);
        totalSize -= file.size;
      }
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
}
