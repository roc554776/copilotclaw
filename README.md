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
npm install -g .
```

After installation, the `copilotclaw` command is available globally.

### Initialize workspace

```sh
copilotclaw setup
```

This creates `~/.copilotclaw/` with the data directory for persistent storage.

## Usage

### Start

```sh
copilotclaw start
```

The gateway starts as a background daemon on http://localhost:19741. Channel and message data is persisted to `~/.copilotclaw/data/store.json` and survives restarts.

### Chat

Open http://localhost:19741 in your browser.

- Type a message and press Send (or Enter)
- Use the "+" button to create additional channels for parallel conversations
- Click the status bar for detailed gateway/agent status
- A typing indicator shows when the agent is processing

### Stop

```sh
copilotclaw stop          # Stop gateway and agent
copilotclaw agent stop    # Stop agent only
```

### Update

```sh
copilotclaw update
```

Pulls the latest code from the upstream repository, installs dependencies, and rebuilds. Restart the gateway and agent after updating.

For local development, set a file URL as the upstream:

```sh
COPILOTCLAW_UPSTREAM=file:///path/to/local/repo copilotclaw update
```

### Force-restart outdated agent

```sh
copilotclaw start --force-agent-restart
```

## Commands

```
copilotclaw setup                Initialize workspace (~/.copilotclaw/)
copilotclaw start [options]      Start the gateway daemon
copilotclaw stop                 Stop the gateway and agent
copilotclaw update               Update copilotclaw (git pull + build)
copilotclaw agent stop           Stop the agent process only
```

## Data

All persistent data is stored under `~/.copilotclaw/`:

| Path | Purpose |
|:---|:---|
| `data/store.json` | Channels and message history |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.
