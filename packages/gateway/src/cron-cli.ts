import { getProfileName, resolvePort } from "./config.js";

export async function main(args: string[]): Promise<void> {
  const subcommand = args[1]; // args[0] is "cron"
  const port = resolvePort(getProfileName());

  switch (subcommand) {
    case "reload": {
      try {
        const res = await fetch(`http://localhost:${port}/api/cron/reload`, { method: "POST" });
        if (res.ok) {
          console.log("cron scheduler reloaded");
        } else {
          const body = await res.text();
          console.error(`cron reload failed: ${res.status} ${body}`);
          process.exit(1);
        }
      } catch {
        console.error("gateway not running");
        process.exit(1);
      }
      break;
    }

    case "list": {
      try {
        const res = await fetch(`http://localhost:${port}/api/cron`);
        if (!res.ok) {
          console.error(`cron list failed: ${res.status}`);
          process.exit(1);
        }
        const jobs = await res.json() as Array<{
          id: string;
          channelId: string;
          intervalMs: number;
          message: string;
          disabled: boolean;
          scheduled: boolean;
        }>;
        if (jobs.length === 0) {
          console.log("no cron jobs configured");
          return;
        }
        for (const job of jobs) {
          const status = job.scheduled ? "scheduled" : job.disabled ? "disabled" : "inactive";
          const interval = `${Math.round(job.intervalMs / 1000)}s`;
          console.log(`${job.id}\t${status}\t${interval}\t${job.channelId.slice(0, 8)}\t${job.message}`);
        }
      } catch {
        console.error("gateway not running");
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown cron subcommand: ${subcommand ?? "(none)"}`);
      console.error("Usage: copilotclaw cron <reload|list>");
      process.exit(1);
  }
}
