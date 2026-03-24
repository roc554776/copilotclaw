/// <reference types="node" />
import { randomUUID } from "node:crypto";

export interface Reply {
  message: string;
  createdAt: string;
}

export interface UserInput {
  id: string;
  message: string;
  createdAt: string;
  reply?: Reply;
}

export class Store {
  private readonly inputs = new Map<string, UserInput>();
  private readonly queue: string[] = [];

  addInput(message: string): UserInput {
    const input: UserInput = {
      id: randomUUID(),
      message,
      createdAt: new Date().toISOString(),
    };
    this.inputs.set(input.id, input);
    this.queue.push(input.id);
    return input;
  }

  findNextInput(): UserInput | undefined {
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      const input = this.inputs.get(id);
      if (input !== undefined) return input;
    }
    return undefined;
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

  listAll(): UserInput[] {
    return [...this.inputs.values()].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }
}
