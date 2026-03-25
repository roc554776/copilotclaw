/// <reference types="node" />
import { randomUUID } from "node:crypto";

export interface Reply {
  message: string;
  createdAt: string;
}

export interface UserInput {
  id: string;
  channelId: string;
  message: string;
  createdAt: string;
  reply?: Reply;
}

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
  private readonly inputs = new Map<string, UserInput>();
  private readonly queues = new Map<string, string[]>();
  private readonly messages = new Map<string, Message[]>(); // channelId → messages

  createChannel(): Channel {
    const channel: Channel = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.channels.set(channel.id, channel);
    this.queues.set(channel.id, []);
    this.messages.set(channel.id, []);
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

  addInput(channelId: string, message: string): UserInput | undefined {
    if (!this.channels.has(channelId)) return undefined;
    const input: UserInput = {
      id: randomUUID(),
      channelId,
      message,
      createdAt: new Date().toISOString(),
    };
    this.inputs.set(input.id, input);
    this.queues.get(channelId)!.push(input.id);
    this.messages.get(channelId)!.push({
      id: randomUUID(),
      channelId,
      sender: "user",
      message,
      createdAt: input.createdAt,
    });
    return input;
  }

  drainInputs(channelId: string): UserInput[] {
    const queue = this.queues.get(channelId);
    if (queue === undefined) return [];
    const results: UserInput[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const input = this.inputs.get(id);
      if (input !== undefined) results.push(input);
    }
    return results;
  }

  hasQueuedInputs(channelId: string): boolean {
    const queue = this.queues.get(channelId);
    return queue !== undefined && queue.length > 0;
  }

  addReply(inputId: string, message: string): UserInput | undefined {
    const input = this.inputs.get(inputId);
    if (input === undefined) return undefined;
    const createdAt = new Date().toISOString();
    input.reply = { message, createdAt };
    this.messages.get(input.channelId)?.push({
      id: randomUUID(),
      channelId: input.channelId,
      sender: "agent",
      message,
      createdAt,
    });
    return input;
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
    return msg;
  }

  listMessages(channelId: string, limit = 5): Message[] {
    const msgs = this.messages.get(channelId);
    if (msgs === undefined) return [];
    // Return latest messages in reverse chronological order
    return msgs.slice(-limit).reverse();
  }

  pendingCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [channelId, queue] of this.queues) {
      counts[channelId] = queue.length;
    }
    return counts;
  }

  peekOldestInput(channelId: string): UserInput | undefined {
    const queue = this.queues.get(channelId);
    if (queue === undefined || queue.length === 0) return undefined;
    return this.inputs.get(queue[0]!);
  }

  flushInputs(channelId: string): number {
    const queue = this.queues.get(channelId);
    if (queue === undefined) return 0;
    const count = queue.length;
    for (const id of queue) {
      this.inputs.delete(id);
    }
    queue.length = 0;
    return count;
  }

  listInputs(channelId: string): UserInput[] {
    return [...this.inputs.values()]
      .filter((i) => i.channelId === channelId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }
}
