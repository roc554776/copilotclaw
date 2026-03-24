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

Start the gateway (HTTP server) and the agent as two separate processes, then interact via the browser.

### Start the gateway

```sh
pnpm --filter @copilotclaw/gateway run start
```

The dashboard opens at http://localhost:19741.

### Start the agent

In a separate terminal:

```sh
pnpm --filter @copilotclaw/agent run start
```

The agent begins polling the gateway for user input.

### Interact

Open http://localhost:19741 in your browser, type a message, and press Send. The agent will reply.

### Stop the gateway

```sh
pnpm --filter @copilotclaw/gateway run stop
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.
