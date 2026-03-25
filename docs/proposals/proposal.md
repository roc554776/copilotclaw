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
- dashboard でのシステムステータス表示（gateway status、agent version、agent session 状態）
- dashboard のリアルタイム更新（SSE によるプッシュ型通信）
- dashboard ステータスバーの詳細モーダル（クリックで gateway/agent の詳細表示）
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
agent ← copilotclaw_receive_input ← (POST /api/channels/{{channelId}}/inputs/next)
agent → [LLM 処理] → copilotclaw_send_message で途中報告（即時 return）
                         ↓
    POST /api/channels/{{channelId}}/messages → dashboard に表示
agent → copilotclaw_send_message で最終回答 → copilotclaw_receive_input で次の入力を待機
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
| `status` | `{ version, startedAt, sessions: { [sessionId]: AgentSessionInfo } }` | 全 agent session の状態を一括取得（version を含む） |
| `session_status` (params: `{ sessionId }`) | `AgentSessionInfo` | 個別 agent session の状態を取得 |
| `stop` | `{ ok: true }` | graceful shutdown |

AgentSessionInfo:

| フィールド | 型 | 意味 |
| :--- | :--- | :--- |
| `status` | `"starting" \| "waiting" \| "processing" \| "stopped" \| "not_running"` | セッションの状態 |
| `startedAt` | `string` | セッション開始時刻 |
| `processingStartedAt?` | `string` | processing 状態に入った時刻 |
| `boundChannelId?` | `string` | 紐づいている channel の ID |

### Agent バージョン互換性


Agent は自身のバージョン（セマンティックバージョニング）を持ち、IPC `status` レスポンスの `version` フィールドで返す。

Gateway は必要とする agent の最低バージョン（`MIN_AGENT_VERSION`）を定義する。Agent の ensure 時にバージョンを確認し、以下の場合はエラーとする:
- Agent のバージョンが `MIN_AGENT_VERSION` 未満
- Agent が `version` フィールドを返さない（バージョン未対応の古い agent）

```
Gateway: agent ensure
  → IPC status 取得
  → version フィールドなし → エラー（agent が古すぎる）
  → version < MIN_AGENT_VERSION → エラー（互換性なし）
  → version >= MIN_AGENT_VERSION → 正常
```

#### 古い Agent の強制停止と再起動


gateway の起動時に、最低バージョンを充たさない agent が稼働中の場合、オプション指定により強制的に停止・再起動できるようにする。

```
copilotclaw gateway start --force-agent-restart
  → IPC status 取得
  → version < MIN_AGENT_VERSION → IPC stop → agent 停止 → 新しい agent を spawn
```

### Agent 手動停止コマンド


Gateway と同様に、agent にも CLI からの停止コマンドを提供する。

```
copilotclaw agent stop
  → IPC で agent に stop リクエスト送信
  → agent が graceful shutdown
```

`packages/agent/src/stop.ts` として実装し、package.json の scripts に `stop` を追加する。

### Agent プロセスの内部動作

```
Agent プロセス起動
  → IPC サーバー開始
  → gateway ポーリングループ開始（GET /api/channels/pending で各チャンネルの pending 数を確認）
    → チャンネルに未処理 user input あり かつ セッション未起動 → セッション起動
    → チャンネルセッションが processing のまま staleTimeout (default 10 min) 超過
      → restartCount == 0 → セッション再起動（1 回だけリトライ）、restartCount を 1 に
      → restartCount >= 1 → 当該チャンネルの user input を全て flush、セッション停止
      → 再起動成功後は restartCount をリセット
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

## アーキテクチャ方針: Agent Session

### 方針: Channel と Agent Session の分離

Agent session を channel から独立した概念として導入し、agent process が管理する。

- Agent session は Copilot SDK の session に対応し、独自の sessionId を持つ
- Channel には最大 1 つの agent session が紐づく
- Agent session には最大 1 つの channel が紐づく
- Channel に未処理のユーザー input があるが agent session がない場合、agent session が開始され channel と紐づく
- Channel のユーザー input が全て処理されても agent session は終了せずに生かし続ける（agent session は高価なので壊さない）- Channel に紐づかない agent session も存在しうる（まだ実装はないが） <!-- TODO: 未実装 -->

### Session Keepalive 方針

`client.send()` は session の開始時以外には使わない（コスト最小化の原則）。CLI の 30 分 idle timeout を回避するため、`copilotclaw_receive_input` tool の内部で input をポーリングしながら待機する。tool が実行中の間はセッションは active 扱いとなり timeout しない。

```
Agent session 起動（session.send を 1 回だけ使用）
  → LLM が copilotclaw_receive_input を呼ぶ（tool 内で input をポーリング待機）
  → timeout 接近（25 分経過）
    → input なしで tool を返す（空の結果 + 再呼び出し指示）
    → LLM が再び copilotclaw_receive_input を呼ぶ（session.send 不要）
  → input 到着
    → tool が input を返す → LLM が処理
    → copilotclaw_send_message で途中報告（即時 return、何度でも呼べる）
    → 処理完了 → copilotclaw_send_message で最終回答
    → copilotclaw_receive_input で次の入力を待機
  → 作業中に新着通知（onPostToolUse hook の additionalContext）
    → LLM が copilotclaw_receive_input を呼んで user input を取得
