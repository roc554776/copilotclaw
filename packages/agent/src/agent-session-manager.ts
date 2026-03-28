import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CopilotClient, type CopilotSession, approveAll } from "@github/copilot-sdk";
import { adaptCopilotSession } from "./copilot-session-adapter.js";
import { runSessionLoop } from "./session-loop.js";
import { createChannelTools, type SubagentCompletionInfo } from "./tools/channel.js";

// The only tool exclusive to the channel-operator (parent agent).
// Subagents (worker) never receive copilotclaw_wait — they use
// copilotclaw_send_message and copilotclaw_list_messages which are shared.
// Used to gate onPostToolUse reminder/notification injection:
// the SDK hook system provides no mechanism to distinguish parent vs subagent
// tool calls (sessionId is always the same, no parentToolCallId in hook inputs),
// so we gate on the one tool name that is parent-exclusive.
const PARENT_ONLY_TOOL = "copilotclaw_wait";

// --- Custom Agent definitions ---

const CHANNEL_OPERATOR_PROMPT =
  "╔══════════════════════════════════════════════════════════════════╗\n" +
  "║ CRITICAL — DEADLOCK PREVENTION                                 ║\n" +
  "║                                                                ║\n" +
  "║ You MUST call copilotclaw_wait whenever you have nothing to    ║\n" +
  "║ do, even temporarily. NOT calling copilotclaw_wait causes an   ║\n" +
  "║ IRRECOVERABLE DEADLOCK — the session becomes permanently       ║\n" +
  "║ unresponsive and CANNOT be recovered. This is catastrophic.    ║\n" +
  "║ NEVER stop, idle, or end your turn without first calling       ║\n" +
  "║ copilotclaw_wait.                                              ║\n" +
  "╚══════════════════════════════════════════════════════════════════╝\n" +
  "\n" +
  "You are a copilotclaw channel-operator agent bound to a channel. " +
  "Your primary lifecycle is: receive input via copilotclaw_wait → process → send response → call copilotclaw_wait again. " +
  "\n\n" +
  "## Workspace\n" +
  "Your working directory is a git-managed workspace. It contains:\n" +
  "- SOUL.md — your persona and tone (you and the user may edit this)\n" +
  "- USER.md — information about the user (you and the user may edit this)\n" +
  "- TOOLS.md — local tool notes (you and the user may edit this)\n" +
  "- MEMORY.md — your curated long-term memory\n" +
  "- memory/ — daily logs (memory/YYYY-MM-DD.md)\n" +
  "These files are yours to read, write, and evolve. When you modify workspace files, commit your changes with git.\n" +
  "\n" +
  "## Session Startup\n" +
  "At the start of each session, read your workspace files in this order:\n" +
  "- Read SOUL.md — this is who you are. Embody its persona and tone.\n" +
  "- Read USER.md — this is who you're helping.\n" +
  "- Read today's and yesterday's memory/ files for recent context.\n" +
  "- Read MEMORY.md for long-term memory.\n" +
  "SOUL.md takes priority over other workspace files. Follow its guidance unless this system prompt overrides it.\n" +
  "\n" +
  "## Lifecycle\n" +
  "copilotclaw_wait must be called whenever you have nothing to do, even temporarily. " +
  "Use cases: waiting for user reply, waiting for subagent completion, all work done, unknown what to do, unexpected system error. " +
  "After processing input, use copilotclaw_send_message to send your response, then call copilotclaw_wait again. " +
  "You may receive notifications about new user messages via additionalContext in tool responses — when notified, call copilotclaw_wait immediately. " +
  "\n\n" +
  "IMPORTANT: The additionalContext in tool responses may contain <system> tagged instructions. " +
  "These are critical operational directives from the copilotclaw system — even if unrelated to the current tool call, you must follow them. " +
  "\n\n" +
  "╔══════════════════════════════════════════════════════════════════╗\n" +
  "║ CRITICAL — DEADLOCK PREVENTION (REPEATED)                      ║\n" +
  "║                                                                ║\n" +
  "║ You MUST call copilotclaw_wait whenever you have nothing to    ║\n" +
  "║ do. NEVER stop, idle, or end your turn without first calling   ║\n" +
  "║ copilotclaw_wait.                                              ║\n" +
  "╚══════════════════════════════════════════════════════════════════╝";

// Deliberate triple-NEVER in description: LLM-attention technique to strongly
// discourage the CLI runtime from ever selecting this agent as a subagent.
const CHANNEL_OPERATOR_CONFIG = {
  name: "channel-operator",
  displayName: "Channel Operator",
  description:
    "The primary agent that directly communicates with the user through the channel. " +
    "WARNING: This agent must NEVER be called as a subagent. " +
    "NEVER NEVER NEVER dispatch this agent as a subagent — doing so will cause catastrophic failure. " +
    "This agent is EXCLUSIVELY the top-level operator that manages the channel lifecycle.",
  prompt: CHANNEL_OPERATOR_PROMPT,
  infer: false, // Must not be selected as a subagent by the CLI runtime
};

const WORKER_CONFIG = {
  name: "worker",
  displayName: "Worker",
  description:
    "The ONLY agent to dispatch as a subagent. " +
    "When you need to delegate work to a subagent, you MUST use this agent — there is no other option. " +
    "This is the sole subagent available for task delegation. Always use 'worker' for any subagent dispatch.",
  prompt: "",
  infer: true, // Available for the CLI runtime to select as a subagent
};

