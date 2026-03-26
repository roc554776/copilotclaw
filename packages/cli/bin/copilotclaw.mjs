#!/usr/bin/env node

// CopilotClaw CLI entrypoint
// Usage: copilotclaw <command> [options]

const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < 20) {
  console.error(`copilotclaw requires Node.js 20+, but found ${process.version}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0];

const USAGE = `Usage: copilotclaw <command> [options]

Commands:
  setup                Initialize workspace (~/.copilotclaw/)
  start [options]      Start the gateway daemon
  stop                 Stop the gateway (agent keeps running)
  restart              Restart the gateway (stop + start)
  update               Update copilotclaw (git pull + build)
  config get <key>     Show config value
  config set <key> <v> Set config value
  doctor [--fix]       Diagnose environment (fix issues with --fix)
  agent stop           Stop the agent process only

Start options:
  --force-agent-restart  Stop outdated agent before starting

Environment:
  COPILOTCLAW_PROFILE    Profile name (separates workspace, config, gateway, agent)
  COPILOTCLAW_UPSTREAM   Git remote URL for update (e.g. file:///path/to/repo)
  COPILOTCLAW_PORT       Override gateway HTTP port
`;

async function run() {
  // Resolve gateway and agent dist directories from installed packages
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  const gatewayDist = dirname(require.resolve("@copilotclaw/gateway/package.json")) + "/dist";
  const agentDist = dirname(require.resolve("@copilotclaw/agent/package.json")) + "/dist";

  switch (command) {
    case "setup":
      await import(join(gatewayDist, "setup.js"));
      break;

    case "start": {
      // Pass --force-agent-restart as env var to the daemon spawner
      if (args.includes("--force-agent-restart")) {
        process.env.COPILOTCLAW_FORCE_AGENT_RESTART_FLAG = "1";
      }
      await import(join(gatewayDist, "index.js"));
      break;
    }

    case "stop":
      await import(join(gatewayDist, "stop.js"));
      break;

    case "restart":
      await import(join(gatewayDist, "restart.js"));
      break;

    case "update": {
      const { runUpdate } = await import(join(gatewayDist, "update.js"));
      await runUpdate();
      break;
    }

    case "config":
      await import(join(gatewayDist, "config-cli.js"));
      break;

    case "doctor":
      await import(join(gatewayDist, "doctor.js"));
      break;

    case "agent":
      if (args[1] === "stop") {
        await import(join(agentDist, "stop.js"));
      } else {
        console.error(`Unknown agent subcommand: ${args[1] ?? "(none)"}`);
        console.error(USAGE);
        process.exit(1);
      }
      break;

    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      process.exit(1);
  }
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
