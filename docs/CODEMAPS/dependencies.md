<!-- Generated: 2026-03-27 | Updated: 2026-03-31 | Version: 0.66.0 | Token estimate: ~500 -->

# Dependencies

## Monorepo Packages

| Package | Path | Purpose |
|---------|------|---------|
| `copilotclaw-monorepo` | `/` (root) | Monorepo root (private, no bin/files); pnpm.onlyBuiltDependencies: [better-sqlite3] |
| `copilotclaw` | `packages/cli` | CLI wrapper — depends on `@copilotclaw/gateway` and `@copilotclaw/agent` via `workspace:*`; contains only `bin/copilotclaw.mjs` |
| `@copilotclaw/gateway` | `packages/gateway` | Gateway daemon; `build` runs tsc + vite build (React SPA); `files` includes `frontend-dist/` for npm packaging |
| `@copilotclaw/agent` | `packages/agent` | Agent process |

## Runtime

| Package | Used by | Purpose |
|---------|---------|---------|
| `@github/copilot-sdk` | agent | LLM access via GitHub Copilot (mocked in tests) |
| `node:http` | gateway | HTTP server (no framework) |
| `node:net` | agent, gateway | IPC via Unix domain socket |
| `node:crypto` | agent, gateway | randomUUID for session/message IDs |
| `node:child_process` | agent | Token resolution (execFileSync for gh CLI and custom commands) |
| `node:fs` | agent, gateway | Structured log file writes (appendFileSync), agent stderr redirect (openSync) |
| `better-sqlite3` ^12.8.0 | gateway | SQLite database for store and session events (WAL mode) |
| `@opentelemetry/api` ^1.9.0 | gateway, agent | OTel API (metrics, global providers) |
| `@opentelemetry/api-logs` ^0.57.0 | gateway, agent | OTel Logs API (LoggerProvider, SeverityNumber) |
| `@opentelemetry/sdk-logs` ^0.57.0 | gateway, agent | OTel Logs SDK (LoggerProvider, SimpleLogRecordProcessor) |
| `@opentelemetry/sdk-metrics` ^1.30.0 | gateway, agent | OTel Metrics SDK (MeterProvider, PeriodicExportingMetricReader) |
| `@opentelemetry/exporter-logs-otlp-http` ^0.57.0 | gateway, agent | OTLP HTTP log exporter |
| `@opentelemetry/exporter-metrics-otlp-http` ^0.57.0 | gateway, agent | OTLP HTTP metric exporter |
| `@opentelemetry/resources` ^1.30.0 | gateway, agent | OTel Resource (service.name, service.version) |
| `@opentelemetry/semantic-conventions` ^1.28.0 | gateway, agent | Semantic convention attribute constants |
| `node:module` | gateway (agent-manager) | createRequire to resolve @copilotclaw/agent package path |

## Frontend (packages/gateway/frontend, v0.31.0)

| Package | Purpose |
|---------|---------|
| `react` ^19.1.0 | UI library (devDependency — frontend-only, not shipped with gateway runtime) |
| `react-dom` ^19.1.0 | React DOM renderer |
| `react-router-dom` ^7.6.2 | Client-side routing (BrowserRouter) |
| `recharts` | Charting library for token usage visualizations (LineChart, AreaChart) |
| `vite` ^6.3.5 | Build tool and dev server |
| `@vitejs/plugin-react` ^4.5.2 | Vite React plugin (JSX transform, Fast Refresh) |
| `@testing-library/react` ^16.3.0 | React component testing utilities |
| `@testing-library/jest-dom` ^6.6.3 | Custom DOM matchers for testing |
| `@testing-library/user-event` ^14.6.1 | User interaction simulation for tests |
| `jsdom` ^26.1.0 | DOM environment for vitest frontend tests |
| `@types/react` ^19.1.6 | React type definitions |
| `@types/react-dom` ^19.1.6 | React DOM type definitions |

## Dev

| Package | Purpose |
|---------|---------|
| `typescript` ^6.0.2 | Compiler |
| `@types/better-sqlite3` ^7.6.13 | Type definitions for better-sqlite3 |
| `vitest` ^4.1.1 | Test runner (unit + E2E, excludes test/browser/; also used for frontend tests) |
| `@playwright/test` | Browser E2E test runner (test/browser/) |
| `@types/node` ^22.0.0 | Node.js type definitions |

## Tooling

| Tool | Purpose |
|------|---------|
| `mise` | Node.js + pnpm version management |
| `pnpm` | Package manager (monorepo workspaces) |
