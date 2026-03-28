/* Typed fetch wrappers for all gateway API endpoints */

export interface Channel {
  id: string;
  createdAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  sender: "user" | "agent";
  message: string;
  createdAt: string;
}

export interface PhysicalSession {
  sessionId: string;
  model: string;
  currentState: string;
  currentTokens?: number;
  tokenLimit?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  startedAt: string;
  latestQuotaSnapshots?: Record<string, QuotaSnapshot>;
}

export interface AgentSession {
  status: string;
  boundChannelId?: string;
  startedAt?: string;
  physicalSession?: PhysicalSession;
  physicalSessionHistory?: PhysicalSession[];
  subagentSessions?: Array<{ agentName: string; agentDisplayName?: string; status: string }>;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
}

export interface StatusResponse {
  gateway: { status: string; version: string; profile?: string | null };
  agent: {
    version?: string;
    startedAt?: string;
    sessions: Record<string, AgentSession>;
  } | null;
  agentCompatibility: string;
  config: {
    model?: string | null;
    zeroPremium?: boolean;
    debugMockCopilotUnsafeTools?: boolean;
    stateDir?: string;
    workspaceRoot?: string;
    auth?: unknown;
  };
}

export interface QuotaSnapshot {
  usedRequests?: number;
  entitlementRequests?: number;
  overage?: number;
}

export interface QuotaResponse {
  quotaSnapshots?: Record<string, QuotaSnapshot>;
}

export interface ModelEntry {
  id: string;
  billing?: { multiplier?: number };
}

export interface ModelsResponse {
  models: ModelEntry[];
}

export interface LogEntry {
  timestamp: string;
  level: string;
  source: string;
  message: string;
}

export interface SessionEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  parentId?: string;
}

export interface OriginalPrompt {
  model: string;
  prompt: string;
  capturedAt: string;
}

export interface SessionPrompt {
  model: string;
  prompt: string;
}

export async function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const res = await fetch("/api/status", signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json() as Promise<StatusResponse>;
}

export async function fetchChannels(): Promise<Channel[]> {
  const res = await fetch("/api/channels");
  if (!res.ok) throw new Error(`channels ${res.status}`);
  return res.json() as Promise<Channel[]>;
}

export async function fetchMessages(channelId: string, limit = 500): Promise<Message[]> {
  const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`);
  if (!res.ok) throw new Error(`messages ${res.status}`);
  return res.json() as Promise<Message[]>;
}

export async function sendMessage(channelId: string, message: string): Promise<Message> {
  const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "user", message }),
  });
  if (!res.ok) throw new Error(`send ${res.status}`);
  return res.json() as Promise<Message>;
}

export async function createChannel(): Promise<Channel> {
  const res = await fetch("/api/channels", { method: "POST" });
  if (!res.ok) throw new Error(`create channel ${res.status}`);
  return res.json() as Promise<Channel>;
}

export async function fetchQuota(signal?: AbortSignal): Promise<QuotaResponse | null> {
  const res = await fetch("/api/quota", signal ? { signal } : undefined);
  if (!res.ok) return null;
  return res.json() as Promise<QuotaResponse>;
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelsResponse | null> {
  const res = await fetch("/api/models", signal ? { signal } : undefined);
  if (!res.ok) return null;
  return res.json() as Promise<ModelsResponse>;
}

export async function fetchLogs(limit = 100): Promise<LogEntry[]> {
  const res = await fetch(`/api/logs?limit=${limit}`);
  if (!res.ok) throw new Error(`logs ${res.status}`);
  return res.json() as Promise<LogEntry[]>;
}

export async function fetchSessionEvents(sessionId: string, signal?: AbortSignal): Promise<SessionEvent[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`session events ${res.status}`);
  return res.json() as Promise<SessionEvent[]>;
}

export async function fetchSessionIds(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch("/api/session-events/sessions", signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`session ids ${res.status}`);
  return res.json() as Promise<string[]>;
}

export async function fetchOriginalPrompts(): Promise<OriginalPrompt[]> {
  const res = await fetch("/api/system-prompts/original");
  if (!res.ok) return [];
  return res.json() as Promise<OriginalPrompt[]>;
}

export async function fetchSessionPrompt(sessionId: string): Promise<SessionPrompt | null> {
  const res = await fetch(`/api/system-prompts/session/${encodeURIComponent(sessionId)}`);
  if (!res.ok) return null;
  return res.json() as Promise<SessionPrompt>;
}

