# 要求定義（Requirements）

本ドキュメントは、顧客の生の要望（raw requirements）を整理し、プロジェクトとして達成すべき要求を明確化したものである。

## 背景

- GitHub Copilot のサブスクリプションを持つ開発者は、LLM の能力を Copilot 経由で利用できる
- OpenClaw のような Agent 体験（対話的にタスクを遂行する CLI エージェント）が広く認知されつつある
- 現状、Copilot のサブスクリプションだけでは自前の Agent 体験を構築する手段が限られている

## 要求

### Req: Agent 体験の提供

GitHub Copilot SDK を用いて、OpenClaw に相当する Agent 体験を提供する。

- OpenClaw は参考プロダクトであり、クローンを作ることが目的ではない
- OpenClaw が実現している「対話的にコーディングタスクを遂行する CLI エージェント」の体験カテゴリを、Copilot SDK 上で実現することが目的である

### Req: Copilot サブスクリプションの活用

GitHub Copilot のサブスクリプションを持つユーザーが、追加の LLM 契約なしに Agent 体験を利用できるようにする。

- Copilot SDK が提供する LLM アクセスを活用し、別途 API キーや課金が不要であること

### Req: 独自の価値提供

単なる OpenClaw の模倣ではなく、Copilot SDK のエコシステム（Copilot Extensions、OTEL テレメトリ等）を活かした独自の価値を追求する。

## スコープ外（現時点）

- GUI / Web UI の提供（CLI が主体）
- OpenClaw との機能パリティの保証
- GitHub Copilot 以外の LLM プロバイダのサポート

## 前提条件

- ユーザーは GitHub Copilot のサブスクリプションを保有していること
- GitHub Copilot SDK が提供する API・機能が利用可能であること

## 現状

- Observability スタック（OTEL テレメトリ収集・可視化）は構築済みで、動作検証が完了している
- GitHub Copilot Hooks によるイベントログ記録の仕組みが導入済み
- Agent 本体の実装はこれからである
