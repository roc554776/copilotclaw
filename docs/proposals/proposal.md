# 要件提案（Proposal）

本ドキュメントは、要求定義に基づき、CopilotClaw プロジェクトとしてどのように要求を実現するかの提案（要件）を示す。

## プロダクトコンセプト

CopilotClaw は、GitHub Copilot SDK を基盤とした CLI エージェントである。GitHub Copilot のサブスクリプションのみで、対話的にソフトウェア開発タスクを遂行する Agent 体験を提供する。

## アーキテクチャ方針

### 方針: Copilot SDK ファーストの設計

- GitHub Copilot SDK が提供する LLM アクセス、ツール呼び出し、コンテキスト管理を最大限に活用する
- SDK の制約や特性を理解した上で、その上に Agent ロジックを構築する
- SDK の進化に追従しやすい疎結合な設計とする

### 方針: Observability の組み込み

- OTEL テレメトリによるトークン使用量・レイテンシ・エラーの可視化を標準で提供する（構築済み）
- Agent の振る舞いを事後的に分析・改善できる基盤とする

### 方針: 拡張性の確保

- Copilot Extensions エコシステムとの連携を視野に入れる
- ツール（ファイル操作、シェル実行、検索等）はプラグイン的に追加・削除できる構造とする

## アーキテクチャ方針: Gateway パターン

### 方針: 単一プロセスによる中央集権制御

VSCode がそうであるように、copilotclaw も単一の常駐プロセス（gateway）がシステム全体を統制する。gateway は固定ポート（19741）で HTTP サーバーを起動し、多重起動を防止する。

### Gateway の責務

- user input のキューイング（FIFO）
- agent からの reply の受け付けと user input との紐付け
- dashboard ページによるチャット UI（メッセージ入力 + user input / reply の時系列表示）
- healthz エンドポイントによる生存確認

## アーキテクチャ方針: Channel パターン

### 方針: Gateway 経由の Agent-User 対話

Agent と human は gateway の API を介して対話する。Agent は Copilot SDK の `defineTool` で定義されたカスタムツールを通じて gateway と通信する。

### Channel のフロー

```
human → dashboard (POST /api/inputs) → gateway queue
                                           ↓
agent ← copilotclaw_receive_first_input ← (poll /api/inputs/next)
agent → [LLM 処理] → copilotclaw_reply_and_receive_input
                         ↓                              ↓
              POST /api/replies              poll /api/inputs/next
                         ↓                              ↓
              dashboard に表示           次の user input を受け取り
```

### Channel ツール

カスタムツール名は `copilotclaw_` プレフィクスで統一する。

| ツール名 | 用途 |
| :--- | :--- |
| `copilotclaw_receive_first_input` | セッション初期化時に最初の user input をポーリングで受け取る |
| `copilotclaw_reply_and_receive_input` | reply を送信後、次の user input をポーリングで受け取る |

- 両ツールとも、受け取った user input に「`copilotclaw_reply_and_receive_input` で reply すること」という指示を付加して返す
- Agent は session idle 時に常にブロックされ、`copilotclaw_reply_and_receive_input` の呼び出しを指示される

### Gateway の起動フロー

```
起動コマンド
  → ポートに health check
  → healthy → 既に起動済み、何もしない
  → ポート使用中だが unhealthy → リトライ（数回）→ タイムアウトで起動失敗
  → ポート空き → サーバーを起動
```

### API エンドポイント

| エンドポイント | メソッド | 機能 |
| :--- | :--- | :--- |
| `/healthz` | GET | ヘルスチェック |
| `/api/inputs` | POST | user input を投稿（キューに追加） |
| `/api/inputs/next` | POST | キューから user input を取り出し（FIFO, なければ即時空応答） |
| `/api/replies` | POST | user input の id に対して reply を投稿 |
| `/` | GET | dashboard ページ（user input と reply のペア一覧） |

### データモデル（インメモリ）

- UserInput: `{ id, message, createdAt, reply?: { message, createdAt } }`
- キュー: 未取得の UserInput の FIFO キュー

## 機能要件

### Feat: 対話型 CLI インターフェース

