<!-- Generated: 2026-03-27 | Version: 0.23.0 | Token estimate: ~300 -->

# Dependencies

## Monorepo Packages

| Package | Path | Purpose |
|---------|------|---------|
| `copilotclaw-monorepo` | `/` (root) | Monorepo root (private, no bin/files) |
| `copilotclaw` | `packages/cli` | CLI wrapper — depends on `@copilotclaw/gateway` and `@copilotclaw/agent` via `workspace:*`; contains only `bin/copilotclaw.mjs` |
| `@copilotclaw/gateway` | `packages/gateway` | Gateway daemon |
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
| `node:module` | gateway (agent-manager) | createRequire to resolve @copilotclaw/agent package path |

## Dev

| Package | Purpose |
|---------|---------|
| `typescript` ^6.0.2 | Compiler |
| `vitest` ^4.1.1 | Test runner (unit + E2E, excludes test/browser/) |
| `@playwright/test` | Browser E2E test runner (test/browser/) |
| `@types/node` ^22.0.0 | Node.js type definitions |

## Tooling

| Tool | Purpose |
|------|---------|
| `mise` | Node.js + pnpm version management |
| `pnpm` | Package manager (monorepo workspaces) |
