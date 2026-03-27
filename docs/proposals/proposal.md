# 要件提案（Proposal）

本ドキュメント群は、要求定義に基づき、CopilotClaw プロジェクトとしてどのように要求を実現するかの提案（要件）を示す。

## ファイル構成

| ファイル | 内容 |
|---|---|
| [architecture-overview.md](architecture-overview.md) | プロダクトコンセプト・アーキテクチャ共通方針 |
| [gateway.md](gateway.md) | Gateway パターン（起動フロー・API・Dashboard・永続化） |
| [channel.md](channel.md) | Channel パターン（Multi-Channel・ツール・通知） |
| [agent.md](agent.md) | Agent シングルトン・Agent Session・Custom Agents・Subagent 通知・システムプロンプト補強 |
| [cli-install-workspace.md](cli-install-workspace.md) | CLI 設計原則・Install/Workspace/Update・Profile・設定 |
| [features-nfr.md](features-nfr.md) | 機能要件・非機能要件・技術スタック |
| [workspace-bootstrap.md](workspace-bootstrap.md) | Workspace Bootstrap Files（SOUL.md, AGENTS.md 等）・Memory・Git 管理 |
| [profile.md](profile.md) | Profile 機能の完成（全コンポーネントの profile パラメータ伝搬修正） |
| [status.md](status.md) | 現状と今後の課題 |
