# CopilotClaw

A CLI agent built on the GitHub Copilot SDK. Provides an interactive agent experience for software development tasks using only a GitHub Copilot subscription.

## Prerequisites

- GitHub Copilot subscription
- [mise](https://mise.jdx.dev/) (manages Node.js and pnpm versions)

## Install

```sh
git clone https://github.com/roc554776/copilotclaw.git
cd copilotclaw
mise install
pnpm install
pnpm run build
cd packages/cli && npm pack && npm install -g copilotclaw-*.tgz && rm copilotclaw-*.tgz && cd ../..
```

After installation, the `copilotclaw` command is available globally.

### Initialize workspace

```sh
copilotclaw setup
```

This creates `~/.copilotclaw/` with the data directory and config file.

## Usage

### Start

```sh
copilotclaw start
```

The gateway starts as a background daemon. Channel and message data is persisted to `~/.copilotclaw/data/store.json` and survives restarts.

### Chat

Open the gateway URL shown at startup in your browser.

- Type a message and press Send (or Enter)
- Use the "+" button to create additional channels for parallel conversations
- Click the status bar for detailed status (gateway, agent, Copilot sessions, premium requests, models)
- A typing indicator shows when the agent is processing
- Agent responses appear in the chat automatically — even when the agent responds with text instead of using the send message tool
- The agent periodically reinforces its critical operating instructions to maintain stability during long sessions
- Custom agent architecture: channel-operator handles user interaction, worker handles delegated subtasks
- Subagent completion notifications are delivered to the parent agent in real time
- Sessions survive physical disconnections and agent restarts — the agent automatically resumes with conversation history intact

### Stop

```sh
copilotclaw stop          # Stop gateway only (agent keeps running)
copilotclaw restart       # Restart gateway (stop + start)
copilotclaw agent stop    # Stop agent only
```

### Update

```sh
copilotclaw update
```

Pulls the latest code from the upstream repository, installs dependencies, rebuilds, and reinstalls. Restart the gateway after updating.

### Force-restart outdated agent

```sh
copilotclaw start --force-agent-restart
```

### Diagnose environment

```sh
copilotclaw doctor        # Check workspace, config, gateway, agent
copilotclaw doctor --fix  # Auto-fix fixable issues
```

## Configuration

Config file: `~/.copilotclaw/config.json` (created by `copilotclaw setup`)

```sh
copilotclaw config get <key>          # Show config value
copilotclaw config set <key> <value>  # Set config value
```

### Settings

| Key | Type | Env var | Description |
|:---|:---|:---|:---|
| `upstream` | string | `COPILOTCLAW_UPSTREAM` | Git remote URL for update (e.g. `file:///path/to/repo`) |
| `port` | number | `COPILOTCLAW_PORT` | Gateway HTTP port (default: 19741) |
| `model` | string | `COPILOTCLAW_MODEL` | Default Copilot model. Unset = auto-select least premium model |
| `zeroPremium` | boolean | `COPILOTCLAW_ZERO_PREMIUM` | Zero premium request mode (default: false) |
| `debugMockCopilotUnsafeTools` | boolean | `COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS` | Dev mode: replace dangerous tools with mocks (default: false) |

Environment variables override config file values.

### Profiles

Use `COPILOTCLAW_PROFILE` to run multiple independent instances:

```sh
COPILOTCLAW_PROFILE=staging copilotclaw setup
COPILOTCLAW_PROFILE=staging copilotclaw start
```

Each profile gets its own workspace, config, gateway, agent, and IPC socket.

## Commands

```
copilotclaw setup                Initialize workspace
copilotclaw start [options]      Start the gateway daemon
copilotclaw stop                 Stop the gateway (agent keeps running)
copilotclaw restart              Restart the gateway (stop + start)
copilotclaw update               Update copilotclaw (git pull + build)
copilotclaw config get <key>     Show config value
copilotclaw config set <key> <v> Set config value
copilotclaw doctor [--fix]       Diagnose environment
copilotclaw agent stop           Stop the agent process only
```

## Data

All persistent data is stored under `~/.copilotclaw/`:

| Path | Purpose |
|:---|:---|
| `config.json` | Configuration |
| `data/store.json` | Channels and message history |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.
