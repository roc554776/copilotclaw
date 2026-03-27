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
node --input-type=module -e "
  import { rewriteWorkspaceDeps } from './packages/gateway/dist/update.js';
  import { resolve } from 'node:path';
  rewriteWorkspaceDeps(resolve('packages/cli'), process.cwd());
"
npm install -g ./packages/cli
git checkout packages/cli/package.json
```

After installation, the `copilotclaw` command is available globally.

### Initialize workspace

```sh
copilotclaw setup
```

This creates `~/.copilotclaw/` with:
- Config file (`config.json`)
- Data directory for channels and messages
- Workspace files: `SOUL.md` (persona), `AGENTS.md` (operating guide), `USER.md`, `TOOLS.md`, `MEMORY.md`, `memory/`
- Git repository (if git is available)

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
- Sessions survive disconnections and agent restarts — conversations resume automatically

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

Config file: `~/.copilotclaw/config.json` (created by `copilotclaw setup`). The config file includes a `configVersion` field for schema versioning — old configs are automatically migrated on load.

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

Use `--profile` to run multiple independent instances:

```sh
copilotclaw --profile staging setup
copilotclaw --profile staging start
```

Each profile gets its own state directory (`~/.copilotclaw-staging/`), completely isolated from other profiles. The `COPILOTCLAW_PROFILE` environment variable can also be used; `--profile` takes precedence.

### Profile Authentication

Each profile can use different GitHub Copilot credentials. Configure via `auth` in `config.json`.

**Using gh CLI authentication:**

```sh
# Use a specific GitHub account
copilotclaw --profile work config set auth.type gh-auth
copilotclaw --profile work config set auth.user my-work-account
```

**Using a Fine-grained Personal Access Token:**

```sh
export COPILOTCLAW_WORK_TOKEN="github_pat_xxxx..."
copilotclaw --profile work config set auth.type pat
copilotclaw --profile work config set auth.tokenEnv COPILOTCLAW_WORK_TOKEN
```

When `auth` is not configured, the default Copilot CLI credentials are used.

| Auth key | Description |
|:---|:---|
| `auth.type` | `gh-auth` (gh CLI), `pat` (Personal Access Token) |
| `auth.user` | GitHub username for `gh auth token --user` (gh-auth only) |
| `auth.hostname` | GitHub hostname for `gh auth token --hostname` (gh-auth only) |
| `auth.tokenEnv` | Environment variable containing the token (pat) |
| `auth.tokenFile` | File path containing the token (pat) |
| `auth.tokenCommand` | Custom command to obtain the token (any type, no spaces in paths) |

## Commands

```
copilotclaw [--profile <name>] setup                Initialize workspace
copilotclaw [--profile <name>] start [options]      Start the gateway daemon
copilotclaw [--profile <name>] stop                 Stop the gateway
copilotclaw [--profile <name>] restart              Restart the gateway
copilotclaw [--profile <name>] update               Update copilotclaw
copilotclaw [--profile <name>] config get <key>     Show config value
copilotclaw [--profile <name>] config set <key> <v> Set config value
copilotclaw [--profile <name>] doctor [--fix]       Diagnose environment
copilotclaw [--profile <name>] agent stop           Stop the agent
```

## Data

All persistent data is stored under `~/.copilotclaw/` (or `~/.copilotclaw-{{profile}}/` for named profiles):

| Path | Purpose |
|:---|:---|
| `config.json` | Configuration |
| `data/store.json` | Channels and message history |
| `data/agent-bindings.json` | Agent session bindings (survives agent restarts) |
| `data/gateway.log` | Gateway structured log (JSON Lines) |
| `data/agent.log` | Agent structured log (JSON Lines) |
| `SOUL.md` | Agent persona and tone (user-customizable) |
| `AGENTS.md` | Agent operating guide (user-customizable) |
| `USER.md` | User information |
| `TOOLS.md` | Local tool notes |
| `MEMORY.md` | Agent long-term memory |
| `memory/` | Daily memory logs (`YYYY-MM-DD.md`) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.
