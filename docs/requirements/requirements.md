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

### Req: 中央集権的な Gateway プロセス

VSCode のように、単一の常駐プロセス（gateway）がシステム全体を統制する構造とする。

- gateway は固定ポートで HTTP サーバーを起動し、多重起動を防止する
- user input のキューイングと agent の reply の管理を担う
- dashboard ページで user input と reply のペアを一覧表示する
- 起動コマンドは冪等であること: 既に起動済みなら何もしない、ポートが塞がっているが healthy でなければリトライ後タイムアウト

### Req: 自動テストの義務化

すべての実装には自動テストが伴わなければならない。テストのない実装のみの PR はマージしない。

- unit / integration / E2E の各レイヤーを整備する
- unit: 外部依存なし。純粋なロジックのテスト
- integration: DB など外部リソースへの依存を含むテスト
- E2E: 実際にサーバーを起動してエンドポイントや UI を検証するテスト
- GitHub Copilot は E2E であっても mock を使う（認証要件と BAN リスクのため）
- フロントエンドの E2E には Playwright を使用する
- E2E 環境は本番環境と完全に分離する（専用ポート、専用ビルドディレクトリ等）

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
- Copilot SDK を用いた Agent の hello world 実装が完了（session idle loop による停止制御を含む）
- Gateway サーバーの実装が完了（インメモリ Store、API エンドポイント、dashboard、冪等起動）
- 自動テスト基盤の整備はこれからである
