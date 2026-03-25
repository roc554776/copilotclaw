<!-- Generated: 2026-03-25 | Token estimate: ~200 -->

# Dependencies

## Runtime

| Package | Used by | Purpose |
|---------|---------|---------|
| `@github/copilot-sdk` | agent | LLM access via GitHub Copilot (mocked in tests) |
| `node:http` | gateway | HTTP server (no framework) |
| `node:net` | agent, gateway | IPC via Unix domain socket |

## Dev

| Package | Purpose |
|---------|---------|
| `typescript` ^6.0.2 | Compiler |
| `vitest` ^4.1.1 | Test runner (unit + E2E) |
| `@types/node` ^22.0.0 | Node.js type definitions |

## Tooling

| Tool | Purpose |
|------|---------|
| `mise` | Node.js + pnpm version management |
| `pnpm` | Package manager (monorepo workspaces) |
