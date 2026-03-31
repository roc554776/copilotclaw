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

/** Safety-net timeout (ms) after a backgroundTasks idle.
 * backgroundTasks idle means a subagent stopped but the overall session is still
 * running (copilotclaw_wait continues to block). Normally the session continues
 * indefinitely via the keepalive cycle. This timeout exists only as a last-resort
 * guard against unforeseen SDK-level hangs where no further events arrive.
 * Must be longer than copilotclaw_wait's keepalive timeout (default 25min). */
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
            // A subagent stopped but the overall session is still running —
            // copilotclaw_wait continues to block and the keepalive cycle proceeds
            // normally. Do NOT terminate the session loop.
            log("session idle with backgroundTasks — subagent stopped, session continues");
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
