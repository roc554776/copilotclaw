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

export interface Channel {
  id: string;
  createdAt: string;
}

export class Store {
  private readonly channels = new Map<string, Channel>();
  private readonly inputs = new Map<string, UserInput>();
  private readonly queues = new Map<string, string[]>();

  createChannel(): Channel {
    const channel: Channel = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.channels.set(channel.id, channel);
    this.queues.set(channel.id, []);
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
    input.reply = {
      message,
      createdAt: new Date().toISOString(),
    };
    return input;
  }

  listInputs(channelId: string): UserInput[] {
    return [...this.inputs.values()]
      .filter((i) => i.channelId === channelId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }
}
