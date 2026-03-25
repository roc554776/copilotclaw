export interface SessionLoopCallbacks {
  onMessage: (content: string) => void;
  onError: (message: string) => void;
  onIdle: () => void;
}

export interface SessionLike {
  subscribe(callbacks: SessionLoopCallbacks): void;
  send(options: { prompt: string; mode?: "enqueue" | "immediate" }): Promise<string>;
  disconnect(): Promise<void>;
}

export interface SessionLoopOptions {
  session: SessionLike;
  initialPrompt: string;
  onMessage?: (content: string) => void;
  log?: (message: string) => void;
  shouldStop?: () => boolean;
}

export async function runSessionLoop(options: SessionLoopOptions): Promise<void> {
  const {
    session,
    initialPrompt,
    onMessage = () => {},
    log = () => {},
    shouldStop = () => false,
  } = options;

  try {
    const done = new Promise<void>((resolve, reject) => {
      let settled = false;

      function settle(action: () => void): void {
        if (settled) return;
        settled = true;
        action();
      }

      session.subscribe({
        onMessage: (content) => {
          onMessage(content);
        },
        onError: (message) => {
          settle(() => { reject(new Error(message)); });
        },
        onIdle: () => {
          if (settled) return;
          // Session ended — LLM decided to stop calling tools.
          // Do NOT send continuePrompt (session.send costs a premium request).
          log("session idle — LLM stopped calling tools");
          settle(() => { resolve(); });
        },
      });
    });

    if (shouldStop()) {
      log("stop requested before initial send");
      return;
    }
    await session.send({ prompt: initialPrompt });
    await done;
  } finally {
    try {
      await session.disconnect();
    } catch (disconnectErr: unknown) {
      log(`disconnect error (suppressed): ${String(disconnectErr)}`);
    }
  }
}
