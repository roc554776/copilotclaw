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

## Codebase Reference

`docs/CODEMAPS/` contains architecture maps (routes, file mappings, dependencies). Read before exploring unfamiliar areas.

## Structure

```
packages/
  agent/     — Agent process using the Copilot SDK
  gateway/   — Central HTTP server (input queue, reply, dashboard)
observability/ — OTEL telemetry collection and visualization stack (Grafana, Prometheus, Loki, Tempo)
docs/          — Requirements, proposals, and references
```

## Serena

Changes under `.serena/` can always be committed without explicit approval.

## Testing

Every implementation must include automated tests. PRs with implementation only and no tests will not be merged.

- All dependencies on the GitHub Copilot SDK must be mocked — including in E2E tests. Real Copilot sessions must never be used in automated tests (authentication requirement and BAN risk)
- Test doubles (mocks / stubs) must be implemented in place. Tests must never be skipped due to missing test doubles
- E2E tests start servers on dedicated ports (`port: 0`) to isolate from the production environment
