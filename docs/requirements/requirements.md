# 要求定義（Requirements）

本ドキュメント群は、顧客の生の要望（raw requirements）を整理し、プロジェクトとして達成すべき要求を明確化したものである。

## ファイル構成

| ファイル | 内容 |
|---|---|
| [project-goal.md](project-goal.md) | プロジェクトの背景・目的・スコープ・前提条件・現状 |
| [gateway.md](gateway.md) | 中央集権的な Gateway プロセス |
| [channel.md](channel.md) | Multi-Channel（Gateway 経由の Agent-User 対話） |
| [agent.md](agent.md) | Agent シングルトン・Agent Session 分離・記憶保持 |
| [custom-agents.md](custom-agents.md) | Custom Agents・システムプロンプト補強・Subagent 通知 |
| [testing.md](testing.md) | 自動テストの義務化 |
| [infrastructure.md](infrastructure.md) | monorepo 構成・Dashboard・Session 可視化・Profile・設定・CLI 設計 |
| [workspace.md](workspace.md) | Workspace Bootstrap Files・Memory・Git 管理 |
| [profile.md](profile.md) | Profile 機能の完成（profile 別動作の網羅的修正） |
