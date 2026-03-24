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
  continuePrompt: string;
  maxTurns: number;
  onMessage?: (content: string) => void;
  log?: (message: string) => void;
  shouldStop?: () => boolean;
}

export async function runSessionLoop(options: SessionLoopOptions): Promise<{ turnCount: number }> {
  const {
    session,
    initialPrompt,
    continuePrompt,
    maxTurns,
    onMessage = () => {},
    log = () => {},
    shouldStop = () => false,
  } = options;

  let turnCount = 0;

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

          if (shouldStop()) {
            log("stop requested externally");
            settle(() => { resolve(); });
            return;
          }

          turnCount++;
          if (turnCount > maxTurns) {
            log(`reached max turns (${maxTurns}), stopping`);
            settle(() => { resolve(); });
            return;
          }

          log(`turn #${turnCount}, sending continue prompt`);
          session
            .send({
              prompt: continuePrompt,
              mode: "enqueue",
            })
            .catch((err: unknown) => {
              settle(() => {
                reject(err instanceof Error ? err : new Error(String(err)));
              });
            });
        },
      });
    });

    await session.send({ prompt: initialPrompt });
    await done;
  } finally {
    try {
      await session.disconnect();
    } catch (disconnectErr: unknown) {
      log(`disconnect error (suppressed): ${String(disconnectErr)}`);
    }
  }

  return { turnCount };
}
