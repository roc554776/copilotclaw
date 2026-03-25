/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

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
}

interface StoreSnapshot {
  channels: Channel[];
  messages: Record<string, Message[]>;
  pendingQueues: Record<string, string[]>;
}

export interface StoreOptions {
  persistPath?: string;
}

export class Store {
  private readonly channels = new Map<string, Channel>();
  private readonly messages = new Map<string, Message[]>();
  private readonly pendingQueues = new Map<string, string[]>();
  private readonly messageIndex = new Map<string, Message>();
  private readonly persistPath: string | undefined;

  constructor(options?: StoreOptions) {
    this.persistPath = options?.persistPath;
    if (this.persistPath !== undefined) {
      this.loadFromDisk();
    }
  }

  private loadFromDisk(): void {
    if (this.persistPath === undefined) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const snapshot = JSON.parse(raw) as StoreSnapshot;
      for (const ch of snapshot.channels) {
        this.channels.set(ch.id, ch);
      }
      for (const [channelId, msgs] of Object.entries(snapshot.messages)) {
        this.messages.set(channelId, msgs);
      }
      for (const [channelId, queue] of Object.entries(snapshot.pendingQueues)) {
        this.pendingQueues.set(channelId, queue);
        // Rebuild messageIndex from pending queue
        const msgs = this.messages.get(channelId) ?? [];
        const pendingSet = new Set(queue);
        for (const msg of msgs) {
          if (pendingSet.has(msg.id)) {
            this.messageIndex.set(msg.id, msg);
          }
        }
      }
      // Ensure all channels have entries in messages and pendingQueues
      for (const ch of this.channels.values()) {
        if (!this.messages.has(ch.id)) this.messages.set(ch.id, []);
        if (!this.pendingQueues.has(ch.id)) this.pendingQueues.set(ch.id, []);
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  private saveToDisk(): void {
    if (this.persistPath === undefined) return;
    const snapshot: StoreSnapshot = {
      channels: [...this.channels.values()],
      messages: Object.fromEntries(this.messages),
      pendingQueues: Object.fromEntries(this.pendingQueues),
    };
    writeFileSync(this.persistPath, JSON.stringify(snapshot, null, 2), "utf-8");
  }

  createChannel(): Channel {
    const channel: Channel = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    this.pendingQueues.set(channel.id, []);
    this.saveToDisk();
    return channel;
  }

  getChannel(channelId: string): Channel | undefined {
    return this.channels.get(channelId);
  }

  listChannels(): Channel[] {
    return [...this.channels.values()].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  addMessage(channelId: string, sender: "user" | "agent", message: string): Message | undefined {
    const msgs = this.messages.get(channelId);
    if (msgs === undefined) return undefined;
    const msg: Message = {
      id: randomUUID(),
      channelId,
      sender,
      message,
      createdAt: new Date().toISOString(),
    };
    msgs.push(msg);
    if (sender === "user") {
      this.pendingQueues.get(channelId)!.push(msg.id);
      this.messageIndex.set(msg.id, msg);
    }
    this.saveToDisk();
    return msg;
  }

  listMessages(channelId: string, limit = 5): Message[] {
    const msgs = this.messages.get(channelId);
    if (msgs === undefined) return [];
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5;
    return msgs.slice(-safeLimit).reverse();
  }

  drainPending(channelId: string): Message[] {
    const queue = this.pendingQueues.get(channelId);
    if (queue === undefined) return [];
    const results: Message[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const msg = this.messageIndex.get(id);
      if (msg !== undefined) {
        results.push(msg);
        this.messageIndex.delete(id);
      }
    }
    this.saveToDisk();
    return results;
  }

  peekOldestPending(channelId: string): Message | undefined {
    const queue = this.pendingQueues.get(channelId);
    if (queue === undefined || queue.length === 0) return undefined;
    return this.messageIndex.get(queue[0]!);
  }

  flushPending(channelId: string): number {
    const queue = this.pendingQueues.get(channelId);
    if (queue === undefined) return 0;
    const count = queue.length;
    for (const id of queue) {
      this.messageIndex.delete(id);
    }
    queue.length = 0;
    this.saveToDisk();
    return count;
  }

  pendingCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [channelId, queue] of this.pendingQueues) {
      counts[channelId] = queue.length;
    }
    return counts;
  }

  hasPending(channelId: string): boolean {
    const queue = this.pendingQueues.get(channelId);
    return queue !== undefined && queue.length > 0;
  }
}
