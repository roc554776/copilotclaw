# Gateway Singleton (raw requirement)

- gateway を CLI で起動したとき、CLI 自体は detach されてほしい
- 単一コマンドで gateway を restart できるようにしたい（stop → start を 1 コマンドで）
- 全体としてプロセスは 1 つだけ起動してほしい
- IPC socket はまだ使わない（一旦 HTTP server の health check で代用）
- VSCode のプロセス管理を参考にする（docs/references/vscode-process-management.md）
