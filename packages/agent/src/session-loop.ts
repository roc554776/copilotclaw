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
  continueProbability: number;
  maxRetries: number;
  random?: () => number;
  onMessage?: (content: string) => void;
  log?: (message: string) => void;
}

export async function runSessionLoop(options: SessionLoopOptions): Promise<{ helloCount: number }> {
  const {
    session,
    initialPrompt,
    continueProbability,
    maxRetries,
    random = Math.random,
    onMessage = () => {},
    log = () => {},
  } = options;

  let helloCount = 0;

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

          helloCount++;
          if (helloCount > maxRetries) {
            log(`reached max retries (${maxRetries}), stopping`);
            settle(() => { resolve(); });
            return;
          }

          if (random() < continueProbability) {
            log(`blocked stop (hello #${helloCount})`);
            session
              .send({
                prompt: `Say "hello ${helloCount}" and then say you are about to stop.`,
                mode: "enqueue",
              })
              .catch((err: unknown) => {
                settle(() => {
                  reject(err instanceof Error ? err : new Error(String(err)));
                });
              });
          } else {
            log(`allowing stop (after ${helloCount} extra hellos)`);
            settle(() => { resolve(); });
          }
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

  return { helloCount };
}