```

この方式により:
- `session.send()` は session 開始時の 1 回のみ（以降は LLM が自律的に tool を呼び続ける）
- セッションは tool 実行中として生かし続けられる
- `copilotclaw_send_message` は即時 return なので、作業を中断せずに状況報告できる
- 新着 user input は `onPostToolUse` hook の `additionalContext` で LLM に通知される

### Agent Session の意図しない停止とリカバリ


LLM が tool を呼ばずに idle になった場合、`session.send()` による停止阻止はしない（コスト最小化の原則）。このとき agent session は意図せず停止する。

```
Agent session idle（LLM が tool を呼ばなかった）
  → session.send() は呼ばない → session 停止
  → session status を "stopped" に設定
  → channel に紐づく session だった場合
    → channel に「agent session が意図せず停止した」ことを通知する
      （例: gateway の messages API にシステムメッセージとして投稿）
  → session は sessions Map から削除、channel binding も解除
```

停止後のリカバリ:
- channel にアクティブな agent session がない状態になる
- この channel に新たに user がメッセージを送った場合、gateway は agent process に agent session の新規起動と channel への紐づけを要求する（通常の起動フローと同じ）

### Channel ツール

カスタムツール名は `copilotclaw_` プレフィクスで統一する。

| ツール名 | 用途 | 戻り |
| :--- | :--- | :--- |
| `copilotclaw_send_message` | channel にメッセージを送信する | 即時 return |
| `copilotclaw_receive_input` | channel の未処理 user input をポーリングで受け取る | input 到着 or keepalive timeout で return |
| `copilotclaw_list_messages` | channel の過去メッセージを取得する | 即時 return |

#### copilotclaw_send_message

- パラメータ: `{ message: string }`
- channel にメッセージを POST し、即座に return する
- 作業途中の状況報告に使用する（ポーリングを伴わないため、作業フローをブロックしない）

#### copilotclaw_receive_input

- パラメータ: なし
- channel の未処理 user input をポーリングで待機する（keepalive timeout: 25 分）
- 同一 channel に未処理の user input が複数ある場合、一括取得して連結して返す
- keepalive timeout 到達時は空の結果を返し、即座に再呼び出しを指示する
- session が idle になるのはこの tool の keepalive timeout 時のみ（`session.send()` によるプレミアムリクエスト消費は約 30 分に 1 回）

#### copilotclaw_list_messages

- パラメータ: `{ limit?: number }`（デフォルト: 5）
- channel の過去メッセージを最新順に取得する
- 各メッセージに sender（`"user"` or `"agent"`）を付与する

### Post Tool Use Hook による新着通知


channel に紐づく agent session では、SDK の `onPostToolUse` hook を登録する。

```
任意の tool 実行完了
  → onPostToolUse 発火
  → 当該 channel に未読の user input があるか gateway に確認
  → 未読あり → additionalContext に通知を追加:
    「新しい user input があります。copilotclaw_receive_input で即時確認してください。」
  → 未読なし → 何もしない
