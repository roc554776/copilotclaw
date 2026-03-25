# CopilotClaw

A CLI agent built on the GitHub Copilot SDK. Provides an interactive agent experience for software development tasks using only a GitHub Copilot subscription.

## Prerequisites

- GitHub Copilot subscription
- [mise](https://mise.jdx.dev/) (manages Node.js and pnpm versions)

## Setup

```sh
mise install
pnpm install
pnpm run build
```

## Try it out

### Start the gateway

```sh
pnpm --filter @copilotclaw/gateway run start
```

The gateway starts as a background daemon on http://localhost:19741.

### Interact

Open http://localhost:19741 in your browser, type a message, and press Send. The gateway automatically starts the agent process, which handles user input and replies via the Copilot SDK.

Use the "+" button to create additional channels for parallel conversations.

### Stop

```sh
pnpm --filter @copilotclaw/gateway run stop
```

This stops both the gateway and the agent process.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.
