/// <reference types="node" />
import { randomUUID } from "node:crypto";

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

export class Store {
  private readonly channels = new Map<string, Channel>();
  private readonly messages = new Map<string, Message[]>(); // channelId → all messages
  private readonly pendingQueues = new Map<string, string[]>(); // channelId → pending message IDs (FIFO)
  private readonly messageIndex = new Map<string, Message>(); // messageId → Message (for pending lookup)

  createChannel(): Channel {
    const channel: Channel = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    this.pendingQueues.set(channel.id, []);
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
    // User messages go to the pending queue for agent processing
    if (sender === "user") {
      this.pendingQueues.get(channelId)!.push(msg.id);
      this.messageIndex.set(msg.id, msg);
    }
    return msg;
  }

  listMessages(channelId: string, limit = 5): Message[] {
    const msgs = this.messages.get(channelId);
    if (msgs === undefined) return [];
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5;
    return msgs.slice(-safeLimit).reverse();
  }

  /** Drain all pending user messages from the queue (destructive) */
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
    return results;
  }

  /** Peek at the oldest pending user message without removing it */
  peekOldestPending(channelId: string): Message | undefined {
    const queue = this.pendingQueues.get(channelId);
    if (queue === undefined || queue.length === 0) return undefined;
    return this.messageIndex.get(queue[0]!);
  }

  /** Flush all pending user messages (for stale recovery) */
  flushPending(channelId: string): number {
    const queue = this.pendingQueues.get(channelId);
    if (queue === undefined) return 0;
    const count = queue.length;
    for (const id of queue) {
      this.messageIndex.delete(id);
    }
    queue.length = 0;
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
