export interface SessionLoopCallbacks {
  onMessage: (content: string) => void;
  onError: (message: string) => void;
  onIdle: (hasBackgroundTasks: boolean) => void;
}

export interface SessionLike {
  subscribe(callbacks: SessionLoopCallbacks): void;
  send(options: { prompt: string; mode?: "enqueue" | "immediate" }): Promise<string>;
  disconnect(): Promise<void>;
}

/** Timeout (ms) after a backgroundTasks idle before terminating anyway.
 * This is a safety net — normally the SDK fires a true idle or error after
 * subagent completion. The timeout should be longer than copilotclaw_wait's
 * keepalive timeout (default 25min) to avoid premature termination. */
const BACKGROUND_TASKS_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
      let bgTasksTimer: ReturnType<typeof setTimeout> | null = null;

      function settle(action: () => void): void {
        if (settled) return;
        settled = true;
        if (bgTasksTimer !== null) { clearTimeout(bgTasksTimer); bgTasksTimer = null; }
        action();
      }

      session.subscribe({
        onMessage: (content) => {
          onMessage(content);
        },
        onError: (message) => {
          settle(() => { reject(new Error(message)); });
        },
        onIdle: (hasBackgroundTasks) => {
          if (settled) return;
          if (hasBackgroundTasks) {
            // Subagent stopped but parent agent's copilotclaw_wait may still be running.
            // Wait for a follow-up true idle or error. If neither comes within the
            // timeout, terminate anyway to prevent infinite hang.
            log("session idle with backgroundTasks — waiting for follow-up");
            if (bgTasksTimer === null) {
              bgTasksTimer = setTimeout(() => {
                bgTasksTimer = null;
                if (settled) return;
                log("session idle with backgroundTasks — timeout, terminating");
                settle(() => { resolve(); });
              }, BACKGROUND_TASKS_IDLE_TIMEOUT_MS);
              bgTasksTimer.unref?.();
            }
            return;
          }
          // True idle — LLM decided to stop calling tools.
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
