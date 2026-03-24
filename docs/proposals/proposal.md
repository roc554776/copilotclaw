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

### 方針: Gateway と Agent の独立プロセス化

Gateway と Agent は独立したプロセスとして稼働する。Gateway 再起動時に Agent を道連れにしないためである。Agent は channel ID ごとに IPC socket（Unix domain socket）でシングルトン動作する。

### Agent IPC サーバー

VSCode の singleton パターン（`net.createServer().listen(socketPath)` → EADDRINUSE で既存検出）を採用する。

```
Agent 起動
  → IPC socket path を channel ID から決定的に生成
  → net.createServer().listen(socketPath)
    → 成功 → このプロセスが agent として稼働、IPC リクエストを受け付ける
    → EADDRINUSE → net.createConnection(socketPath)
      → 成功 → 既存 agent が稼働中、このプロセスは終了
      → ECONNREFUSED → stale socket を unlink して再試行
```

IPC ソケット上で改行区切り JSON を送受信する。

### Agent IPC プロトコル

| メソッド | 応答 | 用途 |
| :--- | :--- | :--- |
| `status` | `{ status, startedAt, restartedAt? }` | 現在の状態を返す |
| `stop` | `{ ok: true }` | graceful shutdown |
| `restart` | `{ ok: true }` | Copilot session を再作成して再開 |

status の値:

| 値 | 意味 |
| :--- | :--- |
| `starting` | 起動直後、Copilot session 未確立 |
| `waiting` | user input をポーリングで待機中 |
| `processing` | user input を LLM で処理中 |

### Gateway の Agent 管理

Gateway は Agent を直接の子プロセスとしては持たず、IPC 経由で外から管理する。

```
Gateway: user input 受信時
  → IPC で agent の status を取得
    → 接続不可 → agent を detached spawn で起動、IPC で起動確認
    → status = waiting / starting → 何もしない（agent が自分で poll する）
    → status = processing かつ経過時間 > staleTimeout (default 10 min)
      → IPC で restart を送信
      → status 変化を確認
```

### IPC Socket パス

`{{tmpdir}}/copilotclaw-agent-{{channelId}}.sock` を使用する。channel ID から決定的に導出されるため、gateway と agent が共通のパスを知ることができる。

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
| `/api/channels/{{channelId}}/inputs` | POST | channel に user input を投稿（キューに追加）。対応 agent がなければ自動起動 |
| `/api/channels/{{channelId}}/inputs/next` | POST | channel のキューから未処理 user input を一括取得（なければ即時空応答） |
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