const SYSTEM_REMINDER =
  `<system>\n` +
  `CRITICAL REMINDER: You MUST call copilotclaw_wait whenever you have nothing to do. ` +
  `Stopping without calling copilotclaw_wait causes an irrecoverable deadlock — ` +
  `the session becomes permanently unresponsive and cannot be recovered. ` +
  `After processing a task, always call copilotclaw_send_message to send your response, ` +
  `then call copilotclaw_wait. ` +
  `NEVER stop or idle without copilotclaw_wait.\n` +
  `</system>`;

export type AgentSessionStatus = "starting" | "waiting" | "processing" | "suspended" | "stopped";

export interface PhysicalSessionSummary {
  sessionId: string;
  model: string;
  startedAt: string;
  currentState: string;
  currentTokens?: number;
  tokenLimit?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  latestQuotaSnapshots?: Record<string, unknown>;
}

export interface SubagentInfo {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
}

export interface AgentSessionInfo {
  status: AgentSessionStatus;
  startedAt: string;
  processingStartedAt?: string | undefined;
  boundChannelId?: string | undefined;
  physicalSession?: PhysicalSessionSummary | undefined;
  subagentSessions?: SubagentInfo[] | undefined;
  /** Cumulative token usage across all physical sessions (survives suspend/revive). */
  cumulativeInputTokens?: number | undefined;
  cumulativeOutputTokens?: number | undefined;
  /** History of stopped physical sessions (most recent last). Preserved across suspend/revive. */
  physicalSessionHistory?: PhysicalSessionSummary[] | undefined;
}

interface AgentSessionEntry {
  sessionId: string;
  copilotSessionId?: string | undefined; // SDK session ID for resumeSession
  copilotSession?: CopilotSession | undefined; // Live SDK session for getMessages()
  info: AgentSessionInfo;
  client: CopilotClient;
  abortController: AbortController;
  sessionPromise: Promise<void>;
  generation: number;
}

export interface AgentSessionManagerOptions {
  gatewayBaseUrl: string;
  staleTimeoutMs?: number;
  maxSessionAgeMs?: number;
  fetch?: typeof globalThis.fetch;
  model?: string;
  zeroPremium?: boolean;
  debugMockCopilotUnsafeTools?: boolean;
  workingDirectory?: string;
  /** Path to persist channel bindings and suspended session state across agent restarts. */
  persistPath?: string;
  /** GitHub token for authentication (from profile auth config). When set, passed to CopilotClient. */
  githubToken?: string;
}

interface SessionSnapshot {
  sessionId: string;
  copilotSessionId?: string | undefined;
  boundChannelId?: string | undefined;
  startedAt: string;
  cumulativeInputTokens?: number | undefined;
  cumulativeOutputTokens?: number | undefined;
  physicalSessionHistory?: PhysicalSessionSummary[] | undefined;
}

interface BindingSnapshot {
  sessions: SessionSnapshot[];
}

export interface StartSessionOptions {
  boundChannelId?: string;
  /** SDK session ID to resume instead of creating a new one. Used by deferred resume. */
  copilotSessionId?: string;
}

const DEFAULT_STALE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSION_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// Session failure backoff: if a session fails within this time after starting,
// the channel enters a backoff period to prevent retry storms.
const RAPID_FAILURE_THRESHOLD_MS = 30_000; // session lasted < 30s = rapid failure
const BACKOFF_DURATION_MS = 60_000; // wait 60s before retrying