```

channel に紐づく agent session の起動時プロンプトには、「tool の response の additionalContext で新着通知がされる可能性がある」ことを含める。

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
| `/api/channels/{{channelId}}/messages` | GET | channel のメッセージ一覧（sender 付き、最新順、`?limit=N`） || `/api/channels/{{channelId}}/messages` | POST | channel にメッセージを投稿（agent からの送信用） || `/api/channels/{{channelId}}/replies` | POST | channel の user input に対して reply を投稿（後方互換、将来廃止予定） |
| `/api/events` | GET | SSE エンドポイント（`?channel={{channelId}}` でリアルタイムイベント購読） |
| `/api/status` | GET | gateway と agent のステータス一括取得 |
| `/api/stop` | POST | gateway を停止する |
| `/` | GET | dashboard（channel タブ切り替え + チャット UI） |

### データモデル（インメモリ）

- Channel: `{ id, createdAt }`
- UserInput: `{ id, channelId, message, createdAt, reply?: { message, createdAt } }`
- Message: `{ id, channelId, sender: "user" | "agent", message, createdAt }`- 各 channel が独立した未取得 UserInput の FIFO キューを持つ
- Message は channel の全メッセージ（user input と agent メッセージ）を時系列で保持する

### Dashboard リアルタイム更新

Dashboard の chat とステータスバーをリアルタイムに更新するため、Server-Sent Events（SSE）によるプッシュ型通信を使用する。WebSocket ではなく SSE を採用した理由は、Node.js 22 に WebSocketServer が組み込まれていないため（外部依存なしの方針）。

- Gateway が SSE エンドポイント（`GET /api/events?channel={{channelId}}`）を提供する
- クライアントは `EventSource` で接続し、購読する channel を指定する
- サーバーは以下のイベントをプッシュする:
  - 新しいメッセージ（user input / agent message）
  - agent session の状態変化（`/api/status` のポーリングで補完）
- ステータスバーは SSE イベント + 5 秒間隔の `/api/status` ポーリングで更新する

### Dashboard ステータス詳細モーダル

ステータスバーをクリックすると、gateway と agent の詳細ステータスを表示するモーダルを表示する。Escape キーまたはオーバーレイクリックで閉じる。

モーダルに表示する情報:
- Gateway: status
- Agent: version, startedAt
- Sessions: 各 session の状態と boundChannelId

## 機能要件

### Feat: コーディング支援ツール群
<!-- TODO: 未実装 -->

エージェントが利用できるツールとして、少なくとも以下を備える:

- ファイルの読み書き
- シェルコマンドの実行
- コードベースの検索（ファイル名・内容）
- Git 操作

### Feat: コンテキスト管理
<!-- TODO: 未実装 -->

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
<!-- TODO: 未実装 — ツール実行時のパーミッション制御 -->

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
- Copilot SDK を用いた Agent（session keepalive による停止制御を含む）
- pnpm monorepo 構造（tsconfig strictest 相当の設定）
- Gateway サーバー（インメモリ Store、API、チャット UI dashboard、冪等起動）
- Channel 機能（gateway 経由の agent-user 対話、`copilotclaw_` プレフィクスのカスタムツール）
- Channel ツール統廃合（`copilotclaw_send_message` / `copilotclaw_receive_input` / `copilotclaw_list_messages`）
- `onPostToolUse` hook による新着 user input 通知
- `session.send()` 排除（session 開始時のみに限定）
- Gateway の Messages API（`GET/POST /api/channels/{{channelId}}/messages`）
- Agent バージョン互換性チェック（IPC `status` に `version` 追加、gateway 側で最低バージョン検証）
- Agent 手動停止コマンド（`packages/agent/src/stop.ts`）
- Dashboard ステータスバー（gateway status、agent version、session 状態の表示）
- 古い agent の強制停止・再起動オプション（`gateway start --force-agent-restart`）
- Agent session の意図しない停止時の channel 通知と "stopped" status
- Dashboard リアルタイム更新（SSE によるプッシュ型通信）
- Dashboard ステータス詳細モーダル（クリックで gateway/agent 詳細表示）
- 自動テスト基盤（Vitest、mock session、mock fetch による agent テスト）

**今後の課題:**
- コーディング支援ツール群（ファイル操作・シェル実行・検索・Git）の実装
- Observability スタックの独立リポジトリへの分離（`.example` パターンの導入を含む）
