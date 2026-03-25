# 要件提案（Proposal）

<!-- NOTE: このファイルが大きくなったら、トピックごとに別ファイルへ分割すること -->

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

### Multi-Channel アーキテクチャ

各 channel は独立した input queue と会話履歴を持つ。

```
human → dashboard tab (POST /api/channels/{{channelId}}/inputs) → channel queue
                                                                       ↓
                                              gateway: agent を ensure（IPC で生存確認、なければ起動）
                                                                       ↓
agent ← copilotclaw_receive_first_input ← (POST /api/channels/{{channelId}}/inputs/next)
agent → [LLM 処理] → copilotclaw_reply_and_receive_input
                         ↓                              ↓
    POST /api/channels/{{channelId}}/replies    POST /api/channels/{{channelId}}/inputs/next
                         ↓                              ↓
              dashboard に表示           次の user input を受け取り（複数なら一括）
```

## アーキテクチャ方針: Agent シングルトンと Gateway-Agent 分離

### 方針: 単一 Agent プロセスによるマルチチャンネル管理

Agent は 1 プロセスで全チャンネルを管理する。チャンネルごとに独立した Copilot SDK セッションを作成する（1 セッションに複数チャンネルを流し込むのではない）。Gateway と Agent は独立プロセスとして稼働し、起動は常に gateway → agent。

### Agent IPC サーバー

VSCode の singleton パターン（`net.createServer().listen(socketPath)` → EADDRINUSE で既存検出）を採用する。

```
Agent 起動
  → IPC socket path を決定的に生成（プロセス単位、チャンネルごとではない）
  → net.createServer().listen(socketPath)
    → 成功 → IPC リクエスト受付 + gateway ポーリング開始
    → EADDRINUSE → net.createConnection(socketPath)
      → 成功 → 既存 agent 稼働中、このプロセスは終了
      → ECONNREFUSED → stale socket を unlink して再試行
```

IPC ソケット上で改行区切り JSON を送受信する。

### Agent IPC プロトコル

| メソッド | 応答 | 用途 |
| :--- | :--- | :--- |
| `status` | `{ startedAt, channels: { [channelId]: ChannelStatus } }` | 全チャンネルの状態を一括取得 |
| `channel_status` (params: `{ channelId }`) | `ChannelStatus` | 個別チャンネルの状態を取得 |
| `stop` | `{ ok: true }` | graceful shutdown |

ChannelStatus:

| フィールド | 型 | 意味 |
| :--- | :--- | :--- |
| `status` | `"starting" \| "waiting" \| "processing"` | セッションの状態 |
| `startedAt` | `string` | セッション開始時刻 |
| `processingStartedAt?` | `string` | processing 状態に入った時刻 |

### Agent プロセスの内部動作

```
Agent プロセス起動
  → IPC サーバー開始
  → gateway ポーリングループ開始（全チャンネルの inputs/next を巡回）
    → チャンネルに未処理 user input あり かつ セッション未起動 → セッション起動
    → チャンネルセッションが processing のまま staleTimeout (default 10 min) 超過
      → 同一チャンネルの最古 user input が前回と同じ → retryCount++
        → retryCount > 1 → 当該チャンネルの user input を全て flush、セッション停止
        → retryCount <= 1 → セッション再起動（1 回だけリトライ）
      → 最古 user input が変わっている → retryCount リセット、セッション再起動
```

### Gateway の Agent 管理

Gateway の責務は user input の管理、agent プロセスの ensure、チャットシステムの提供。Agent 内部のチャンネル管理には関与しない。

```
Gateway: user input 受信時
  → IPC で agent プロセスの生存確認
    → 接続不可 → agent を detached spawn で起動
    → 接続可 → 何もしない（agent が自分で gateway をポーリングしてチャンネルセッションを起動する）
```

### IPC Socket パス

`{{tmpdir}}/copilotclaw-agent.sock` を使用する（プロセス単位、チャンネルごとではない）。

### Channel ツール

カスタムツール名は `copilotclaw_` プレフィクスで統一する。

| ツール名 | 用途 |
| :--- | :--- |
| `copilotclaw_receive_first_input` | セッション初期化時に最初の user input をポーリングで受け取る |
| `copilotclaw_reply_and_receive_input` | reply を送信後、次の user input をポーリングで受け取る |

- 両ツールとも channel ID スコープで動作する（agent 起動時に channel ID が渡される）
- 受け取った user input に「`copilotclaw_reply_and_receive_input` で reply すること」という指示を付加して返す
- Agent は session idle 時に常にブロックされ、`copilotclaw_reply_and_receive_input` の呼び出しを指示される
- 同一 channel に未処理の user input が複数ある場合、一括取得して連結して返す

### Gateway の起動フロー

VSCode の CLI デタッチ方式（`spawn({ detached: true })` + `child.unref()`）を参考に、CLI プロセスとサーバープロセスを分離する。

```
CLI (copilotclaw gateway start)
  → health check
  → healthy → "already running" を表示して CLI 終了
  → unhealthy → リトライ（数回）→ タイムアウトで起動失敗
  → port free → サーバープロセスを detached spawn → health check で起動確認 → CLI 終了

サーバープロセス (detached, バックグラウンド)
  → HTTP サーバーを起動
  → SIGTERM / /api/stop で graceful shutdown
```

### API エンドポイント

| エンドポイント | メソッド | 機能 |
| :--- | :--- | :--- |
| `/healthz` | GET | ヘルスチェック |
| `/api/channels` | GET | channel 一覧 |
| `/api/channels` | POST | 新しい channel を作成 |
| `/api/channels/pending` | GET | 各チャンネルの未処理 user input 数を取得 |
| `/api/channels/{{channelId}}/inputs` | POST | channel に user input を投稿（キューに追加）。対応 agent がなければ自動起動 |
| `/api/channels/{{channelId}}/inputs/next` | POST | channel のキューから未処理 user input を一括取得（なければ即時空応答） |
| `/api/channels/{{channelId}}/inputs/peek` | GET | channel の最古の未処理 user input を取得（非破壊的） |
| `/api/channels/{{channelId}}/inputs/flush` | POST | channel の全 user input をクリア（スタック回復時に使用） |
| `/api/channels/{{channelId}}/replies` | POST | channel の user input に対して reply を投稿 |
| `/api/stop` | POST | gateway を停止する |
| `/` | GET | dashboard（channel タブ切り替え + チャット UI） |

### データモデル（インメモリ）

- Channel: `{ id, createdAt }`
- UserInput: `{ id, channelId, message, createdAt, reply?: { message, createdAt } }`
- 各 channel が独立した未取得 UserInput の FIFO キューを持つ

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