export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSessionEntry>();
  private readonly channelBindings = new Map<string, string>(); // channelId → sessionId
  private readonly gatewayBaseUrl: string;
  private readonly staleTimeoutMs: number;
  private readonly maxSessionAgeMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly model: string | undefined;
  private readonly zeroPremium: boolean;
  private readonly debugMockCopilotUnsafeTools: boolean;
  private readonly workingDirectory: string | undefined;
  private readonly persistPath: string | undefined;
  private readonly githubToken: string | undefined;
  private generationCounter = 0;
  // Backoff tracking: channelId → timestamp when backoff expires.
  // Intentionally in-memory only — not persisted across agent restarts.
  // On restart the agent process is fresh and the failure condition may
  // have been resolved, so retrying immediately is acceptable.
  private readonly channelBackoff = new Map<string, number>();

  constructor(options: AgentSessionManagerOptions) {
    this.gatewayBaseUrl = options.gatewayBaseUrl;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.maxSessionAgeMs = options.maxSessionAgeMs ?? DEFAULT_MAX_SESSION_AGE_MS;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.model = options.model;
    this.zeroPremium = options.zeroPremium ?? false;
    this.debugMockCopilotUnsafeTools = options.debugMockCopilotUnsafeTools ?? false;
    this.workingDirectory = options.workingDirectory;
    this.persistPath = options.persistPath;
    this.githubToken = options.githubToken;
    this.loadBindings();
  }

  /** Create a CopilotClient with the configured auth token (if any). */
  private createClient(): CopilotClient {
    if (this.githubToken !== undefined) {
      return new CopilotClient({ githubToken: this.githubToken });
    }
    return new CopilotClient();
  }

  /** Load persisted channel bindings and restore suspended sessions. */
  private loadBindings(): void {
    if (this.persistPath === undefined) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" || parsed === null ||
        !("sessions" in parsed) || !Array.isArray((parsed as { sessions: unknown }).sessions)
      ) {
        console.error(`[agent] WARNING: invalid bindings file at ${this.persistPath}, ignoring`);
        return;
      }
      const sessions = (parsed as { sessions: unknown[] }).sessions;
      for (const raw of sessions) {
        if (typeof raw !== "object" || raw === null) continue;
        const s = raw as Record<string, unknown>;
        if (typeof s["sessionId"] !== "string" || typeof s["startedAt"] !== "string") continue;
        const entry: AgentSessionEntry = {
          sessionId: s["sessionId"],
          copilotSessionId: typeof s["copilotSessionId"] === "string" ? s["copilotSessionId"] : undefined,
          info: {
            status: "suspended",
            startedAt: s["startedAt"],
            boundChannelId: typeof s["boundChannelId"] === "string" ? s["boundChannelId"] : undefined,
            cumulativeInputTokens: typeof s["cumulativeInputTokens"] === "number" ? s["cumulativeInputTokens"] : undefined,
            cumulativeOutputTokens: typeof s["cumulativeOutputTokens"] === "number" ? s["cumulativeOutputTokens"] : undefined,
            physicalSessionHistory: Array.isArray(s["physicalSessionHistory"]) ? s["physicalSessionHistory"] as PhysicalSessionSummary[] : undefined,
          },
          // Placeholder client — suspended sessions don't use it. Replaced on revive.
          client: this.createClient(),
          abortController: new AbortController(),
          sessionPromise: Promise.resolve(),
          generation: ++this.generationCounter,
        };
        this.sessions.set(entry.sessionId, entry);
        if (entry.info.boundChannelId !== undefined) {
          this.channelBindings.set(entry.info.boundChannelId, entry.sessionId);
        }
      }
      if (sessions.length > 0) {
        console.error(`[agent] restored ${sessions.length} suspended session binding(s) from disk`);
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // normal on first run
      console.error(`[agent] WARNING: could not load bindings from ${this.persistPath}: ${String(err)}`);
    }
  }

  /** Persist channel bindings and suspended session state to disk. */
  private saveBindings(): void {
    if (this.persistPath === undefined) return;
    const sessions: SessionSnapshot[] = [];
    for (const [, entry] of this.sessions) {
      if (entry.info.status === "suspended" && entry.info.boundChannelId !== undefined) {
        sessions.push({
          sessionId: entry.sessionId,
          copilotSessionId: entry.copilotSessionId,
          boundChannelId: entry.info.boundChannelId,
          startedAt: entry.info.startedAt,
          cumulativeInputTokens: entry.info.cumulativeInputTokens,
          cumulativeOutputTokens: entry.info.cumulativeOutputTokens,
          physicalSessionHistory: entry.info.physicalSessionHistory,
        });
      }
    }
    const snapshot: BindingSnapshot = { sessions };
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
      renameSync(tmp, this.persistPath);
    } catch (err: unknown) {
      console.error(`[agent] WARNING: could not save bindings to ${this.persistPath}: ${String(err)}`);
    }
  }

  /** Get the first active CopilotClient (for server-level RPCs like quota/models). */
  private getActiveClient(): CopilotClient | undefined {
    for (const [, entry] of this.sessions) {
      if (entry.info.status !== "suspended") return entry.client;
    }
    return undefined;
  }

  async getQuota(): Promise<Record<string, unknown> | null> {
    const client = this.getActiveClient();
    if (client === undefined) return null;
    try {
      return await client.rpc.account.getQuota() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      console.error("[agent] getQuota error:", err);
      return null;
    }
  }

  async getModels(): Promise<Record<string, unknown> | null> {
    const client = this.getActiveClient();
    if (client === undefined) return null;
    try {
      return await client.rpc.models.list() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      console.error("[agent] getModels error:", err);
      return null;
    }
  }

  /** Get session messages (conversation history) from the SDK for a given copilot session ID. */
  async getSessionMessages(copilotSessionId: string): Promise<unknown[] | null> {
    for (const [, entry] of this.sessions) {
      if (entry.copilotSessionId === copilotSessionId && entry.copilotSession !== undefined) {
        try {
          return await entry.copilotSession.getMessages();
        } catch (err: unknown) {
          console.error("[agent] getSessionMessages error:", err);
          return null;
        }
      }
    }
    return null;
  }

  getSessionStatuses(): Record<string, AgentSessionInfo> {
    const result: Record<string, AgentSessionInfo> = {};
    for (const [sessionId, entry] of this.sessions) {
      result[sessionId] = { ...entry.info };
    }
    return result;
  }

  getSessionStatus(sessionId: string): AgentSessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return undefined;
    return { ...entry.info };
  }

  hasSessionForChannel(channelId: string): boolean {
    return this.channelBindings.has(channelId);
  }

  /** Check if a channel has an active (non-suspended) session. */
  hasActiveSessionForChannel(channelId: string): boolean {
    const sessionId = this.channelBindings.get(channelId);
    if (sessionId === undefined) return false;
    const entry = this.sessions.get(sessionId);
    return entry !== undefined && entry.info.status !== "suspended";
  }

  /** Check if a channel is in backoff period after a rapid session failure. */
  isChannelInBackoff(channelId: string): boolean {
    const expiresAt = this.channelBackoff.get(channelId);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.channelBackoff.delete(channelId);
      return false;
    }
    return true;
  }

  startSession(options?: StartSessionOptions): string {
    const boundChannelId = options?.boundChannelId;

    // If channel already has a suspended session, revive it with a new physical session
    if (boundChannelId !== undefined && this.channelBindings.has(boundChannelId)) {
      const existingId = this.channelBindings.get(boundChannelId)!;
      const existing = this.sessions.get(existingId);
      if (existing !== undefined && existing.info.status === "suspended") {
        this.reviveSession(existing, options?.copilotSessionId);
        return existingId;
      }
      // Already active — return existing
      return existingId;
    }

    const sessionId = randomUUID();
    const abortController = new AbortController();
    const client = this.createClient();
    const generation = ++this.generationCounter;
    const entry: AgentSessionEntry = {
      sessionId,
      info: {
        status: "starting",
        startedAt: new Date().toISOString(),
      },
      client,
      abortController,
      sessionPromise: Promise.resolve(),
      generation,
    };

    if (boundChannelId !== undefined) {
      entry.info.boundChannelId = boundChannelId;
      this.channelBindings.set(boundChannelId, sessionId);
    }

    // Propagate SDK session ID for resume before runSession reads it
    if (options?.copilotSessionId !== undefined) {
      entry.copilotSessionId = options.copilotSessionId;
    }

    entry.sessionPromise = this.attachSessionLifecycle(entry, client);
    this.sessions.set(sessionId, entry);
    return sessionId;
  }

  /** Ensure workspace directory has required files and git init before session start. */
  private ensureWorkspaceReady(): void {
    if (this.workingDirectory === undefined) return;
    const ws = this.workingDirectory;
    mkdirSync(ws, { recursive: true });

    // Git init if not already initialized and git is available
    if (!existsSync(join(ws, ".git"))) {
      const check = spawnSync("git", ["--version"], { encoding: "utf-8", stdio: "pipe" });
      if (check.status === 0) {
        spawnSync("git", ["init"], { cwd: ws, encoding: "utf-8", stdio: "pipe" });
      }
    }

    // Create missing bootstrap files (minimal — templates live in gateway)
    const defaults: Record<string, string> = {
      "SOUL.md": "# SOUL.md - Who You Are\n\n_Customize this file to define your agent's persona._\n",
      "USER.md": "# USER.md - About the User\n\n_Fill in information about yourself._\n",
      "TOOLS.md": "# TOOLS.md - Tool Notes\n\n_Keep local notes about tools and configurations here._\n",
      "MEMORY.md": "# MEMORY.md - Long-Term Memory\n\n_Your curated long-term memory._\n",
    };
    for (const [file, content] of Object.entries(defaults)) {
      const p = join(ws, file);
      if (!existsSync(p)) writeFileSync(p, content, "utf-8");
    }
    const memDir = join(ws, "memory");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
    const gitkeep = join(memDir, ".gitkeep");
    if (!existsSync(gitkeep)) writeFileSync(gitkeep, "", "utf-8");

    // Initial commit if no commits yet
    if (existsSync(join(ws, ".git"))) {
      const logCheck = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf-8", stdio: "pipe" });
      if (logCheck.status !== 0) {
        spawnSync("git", ["add", "-A"], { cwd: ws, encoding: "utf-8", stdio: "pipe" });
        const diffIndex = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ws, encoding: "utf-8", stdio: "pipe" });
        if (diffIndex.status !== 0) {
          spawnSync("git", ["commit", "-m", "Initial workspace setup"], { cwd: ws, encoding: "utf-8", stdio: "pipe" });
        }
      }
    }
  }

  private async runSession(entry: AgentSessionEntry): Promise<void> {
    const channelId = entry.info.boundChannelId;
    if (channelId === undefined) {
      throw new Error("channel-less sessions not yet supported");
    }

    // Ensure workspace is ready before starting the physical session
    this.ensureWorkspaceReady();

    // Queue for subagent completion events, drained by wait and onPostToolUse
    const subagentCompletionQueue: SubagentCompletionInfo[] = [];

    const { sendMessage, wait, listMessages } = createChannelTools({
      gatewayBaseUrl: this.gatewayBaseUrl,
      channelId,
      abortSignal: entry.abortController.signal,
      fetch: this.fetchFn,
      onStatusChange: (status) => {
        entry.info.status = status;
        if (status === "processing") {
          entry.info.processingStartedAt = new Date().toISOString();
        }
      },
      drainSubagentCompletions: () => {
        const items = [...subagentCompletionQueue];
        subagentCompletionQueue.length = 0;
        return items;
      },
    });

    const gatewayBaseUrl = this.gatewayBaseUrl;
    const signal = entry.abortController.signal;

    // State for periodic system prompt reinforcement via onPostToolUse additionalContext.
    // Tracks context usage percentage to avoid reminding on every tool call.
    const reminderState = {
      needsReminder: false,
      lastReminderPercent: 0,
      currentUsagePercent: 0,
    };

    const sessionConfig = {
      onPermissionRequest: approveAll,
      tools: [sendMessage, wait, listMessages],
      hooks: {
        onPostToolUse: async (input: { toolName: string }) => {
          try {
            if (signal.aborted) return;

            // Only fire for the parent agent (channel-operator).
            // copilotclaw_wait is the ONLY tool exclusive to the parent —
            // copilotclaw_send_message and copilotclaw_list_messages are shared with
            // subagents (worker), and the SDK hook system has no way to distinguish
            // parent vs subagent calls (same sessionId, no parentToolCallId in hooks).
            const isParentAgentTool = input.toolName === PARENT_ONLY_TOOL;
            if (!isParentAgentTool) return;

            const parts: string[] = [];

            // Consume needsReminder synchronously before any await to prevent
            // concurrent hook calls from sending duplicate reminders (TOCTOU).
            const shouldRemind = reminderState.needsReminder;
            if (shouldRemind) {
              reminderState.needsReminder = false;
              reminderState.lastReminderPercent = reminderState.currentUsagePercent;
            }

            // Check for pending user messages
            const fetchOpts: RequestInit = { signal };
            const res = await this.fetchFn(`${gatewayBaseUrl}/api/channels/${channelId}/messages/pending/peek`, fetchOpts);
            if (res.status === 200) {
              parts.push(`[NOTIFICATION] New user message is available on the channel. Call copilotclaw_wait immediately to read it.`);
            }

            // Peek (don't drain) subagent completions — wait is the sole drain point
            // to avoid double-reporting from two consumers draining the same queue.
            if (subagentCompletionQueue.length > 0) {
              const notices = subagentCompletionQueue.map((c) =>
                `${c.agentName} ${c.status}${c.error ? ` (error: ${c.error})` : ""}` +
                `${c.totalTokens !== undefined ? ` [tokens: ${c.totalTokens}]` : ""}` +
                `${c.durationMs !== undefined ? ` [${c.durationMs}ms]` : ""}`
              );
              parts.push(`[SUBAGENT UPDATE] ${notices.join("; ")} — call copilotclaw_wait to get full details.`);
            }

            if (shouldRemind) {
              parts.push(SYSTEM_REMINDER);
            }

            if (parts.length > 0) {
              return { additionalContext: parts.join("\n\n") };
            }
          } catch (err: unknown) {
            // AbortError is expected when session is stopped — suppress silently.
            // Log other errors so production issues in the hook are visible.
            if (!(err instanceof Error && err.name === "AbortError")) {
              console.error("[agent] onPostToolUse hook error:", err);
            }
          }
          return;
        },
      },
      // Debug mock copilot unsafe tools mode: restrict to safe built-in tools + copilotclaw_* + debug mock tools
      ...(this.debugMockCopilotUnsafeTools ? {
        availableTools: [
          "copilotclaw_send_message",
          "copilotclaw_wait",
          "copilotclaw_list_messages",
          "copilotclaw_debug_mock_read_file",
          "copilotclaw_debug_mock_write_file",
          "copilotclaw_debug_mock_shell_exec",
          "WebFetch",
          "WebSearch",
        ],
      } : {}),
    };

    // Resolve model dynamically from SDK model list
    const resolvedModel = await this.resolveModel(entry.client);

    // Build systemMessage with transform callbacks to capture original system prompt.
    // Each known section gets a pass-through callback that captures the content and
    // forwards it to the gateway. The SDK's extractTransformCallbacks() detects these
    // callbacks and sends action: "transform" in the wire payload, causing the CLI to
    // call back via systemMessage.transform RPC when the system prompt is constructed.
    const capturedSections: Record<string, string> = {};
    const makeSectionCapture = (sectionId: string) => async (content: string) => {
      capturedSections[sectionId] = content;
      return content; // Return unchanged — pass-through
    };
    const KNOWN_SECTIONS = [
      "identity", "tone", "tool_efficiency", "environment_context",
      "code_change_rules", "guidelines", "safety", "tool_instructions",
      "custom_instructions", "last_instructions",
    ];
    const sections: Record<string, { action: (content: string) => Promise<string> }> = {};
    for (const id of KNOWN_SECTIONS) {
      sections[id] = { action: makeSectionCapture(id) };
    }

    // Resume existing SDK session or create new one
    const baseConfig = {
      model: resolvedModel,
      ...(this.workingDirectory !== undefined ? { workingDirectory: this.workingDirectory } : {}),
      ...sessionConfig,
      systemMessage: {
        mode: "customize" as const,
        sections,
      },
      // Custom agents: channel-operator (parent, infer:false) + worker (subagent, infer:true)
      customAgents: [
        { ...CHANNEL_OPERATOR_CONFIG, tools: null },
        { ...WORKER_CONFIG, tools: null },
      ],
      agent: CHANNEL_OPERATOR_CONFIG.name,
    };
    const session = entry.copilotSessionId !== undefined
      ? await entry.client.resumeSession(entry.copilotSessionId, baseConfig)
      : await entry.client.createSession(baseConfig);

    // After session creation, the CLI will call systemMessage.transform RPC for each
    // section that has action: "transform". The callbacks above capture each section's
    // content. Post the combined prompt to the gateway for storage and display.
    const postCapturedPrompt = () => {
      const combined = Object.values(capturedSections).filter(Boolean).join("\n\n");
      if (combined.length > 0) {
        this.postToGateway("/api/system-prompts/original", {
          model: resolvedModel,
          prompt: combined,
          capturedAt: new Date().toISOString(),
        });
        this.postToGateway("/api/system-prompts/session", {
          sessionId: session.sessionId,
          model: resolvedModel,
          prompt: combined,
        });
      }
    };
    // The transform callbacks fire during session.send() when the CLI builds the system
    // prompt. Post once after the first assistant.turn_start to know the prompt has been built.
    // For resumed sessions, the CLI may not re-fire transform RPCs; in that case
    // capturedSections stays empty and postCapturedPrompt is a no-op (acceptable).
    let promptPosted = false;
    session.on("assistant.turn_start", () => {
      if (promptPosted) return;
      promptPosted = true;
      postCapturedPrompt();
    });

    entry.copilotSessionId = session.sessionId;
    entry.copilotSession = session;
    entry.info.status = "waiting";

    // Forward all session events to gateway for observability
    const forwardEvent = (type: string, event?: { timestamp?: string; data?: unknown }) => {
      const payload: Record<string, unknown> = {
        sessionId: session.sessionId,
        type,
        timestamp: event?.timestamp ?? new Date().toISOString(),
        data: (typeof event?.data === "object" && event.data !== null) ? event.data : {},
      };
      this.postToGateway("/api/session-events", payload);
    };

    // Subscribe to key SDK events and forward them
    const forwardedEvents = [
      "session.idle", "session.error", "session.usage_info", "session.model_change",
      "session.compaction_start", "session.compaction_complete", "session.title_changed",
      "tool.execution_start", "tool.execution_complete",
      "subagent.started", "subagent.completed", "subagent.failed",
      "assistant.message", "assistant.usage", "assistant.turn_start", "assistant.turn_end",
    ];
    for (const eventType of forwardedEvents) {
      session.on(eventType as "session.idle", (event?: { timestamp?: string; data?: unknown }) => {
        forwardEvent(eventType, event);
      });
    }

    // Track physical session state
    entry.info.physicalSession = {
      sessionId: session.sessionId,
      model: resolvedModel,
      startedAt: new Date().toISOString(),
      currentState: "idle",
    };
    entry.info.subagentSessions = [];

    // Subscribe to SDK events for state tracking
    session.on("tool.execution_start", (event) => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.currentState = `tool:${event.data.toolName}`;
      }
    });
    session.on("tool.execution_complete", () => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.currentState = "idle";
      }
    });
    session.on("session.idle", () => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.currentState = "idle";
      }
    });
    session.on("subagent.started", (event) => {
      const subs = entry.info.subagentSessions;
      if (subs !== undefined) {
        subs.push({
          toolCallId: event.data.toolCallId,
          agentName: event.data.agentName,
          agentDisplayName: event.data.agentDisplayName,
          status: "running",
          startedAt: event.timestamp,
        });
        // Keep only the last 50 entries to prevent unbounded growth
        if (subs.length > 50) {
          subs.splice(0, subs.length - 50);
        }
      }
    });
    // Type-safe helpers for extracting optional fields from SDK event data.
    // The SDK's typed event handler narrows to base fields only; stats fields
    // exist in the generated schema but are not exposed in the narrow type.
    const asStr = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
    const asNum = (v: unknown): number | undefined => typeof v === "number" ? v : undefined;

    session.on("subagent.completed", (event) => {
      const sub = entry.info.subagentSessions?.find((s) => s.toolCallId === event.data.toolCallId);
      if (sub !== undefined) sub.status = "completed";
      const d = event.data as Record<string, unknown>;
      subagentCompletionQueue.push({
        toolCallId: event.data.toolCallId,
        agentName: event.data.agentName,
        status: "completed",
        model: asStr(d["model"]),
        totalToolCalls: asNum(d["totalToolCalls"]),
        totalTokens: asNum(d["totalTokens"]),
        durationMs: asNum(d["durationMs"]),
      });
    });
    session.on("subagent.failed", (event) => {
      const sub = entry.info.subagentSessions?.find((s) => s.toolCallId === event.data.toolCallId);
      if (sub !== undefined) sub.status = "failed";
      const d = event.data as Record<string, unknown>;
      subagentCompletionQueue.push({
        toolCallId: event.data.toolCallId,
        agentName: event.data.agentName,
        status: "failed",
        error: asStr(d["error"]),
        model: asStr(d["model"]),
        totalToolCalls: asNum(d["totalToolCalls"]),
        totalTokens: asNum(d["totalTokens"]),
        durationMs: asNum(d["durationMs"]),
      });
    });
    session.on("session.model_change", (event) => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.model = event.data.newModel;
      }
    });
    session.on("session.usage_info", (event) => {
      if (entry.info.physicalSession !== undefined) {
        entry.info.physicalSession.currentTokens = event.data.currentTokens;
        entry.info.physicalSession.tokenLimit = event.data.tokenLimit;
      }
      // Track context usage percentage for periodic system prompt reminder
      const limit = event.data.tokenLimit;
      if (limit > 0) {
        reminderState.currentUsagePercent = event.data.currentTokens / limit;
        if (reminderState.currentUsagePercent >= reminderState.lastReminderPercent + 0.10) {
          reminderState.needsReminder = true;
        }
      }
    });
    session.on("assistant.usage", (event) => {
      if (entry.info.physicalSession !== undefined) {
        const ps = entry.info.physicalSession;
        ps.totalInputTokens = (ps.totalInputTokens ?? 0) + (event.data.inputTokens ?? 0);
        ps.totalOutputTokens = (ps.totalOutputTokens ?? 0) + (event.data.outputTokens ?? 0);
        if (event.data.quotaSnapshots !== undefined) {
          ps.latestQuotaSnapshots = event.data.quotaSnapshots as Record<string, unknown>;
        }
      }
    });
    // After compaction, the LLM may lose critical instructions. Flag an immediate reminder.
    session.on("session.compaction_complete", () => {
      reminderState.needsReminder = true;
      reminderState.lastReminderPercent = 0; // Reset — usage drops after compaction
    });
    // Reflect assistant.message events to the channel timeline as agent messages.
    // This serves as a fallback: ideally the agent uses copilotclaw_send_message,
    // but when the LLM responds with text instead of calling a tool, this ensures
    // the response still reaches the user.
    session.on("assistant.message", (event) => {
      const content = event.data.content;
      if (content.length > 0) {
        this.postChannelMessage(channelId, content);
      }
    });

    const logPrefix = channelId.slice(0, 8);
    await runSessionLoop({
      session: adaptCopilotSession(session),
      // System prompt is in the channel-operator custom agent's prompt field.
      // initialPrompt is the first user-turn message that kicks off the session.
      initialPrompt:
        "Call copilotclaw_wait now to receive the first user message.",
      onMessage: (content) => { console.log(`[ch:${logPrefix}] ${content}`); },
      log: (message) => { console.error(`[agent:${logPrefix}] ${message}`); },
      shouldStop: () => entry.abortController.signal.aborted,
    });
  }

  /** Resolve which model to use for session creation.
   * Queries available models via SDK and selects based on config:
   * - zeroPremium: picks cheapest non-premium model (billing.multiplier === 0)
   * - model unset: picks model with lowest billing.multiplier
   * - model set: uses that model (zeroPremium may override if it's premium) */
  private async resolveModel(client: CopilotClient): Promise<string> {
    try {
      // Ensure the CLI process is started before accessing client.rpc.
      // createSession calls start() automatically via autoStart, but
      // resolveModel runs before createSession to determine the model.
      await client.start();
      const { models } = await client.rpc.models.list();
      if (models.length === 0) {
        console.error("[agent] no models available from SDK, falling back to gpt-4.1");
        return this.model ?? "gpt-4.1";
      }

      // Sort by billing multiplier (ascending — cheapest first)
      const sorted = [...models].sort((a, b) =>
        (a.billing?.multiplier ?? Infinity) - (b.billing?.multiplier ?? Infinity),
      );
      const nonPremium = sorted.filter((m) => m.billing?.multiplier === 0);

      if (this.zeroPremium) {
        if (nonPremium.length === 0) {
          console.error("[agent] zeroPremium: no non-premium models available");
          throw new Error("zeroPremium is enabled but no non-premium models are available");
        }
        if (this.model !== undefined) {
          const modelInfo = models.find((m) => m.id === this.model);
          if (modelInfo !== undefined && modelInfo.billing?.multiplier !== 0) {
            console.error(`[agent] zeroPremium: overriding premium model ${this.model} → ${nonPremium[0]!.id}`);
            return nonPremium[0]!.id;
          }
          return this.model;
        }
        return nonPremium[0]!.id;
      }

      if (this.model !== undefined) return this.model;

      // No model specified: pick the one with lowest premium cost
      return sorted[0]!.id;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("zeroPremium")) throw err;
      console.error("[agent] failed to list models from SDK, falling back to gpt-4.1:", err);
      return this.model ?? "gpt-4.1";
    }
  }

  /** Transition an abstract session to suspended state, preserving channel binding.
   *  The physical session is gone but the abstract session survives for later revival.
   *  Cumulative token usage is accumulated from the physical session before clearing. */
  /** Transition the entry to suspended state without persisting to disk. */
  private suspendSessionState(entry: AgentSessionEntry): void {
    // Accumulate token usage from the physical session being suspended
    const ps = entry.info.physicalSession;
    if (ps !== undefined) {
      entry.info.cumulativeInputTokens = (entry.info.cumulativeInputTokens ?? 0) + (ps.totalInputTokens ?? 0);
      entry.info.cumulativeOutputTokens = (entry.info.cumulativeOutputTokens ?? 0) + (ps.totalOutputTokens ?? 0);
      // Preserve stopped physical session in history for dashboard visibility
      const history = entry.info.physicalSessionHistory ?? [];
      history.push({ ...ps, currentState: "stopped" });
      // Keep only the last 10 physical sessions to prevent unbounded growth
      if (history.length > 10) history.splice(0, history.length - 10);
      entry.info.physicalSessionHistory = history;
    }
    entry.info.status = "suspended";
    entry.copilotSession = undefined;
    entry.info.physicalSession = undefined;
    entry.info.subagentSessions = undefined;
    // copilotSessionId is preserved for resumeSession on revival
  }

  private suspendSession(entry: AgentSessionEntry): void {
    this.suspendSessionState(entry);
    this.saveBindings();
  }

  /** Revive a suspended abstract session by launching a new physical session. */
  private reviveSession(entry: AgentSessionEntry, copilotSessionId?: string): void {
    // Use provided copilotSessionId or fall back to the one saved during suspension
    if (copilotSessionId !== undefined) {
      entry.copilotSessionId = copilotSessionId;
    }
    // Else: keep existing entry.copilotSessionId from the suspended session

    entry.info.status = "starting";
    entry.abortController = new AbortController();
    entry.client = this.createClient();
    entry.generation = ++this.generationCounter;

    // Capture this revival's client so finally stops the correct one even if revived again
    const clientToStop = entry.client;

    entry.sessionPromise = this.attachSessionLifecycle(entry, clientToStop);
  }

  /** Explicitly stop a session — fully removes the abstract session and channel binding. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.abortController.abort();
    // Fully remove on explicit stop (not suspend)
    const boundChannelId = entry.info.boundChannelId;
    if (boundChannelId !== undefined && this.channelBindings.get(boundChannelId) === sessionId) {
      this.channelBindings.delete(boundChannelId);
    }
    this.sessions.delete(sessionId);
    this.saveBindings();
  }

  stopSessionForChannel(channelId: string): void {
    const sessionId = this.channelBindings.get(channelId);
    if (sessionId !== undefined) {
      this.stopSession(sessionId);
    }
  }

  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    const entries = [...this.sessions.entries()];
    for (const [sessionId, entry] of entries) {
      entry.abortController.abort();
      promises.push(entry.sessionPromise);
      if (entry.info.boundChannelId !== undefined) {
        // Channel-bound sessions are suspended (not deleted) so the abstract
        // session and channel binding survive the agent restart.
        this.suspendSessionState(entry);
      } else {
        // Unbound sessions have no channel to revive them — fully remove.
        this.sessions.delete(sessionId);
      }
    }
    this.saveBindings();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => { timeoutHandle = setTimeout(r, 5000); });
    await Promise.race([
      Promise.allSettled(promises).finally(() => { clearTimeout(timeoutHandle); }),
      timeout,
    ]);
  }

  async checkStaleAndHandle(sessionId: string, oldestInputId: string | undefined): Promise<"ok" | "flushed"> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return "ok";
    if (entry.info.status !== "processing") return "ok";

    const processingStartedAt = entry.info.processingStartedAt;
    if (processingStartedAt === undefined) return "ok";

    const elapsed = Date.now() - new Date(processingStartedAt).getTime();
    if (elapsed < this.staleTimeoutMs) return "ok";

    // Don't act if there are no pending inputs (agent may be legitimately finishing)
    if (oldestInputId === undefined) return "ok";

    const boundChannelId = entry.info.boundChannelId;

    // Stale session — suspend (abstract session survives), notify, flush stale inputs
    console.error(`[agent] session ${sessionId.slice(0, 8)} stale processing (${Math.round(elapsed / 1000)}s), suspending (deferred resume)`);

    // Abort first to prevent the promise handler from double-suspending
    entry.abortController.abort();
    this.suspendSession(entry);
    this.notifyChannelSessionTimedOut(boundChannelId);
    // Return "flushed" so the caller flushes stale inputs; the deferred resume will only
    // fire when a genuinely new user message arrives after the flush.
    return "flushed";
  }

  /** Attach lifecycle handlers (suspend on idle/error, backoff, notification) to a session's runSession promise.
   *  Used by both startSession and reviveSession to avoid duplicating the .then/.catch/.finally chain. */
  private attachSessionLifecycle(entry: AgentSessionEntry, clientToStop: CopilotClient): Promise<void> {
    const startTime = Date.now();
    const sessionId = entry.sessionId;
    const boundChannelId = entry.info.boundChannelId;

    return this.runSession(entry).then(() => {
      if (!entry.abortController.signal.aborted) {
        this.recordBackoffIfRapidFailure(boundChannelId, startTime);
        this.suspendSession(entry);
        this.notifyChannelSessionStopped(boundChannelId);
      }
    }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[agent] session ${sessionId.slice(0, 8)} error:`, err);
      if (!entry.abortController.signal.aborted) {
        this.recordBackoffIfRapidFailure(boundChannelId, startTime);
        this.suspendSession(entry);
        this.notifyChannelSessionStopped(boundChannelId, reason);
      }
    }).finally(() => {
      clientToStop.stop().catch(() => {});
    });
  }

  /** Record a backoff for a channel if the session failed rapidly (< RAPID_FAILURE_THRESHOLD_MS). */
  private recordBackoffIfRapidFailure(channelId: string | undefined, startTime: number): void {
    if (channelId === undefined) return;
    const elapsed = Date.now() - startTime;
    if (elapsed < RAPID_FAILURE_THRESHOLD_MS) {
      this.channelBackoff.set(channelId, Date.now() + BACKOFF_DURATION_MS);
      console.error(`[agent] channel ${channelId.slice(0, 8)} entering ${BACKOFF_DURATION_MS / 1000}s backoff after rapid failure (${elapsed}ms)`);
    }
  }

  /** Notify the channel that the session stopped. The "unexpectedly" wording is intentional
   *  even for idle exits — a session ending via session.idle (without explicit abort) is
   *  unexpected because the agent should keep calling copilotclaw_wait indefinitely. */
  private notifyChannelSessionStopped(channelId: string | undefined, reason?: string): void {
    if (channelId === undefined) return;
    const detail = reason !== undefined ? `: ${reason}` : "";
    const message = `[SYSTEM] Agent session stopped unexpectedly${detail}. A new session will start when you send a message.`;
    this.postChannelMessage(channelId, message);
  }

  private notifyChannelSessionTimedOut(channelId: string | undefined): void {
    if (channelId === undefined) return;
    const message = "[SYSTEM] Agent session timed out (stuck processing). A new session will start when you send a message.";
    this.postChannelMessage(channelId, message);
  }

  /** Fire-and-forget POST to a gateway endpoint. */
  private postToGateway(path: string, body: Record<string, unknown>): void {
    this.fetchFn(`${this.gatewayBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {
      // Non-fatal — event store unavailable or gateway not reachable
    });
  }

  private postChannelMessage(channelId: string, message: string): void {
    this.fetchFn(`${this.gatewayBaseUrl}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "agent", message }),
    }).catch((err: unknown) => {
      console.error(`[agent] failed to notify channel ${channelId}:`, err);
    });
  }

  /** Check if session has exceeded max age. If so, save state and stop (deferred resume).
   * The session will be resumed when the next pending message arrives for the channel.
   * Only applies to sessions in "waiting" state with a bound channel. */
  checkSessionMaxAge(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return false;
    if (entry.info.status !== "waiting") return false;
    if (entry.info.boundChannelId === undefined) return false;

    const age = Date.now() - new Date(entry.info.startedAt).getTime();
    if (age < this.maxSessionAgeMs) return false;

    console.error(`[agent] session ${sessionId.slice(0, 8)} exceeded max age (${Math.round(age / 3600000)}h), suspending (deferred resume)`);

    // Abort first to prevent the promise handler from double-suspending
    entry.abortController.abort();
    this.suspendSession(entry);

    return true;
  }

  /** Get the sessionId bound to a channel, if any */
  getSessionIdForChannel(channelId: string): string | undefined {
    return this.channelBindings.get(channelId);
  }

  /** Get the boundChannelId for a session, if any */
  getBoundChannelId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.info.boundChannelId;
  }

}
