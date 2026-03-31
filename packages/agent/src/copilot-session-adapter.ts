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
        const hasBackgroundTasks = event.data?.backgroundTasks != null;
        callbacks.onIdle(hasBackgroundTasks);
      });
    },
    send: (options) => session.send(options),
    disconnect: () => session.disconnect(),
  };
}
