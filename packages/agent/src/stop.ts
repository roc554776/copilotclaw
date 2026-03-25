import { createConnection } from "node:net";
import { getAgentSocketPath } from "./ipc-paths.js";

function sendStop(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath, () => {
      socket.write(JSON.stringify({ method: "stop" }) + "\n");
    });
    let buffer = "";
    socket.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.includes("\n")) {
        socket.destroy();
        resolve(true);
      }
    });
    socket.on("error", () => { resolve(false); });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 5000);
    socket.on("close", () => { clearTimeout(timer); });
  });
}

async function main(): Promise<void> {
  const socketPath = getAgentSocketPath();
  const stopped = await sendStop(socketPath);
  if (stopped) {
    console.error("[agent] stopped");
  } else {
    console.error("[agent] not running");
  }
}

main();