- ターミナル上で対話的にプロンプトを入力し、エージェントがタスクを遂行する
- ストリーミング応答をサポートし、リアルタイムで結果を表示する

### Feat: コーディング支援ツール群

エージェントが利用できるツールとして、少なくとも以下を備える:

- ファイルの読み書き
- シェルコマンドの実行
- コードベースの検索（ファイル名・内容）
- Git 操作

### Feat: コンテキスト管理

- 作業ディレクトリのコードベースをコンテキストとしてエージェントに提供する
- 会話履歴を適切に管理し、長い対話でもコンテキストを維持する

### Feat: テレメトリ収集と可視化

- GitHub Copilot の OTEL テレメトリを収集し、Grafana ダッシュボードで可視化する（実装済み）
- トークン使用量をモデル別に追跡可能とする（実装済み）

## 非機能要件

### NFR: 自動テスト

すべての実装に自動テストを必須とする。テストは以下の三層で構成する。

| レイヤー | スコープ | 特性 |
| :--- | :--- | :--- |
| Unit | 単一モジュールの純粋ロジック | 外部依存なし、高速 |
| Integration | DB 等の外部リソースとの結合 | 現時点では該当なし（インメモリのため） |
| E2E | サーバー起動 + API / UI の検証 | 専用ポートで分離、Copilot は mock |

### テスト技術スタック

| ツール | 用途 |
| :--- | :--- |
| Vitest | テストランナー（unit / integration / E2E API） |
| Playwright | フロントエンド E2E |

### テスト分離の方針

- E2E テストは専用ポート（ランダムポート `port: 0`）でサーバーを起動する
- GitHub Copilot SDK への依存はすべて mock する（認証要件および BAN リスク回避）
- テストダブル（mock / stub）はテスト実装の一部としてその場で完結させる。テストダブルの不在を理由にテストを skip にしてはならない
- `skip` が許されるのは、テスト対象の機能自体がまだ存在しない場合のみ


### NFR: セキュリティ

- ツール実行時のパーミッション制御（ユーザーの承認なしに破壊的操作を行わない）
- 機密情報（API キー、認証情報等）の漏洩防止

### NFR: ポータビリティ

- macOS / Linux 環境で動作すること
- Docker Compose による Observability スタックのセットアップが容易であること（実装済み）

## 技術スタック（提案）

| レイヤー | 技術 | 選定理由 |
| :--- | :--- | :--- |
| Agent ランタイム | GitHub Copilot SDK | 要求に基づく必須選定 |
| Gateway サーバー | Node.js 標準 `node:http` | 外部依存なし・軽量 |
| テストランナー | Vitest | TypeScript ネイティブ・ESM 対応・高速 |
| フロントエンド E2E | Playwright | ブラウザ自動化の標準 |
| CLI フレームワーク | 未定（SDK の提供形態に依存） | SDK の API 設計を確認後に決定 |
| テレメトリ収集 | OpenTelemetry Collector | 構築済み・Copilot OTEL と親和性が高い |
| メトリクス | Prometheus | 構築済み |
| ログ | Loki | 構築済み |
| トレース | Tempo | 構築済み |
| 可視化 | Grafana | 構築済み |

## 現状と今後

**実装済み:**
- Observability スタック一式（OTel Collector → Loki / Tempo / Prometheus → Grafana）
- Copilot Hooks によるイベントログ記録
- Grafana ダッシュボード（Copilot Token Usage）
- Copilot SDK を用いた Agent（session idle loop による停止制御を含む）
- pnpm monorepo 構造（tsconfig strictest 相当の設定）
- Gateway サーバー（インメモリ Store、API、チャット UI dashboard、冪等起動）
- Channel 機能の初版（gateway 経由の agent-user 対話、`copilotclaw_` プレフィクスのカスタムツール）
- 自動テスト基盤（Vitest、mock session、mock fetch による agent テスト）

**今後の課題:**
- コーディング支援ツール群（ファイル操作・シェル実行・検索・Git）の実装
- Observability スタックの独立リポジトリへの分離（`.example` パターンの導入を含む）
