import type { CopilotSession } from "@github/copilot-sdk";
import type { SessionLike, SessionLoopCallbacks } from "./session-loop.js";

export function adaptCopilotSession(session: CopilotSession): SessionLike {
  return {
    subscribe(callbacks: SessionLoopCallbacks) {
      session.on("assistant.message", (event) => {
        callbacks.onMessage(event.data.content);
      });
      session.on("session.error", (event) => {
        callbacks.onError(event.data.message);
      });
      session.on("session.idle", (event) => {
        const bg = event.data.backgroundTasks;
        // backgroundTasks is present and non-empty when a subagent stopped
        const hasBackgroundTasks = bg != null &&
          ((bg as { agents?: unknown[] }).agents?.length ?? 0) > 0;
        callbacks.onIdle(hasBackgroundTasks);
      });
    },
    send: (options) => session.send(options),
    disconnect: () => session.disconnect(),
  };
}
