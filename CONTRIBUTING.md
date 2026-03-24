# Contributing

## Setup

```sh
mise install
pnpm install
```

## Commands

```sh
pnpm run build       # Build all packages
pnpm run typecheck   # Type check
pnpm run test        # Run tests
```

## Structure

```
packages/
  agent/     — Agent process using the Copilot SDK
  gateway/   — Central HTTP server (input queue, reply, dashboard)
observability/ — OTEL telemetry collection and visualization stack (Grafana, Prometheus, Loki, Tempo)
docs/          — Requirements, proposals, and references
```

## Testing

Every implementation must include automated tests. PRs with implementation only and no tests will not be merged.

- All dependencies on the GitHub Copilot SDK must be mocked
- Test doubles (mocks / stubs) must be implemented in place. Tests must never be skipped due to missing test doubles
- E2E tests start servers on dedicated ports (`port: 0`) to isolate from the production environment
