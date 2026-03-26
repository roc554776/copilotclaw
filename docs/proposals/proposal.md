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

- user message のキューイング（FIFO）
- agent からの reply の受け付けと user message との紐付け
- gateway start/restart 時に agent process を ensure する（プロセスの生存確認 + バージョンチェック、なければ spawn）。CLI コマンドが return する前に ensure を完了させ、失敗したらエラーを返す
- agent process の常時監視（起動していなければ起動、health check でバージョン確認、リトライアウト時はエラーログ）
- gateway stop 時に agent process は停止しない（agent session は高コストなので gateway restart 後もそのまま再利用するため）
- `/api/status` で agent が非互換なら `agentCompatibility: "incompatible"` を返す
- dashboard ページによるチャット UI（メッセージ入力 + user message / reply の時系列表示）
- dashboard でのシステムステータス表示（gateway status、agent version、agent session 状態、互換性ステータス）
- dashboard のリアルタイム更新（SSE によるプッシュ型通信）
- dashboard ステータスバーの詳細モーダル（クリックで gateway/agent の詳細表示）
- dashboard でのログ表示（gateway / agent のログを確認可能、`/api/logs` エンドポイント + Logs パネル）
- healthz エンドポイントによる生存確認

注意: user message POST 時に agent process を ensure するのではない。agent session の ensure は agent process 側の責務（agent が gateway をポーリングして pending を見つけたら session を起動する）。

## アーキテクチャ方針: Channel パターン

### 方針: Channel はプラグイン的な抽象

Channel は agent と human の対話経路の抽象である。gateway が内蔵する chat UI は channel の一実装（built-in channel）であり、将来的に Discord、Telegram 等の外部チャネルも同じ channel インターフェースで接続する。

channel の責務と gateway の責務を分離する:
- **Gateway（コアレイヤー）**: channel の登録・管理、agent session との紐づけ、メッセージルーティング
- **Channel 実装（プラグインレイヤー）**: メッセージの受信・送信、UI レンダリング、外部サービス連携
- **永続化レイヤー**: channel 情報とメッセージ履歴の保存（channel 実装に依存しない）

内蔵 chat の永続化データは gateway コアレイヤーに属する（channel 実装固有のデータではなく、共通のメッセージモデルとして保存する）。

### 方針: Gateway 経由の Agent-User 対話

Agent と human は gateway の API を介して対話する。Agent は Copilot SDK の `defineTool` で定義されたカスタムツールを通じて gateway と通信する。

### Multi-Channel アーキテクチャ

各 channel は独立した input queue と会話履歴を持つ。


```
human → dashboard tab (POST /api/channels/{{channelId}}/messages) → pending queue
                                                                       ↓
                                              gateway: agent を ensure（IPC で生存確認、なければ起動）
                                                                       ↓
agent ← copilotclaw_receive_input ← (POST /api/channels/{{channelId}}/messages/pending)
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

### Agent Process 停止時のセッション保存

agent process が停止する際（`copilotclaw agent stop`、SIGTERM、`--force-agent-restart` による停止等）、全てのアクティブなセッションの状態を `session.disconnect()` で保存してから終了する。保存されたセッションは、次回 agent process 起動後に `client.resumeSession()` で再開できるようにする。

```
Agent process 停止要求
  → 全アクティブ session に対して session.disconnect() で状態保存
  → copilotSessionId を永続化（channel binding と共に保存）
  → IPC サーバーをクローズ
  → プロセス終了

次回 agent process 起動
  → 永続化された copilotSessionId を読み込み
  → channel に未読 user message があれば、保存された copilotSessionId で resumeSession
```

### Agent プロセスの内部動作

```
Agent プロセス起動
  → IPC サーバー開始
  → gateway ポーリングループ開始（GET /api/channels/pending で各チャンネルの pending 数を確認）
    → チャンネルに未処理 user message あり かつ セッション未起動 → セッション起動
    → チャンネルセッションが processing のまま staleTimeout (default 10 min) 超過
      → restartCount == 0 → セッション再起動（1 回だけリトライ）、restartCount を 1 に
      → restartCount >= 1 → 当該チャンネルの user message を全て flush、セッション停止
      → 再起動成功後は restartCount をリセット
```

### Gateway の Agent 管理

Gateway の責務は user message の管理、agent process の ensure と常時監視、チャットシステムの提供。Agent 内部の session 管理には関与しない。


```
Gateway start 時:
  → IPC で agent process の生存確認 + バージョンチェック
    → 接続不可 → agent を detached spawn で起動
    → 接続可 + バージョン OK → 何もしない
    → 接続可 + バージョン不足 → エラー（--force-agent-restart なら停止→再起動）

Gateway stop 時:
  → gateway プロセスのみ停止（agent process は停止しない）

User message POST 時:
  → agent process の ensure はしない
  → agent process が自分で gateway をポーリングして pending を見つけたら agent session を起動する

Gateway 常時監視（定期ポーリング）:
  → IPC で agent process の生存確認 + バージョンチェック
    → 接続不可 → agent を detached spawn で起動
    → 接続可 + バージョン OK → 正常
    → 接続可 + バージョン不足 → エラーログ出力（ユーザーに認識させる）
    → リトライアウト → エラーログ出力（agent process がエラー状態）
```

### IPC Socket パス

`{{tmpdir}}/copilotclaw-agent.sock` を使用する（プロセス単位、チャンネルごとではない）。

## アーキテクチャ方針: Agent Session

### 方針: Channel と Agent Session の分離

Agent session を channel から独立した概念として導入し、agent process が管理する。

- Agent session は Copilot SDK の session に対応し、独自の sessionId を持つ
- Channel には最大 1 つの agent session が紐づく
- Agent session には最大 1 つの channel が紐づく
- Channel に紐づかない agent session も存在しうる（まだ実装はないが） <!-- TODO: 未実装 -->

### 方針: Agent Session のコスト意識

Agent session はコストが高い（プレミアムリクエスト消費）。以下の原則に従う:

- **起動条件**: channel に agent にまだ読まれていない user message（pending message）がある場合にのみ新規起動する。channel が存在するだけでは起動しない
- **維持**: 起動した session はできるだけ長く使い続ける。pending message がない状態が続いていることは session 終了の理由にならない
- **終了条件**: session を終了するのは以下の場合のみ:
  - session が意図せず idle になった場合（LLM が tool を呼ばなかった）
  - session 寿命制限に到達した場合（デフォルト 2 日）
  - stale session タイムアウト（processing 状態が 10 分超過）
  - 明示的な停止要求（`copilotclaw agent stop` 等）

### Agent Session の作業ディレクトリ

agent session を起動する際、SDK の `SessionConfig.workingDirectory` に当該 profile の workspace ディレクトリを指定する。これにより、Copilot のビルトインツール（bash, view, grep, glob 等）が操作するファイルシステムのルートが profile workspace に固定される。

- agent が gateway から受け取る workspace パスを `workingDirectory` に設定する
- profile ごとに workspace が分離される設計と一致する

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
    → LLM が copilotclaw_receive_input を呼んで user message を取得
```

この方式により:
- `session.send()` は session 開始時の 1 回のみ（以降は LLM が自律的に tool を呼び続ける）
- セッションは tool 実行中として生かし続けられる
- `copilotclaw_send_message` は即時 return なので、作業を中断せずに状況報告できる
- 新着 user message は `onPostToolUse` hook の `additionalContext` で LLM に通知される

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

### Agent Session の実行中タイムアウト（stale session）

agent session が待機中ではなく実行中（processing）のまま一定時間（デフォルト 10 分）経過した場合:


```
Agent session processing timeout:
  → session.disconnect() で状態を保存して session を終了
  → copilotSessionId を channel binding と共に保存
  → エラーログ出力
  → channel に紐づく session の場合:
    → channel に「agent session がタイムアウトで停止した」旨のシステムメッセージを投稿
  → 次に channel に未読 user message が入ったとき、保存された copilotSessionId で resumeSession
```

### Agent Session の寿命制限

agent session が wait 状態になったとき、session が作られてからの経過時間を確認する。一定期間（デフォルト 2 日）を超過していた場合、session を deferred replace する。

- エラーではないため、通知は不要
- 理由: 古い agent session を利用し続けると、プロバイダーに切断される可能性があり危険


```
Agent session が wait に遷移:
  → session 作成時刻からの経過時間を確認
  → 2 日超過 → session.disconnect() で状態保存して終了（即時再起動しない）
  → copilotSessionId を channel binding と共に保存
  → 次に channel に未読 user message が入ったとき、保存された copilotSessionId で resumeSession
```

#### Session Replace

session replace が必要になったとき、即座に再起動するのではなく、状態を保存して終了し、次に必要になったタイミングで resume する（deferred resume）。

方式原則:
- replace が必要になったら `session.disconnect()` で状態を保存して session を終了させる。即時再起動はしない
- copilotSessionId（SDK session ID）を channel binding と共に保存しておく
- 次にその agent session が必要とされる状況（channel に未読 user message が入った等）が発生したら、保存された copilotSessionId を使って `client.resumeSession()` で再起動する

適用ケース:
- **寿命超過**: wait 遷移時に max age 超過 → disconnect して終了、次の pending で resume
- **stale timeout**: processing タイムアウト → disconnect して終了 + エラー通知、次の pending で resume

危険性の回避:
- 即時再起動しないことで、replace の無限ループによるプレミアムリクエストの無駄な消費を防ぐ
- resume は「次に必要になったとき」にのみ発生するため、不必要な session 起動が起きない

### Channel ツール

カスタムツール名は `copilotclaw_` プレフィクスで統一する。

| ツール名 | 用途 | 戻り |
| :--- | :--- | :--- |
| `copilotclaw_send_message` | channel にメッセージを送信する | 即時 return |
| `copilotclaw_receive_input` | channel の未処理 user message をポーリングで受け取る | input 到着 or keepalive timeout で return |
| `copilotclaw_list_messages` | channel の過去メッセージを取得する | 即時 return |

#### copilotclaw_send_message

- パラメータ: `{ message: string }`
- channel にメッセージを POST し、即座に return する
- 作業途中の状況報告に使用する（ポーリングを伴わないため、作業フローをブロックしない）

#### copilotclaw_receive_input

- パラメータ: なし
- channel の未処理 user message をポーリングで待機する（keepalive timeout: 25 分）
- 同一 channel に未処理の user message が複数ある場合、一括取得して連結して返す
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
  → 当該 channel に未読の user message があるか gateway に確認
  → 未読あり → additionalContext に通知を追加:
    「新しい user message があります。copilotclaw_receive_input で即時確認してください。」
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

CLI (copilotclaw restart)
  → /api/stop で既存 gateway を停止
  → サーバープロセスを detached spawn → health check で起動確認 → CLI 終了
  → agent process は停止しない（独立プロセスの原則）
```


### API エンドポイント

| エンドポイント | メソッド | 機能 |
| :--- | :--- | :--- |
| `/healthz` | GET | ヘルスチェック |
| `/api/channels` | GET | channel 一覧 |
| `/api/channels` | POST | 新しい channel を作成 |
| `/api/channels/pending` | GET | 各チャンネルの未処理 user message 数を取得 |
| `/api/channels/{{channelId}}/messages/pending` | POST | channel の未処理 user message を一括取得（なければ即時空応答） |
| `/api/channels/{{channelId}}/messages/pending/peek` | GET | channel の最古の未処理 user message を取得（非破壊的） |
| `/api/channels/{{channelId}}/messages/pending/flush` | POST | channel の全未処理 user message をクリア（スタック回復時に使用） |
| `/api/channels/{{channelId}}/messages` | GET | channel のメッセージ一覧（sender 付き、最新順、`?limit=N`） || `/api/channels/{{channelId}}/messages` | POST | channel にメッセージを投稿（agent からの送信用） || `/api/channels/{{channelId}}/replies` | POST | channel の user message に対して reply を投稿（後方互換、将来廃止予定） |
| `/api/events` | GET | SSE エンドポイント（`?channel={{channelId}}` でリアルタイムイベント購読） |
| `/api/status` | GET | gateway（version 含む）と agent のステータス一括取得 |
| `/api/stop` | POST | gateway を停止する |
| `/` | GET | dashboard（channel タブ切り替え + チャット UI） |

### データモデル（インメモリ）

- Channel: `{ id, createdAt }`
- Message: `{ id, channelId, sender: "user" | "agent", message, createdAt }`
- 各 channel が独立した未処理 user message の FIFO キュー（pending queue）を持つ
- sender が "user" のメッセージは pending queue に追加され、agent が取得すると解消される

### Dashboard リアルタイム更新

Dashboard の chat とステータスバーをリアルタイムに更新するため、Server-Sent Events（SSE）によるプッシュ型通信を使用する。WebSocket ではなく SSE を採用した理由は、Node.js 22 に WebSocketServer が組み込まれていないため（外部依存なしの方針）。

- Gateway が SSE エンドポイント（`GET /api/events?channel={{channelId}}`）を提供する
- クライアントは `EventSource` で接続し、購読する channel を指定する
- サーバーは以下のイベントをプッシュする:
  - 新しいメッセージ（user message / agent message）
  - agent session の状態変化（`/api/status` のポーリングで補完）
- ステータスバーは SSE イベント + 5 秒間隔の `/api/status` ポーリングで更新する

### Dashboard ステータス詳細モーダル

ステータスバーをクリックすると、gateway と agent の詳細ステータスを表示するモーダルを表示する。Escape キーまたはオーバーレイクリックで閉じる。

モーダルに表示する情報:
- Gateway: status
- Agent: version, startedAt
- Sessions: 各 session の状態と boundChannelId

### Dashboard Processing インジケータ

Agent session が processing 状態のとき、chat UI の末尾にアニメーション付きの「processing...」インジケータを表示する。

表示条件:
- `/api/status` ポーリング（5秒間隔）で session status が "processing" のとき表示

非表示条件（いずれか）:
- `/api/status` ポーリングで session status が "processing" 以外に変わったとき
- SSE `new_message` イベントで sender が "agent" のメッセージが到着したとき（即時非表示 + status リフレッシュ）
- chat リフレッシュ時に前回の visible 状態を復元（リフレッシュで消えないようにする）

注意: processing indicator のクライアントサイド動作（SSE イベントによる即時非表示等）はサーバーサイド HTML レンダリングのユニットテストではカバーできない。Playwright 導入時にブラウザ E2E テストとして優先的にカバーすべきテストケース。

## アーキテクチャ方針: CLI 設計原則

### 方針: Non-interactive CLI

copilotclaw の CLI は全て非対話的（non-interactive）とする。対話的プロンプト（y/n 確認、選択メニュー等）は使用しない。

- 理由: human には分かりやすい対話的 UI も、agent にとっては扱いが難しい。copilotclaw の主要ユーザーである agent が CLI を操作することを前提に設計する
- human は agent にやり方を聞くので、対話的 UI で分かりやすくする必要性がほぼない

### 方針: Plain Text 出力

CLI 出力は全て plain text とする。カラーコード（ANSI escape sequences）は使用しない。raw mode も使用しない。

- 理由: agent にとってカラーコードや特殊制御文字は雑音になる
- 構造化データが必要な場合は JSON で出力する

## アーキテクチャ方針: Install / Workspace / Update

### Install

copilotclaw を install する仕組みを提供する。npm レジストリへの公開は行わない。

- GitHub リポジトリからの `git clone` + `pnpm install && pnpm build` が基本
- ローカルに clone したソースから `npm install -g .` によるグローバルインストールも可
- `copilotclaw setup` コマンドで初期化（config + workspace 作成）
- エントリポイントスクリプトで Node バージョンチェック

### Workspace

copilotclaw の作業ディレクトリ兼設定ストレージ。

- デフォルト: `~/.copilotclaw/workspace/`
- config, sessions, credentials 等を `~/.copilotclaw/` 以下に配置
- workspace 内にプロジェクト固有のブートストラップファイルを配置可能

### Update

copilotclaw のセルフアップデート機能。

- `copilotclaw update` コマンド
- アップストリーム（GitHub リポジトリ or file URL）から git pull → build で更新
- file URL アップストリーム対応（ローカル開発時に別ディレクトリのリポジトリを upstream に指定して update 可能）
- gateway 起動時のバージョンチェック通知

### Doctor

環境の診断・修復を行うコマンド。openclaw の `openclaw doctor` を参考にするが、copilotclaw の CLI 設計原則に従い非対話的とする。

- `copilotclaw doctor` コマンド
- 診断項目（想定）:
  - workspace ディレクトリの存在と整合性
  - config.json の形式妥当性
  - gateway プロセスの生存確認
  - agent プロセスの生存確認とバージョン互換性
  - IPC ソケットの状態（stale socket の検出）
- 出力: 各診断項目の結果を plain text で表示（pass / warn / fail）
- `--fix` オプション: 修復可能な問題（stale socket の削除、workspace ディレクトリの再作成等）を自動修復

### 永続化

channel 情報とメッセージ履歴を永続化する。

- 永続化対象: Channel（ID、作成日時）、Message（sender、本文、タイムスタンプ）、pending queue 状態
- 永続化レイヤーは channel 実装に依存しない（gateway コアレイヤーに属する）
- 初期実装は JSON ファイルベースで十分（将来的に SQLite 等への移行も視野）
- gateway 再起動後も channel と履歴が復元されること

### バージョン管理ポリシー

gateway と agent のバージョン管理ルールを定める。

- 全パッケージ（root, gateway, agent）のバージョンは一律に揃える
- gateway は `MIN_AGENT_VERSION` で agent の最低互換バージョンを定義する（実装済み）
- `MIN_AGENT_VERSION` の引き上げルール:
  - gateway-agent 間の compatibility が壊れる変更（IPC プロトコル変更等）が入った場合にのみ引き上げる
  - compatibility が壊れていない場合には引き上げてはならない（古い agent が不必要に拒否され、無駄なコストになる）
- バージョン更新時の互換性ルール:
  - IPC プロトコル変更 → minor バージョンアップ + `MIN_AGENT_VERSION` 更新
  - API エンドポイント変更 → minor バージョンアップ
  - 破壊的変更 → major バージョンアップ
- gateway と agent のバージョンは `package.json` の `version` フィールドで管理
- リリースチャンネル（stable / beta / dev）の導入は将来検討

### Profile

同一マシン上で複数の独立した copilotclaw インスタンスを実行するための仕組み。openclaw の Runtime Profile を参考にする。

- profile は必須ではない。`COPILOTCLAW_PROFILE` 環境変数が未指定の場合はデフォルトの無印 profile として動作する（既存の動作と完全に互換）
- 環境変数 `COPILOTCLAW_PROFILE` で名前付き profile を指定する
- profile ごとに以下のリソースが分離される:
  - workspace: `~/.copilotclaw/workspace-{{profile}}/`（デフォルト: `~/.copilotclaw/workspace/`）
  - 設定ファイル: `~/.copilotclaw/config-{{profile}}.json`（デフォルト: `~/.copilotclaw/config.json`）
  - gateway インスタンス（profile 同士の衝突を避け、設計をシンプルにするため）
  - agent process インスタンス（設計をシンプルにするため）
  - IPC ソケットパス: `{{tmpdir}}/copilotclaw-agent-{{profile}}.sock`（デフォルト: `copilotclaw-agent.sock`）

### 設定ファイル

copilotclaw の動作を設定ファイルで制御する仕組み。openclaw の `config.json` を参考にする。

- 配置場所: `~/.copilotclaw/config.json`（名前付き profile 使用時: `~/.copilotclaw/config-{{profile}}.json`）
- 形式: JSON

#### 設定の優先順位ルール

設定全般に以下の原則を適用する:

- **環境変数 > 設定ファイル**: 同一の設定項目に環境変数と設定ファイルの両方で値が与えられた場合、環境変数の値が優先される
- 特別な理由がある場合は、個別の設定項目について例外を設けることも検討可能

#### 初期の設定項目

| 設定キー | 型 | 環境変数 | 説明 |
| :--- | :--- | :--- | :--- |
| `upstream` | `string?` | `COPILOTCLAW_UPSTREAM` | update 時のアップストリーム URL（GitHub リポジトリ or file URL） |
| `port` | `number?` | `COPILOTCLAW_PORT` | gateway の HTTP サーバーのポート番号（デフォルト: 19741） |
| `model` | `string?` | `COPILOTCLAW_MODEL` | デフォルトで使用するモデル。未指定時はプレミアムリクエスト消費が最小のモデルを動的選択 |
| `zeroPremium` | `boolean?` | `COPILOTCLAW_ZERO_PREMIUM` | ゼロプレミアムリクエストモード（デフォルト: false） |
| `debugMockCopilotUnsafeTools` | `boolean?` | `COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS` | 開発用モックツールモード（デフォルト: false） |

今後、設定項目は必要に応じて追加される。

#### デフォルトモデル選択

`model` が未指定の場合、利用可能なモデルの中からプレミアムリクエスト消費が最も少ないモデルを動的に選択する。

#### ゼロプレミアムリクエストモード

プレミアムリクエストを一切消費せずに利用したいユーザー向けのモード。

- `zeroPremium: true` の場合:
  - `model` が指定されていてもプレミアムリクエストを消費するモデルであれば、プレミアムリクエストを消費しないモデルに自動的に切り替える
  - プレミアムリクエストを消費しないモデルが存在しない場合は、ユーザーにエラーを通知する
  - doctor でもこの状態をチェックする

#### 開発用モックツールモード

開発中に危険なビルトインツール（ファイルシステムアクセス、シェル実行等）をモックに置き換えるモード。開発者のホストマシン上で copilotclaw を動かす際の安全策。

- `debugMockCopilotUnsafeTools: true` の場合、セッション作成時に allow するツールを明示的に制限する:
  - 一部の安全なビルトインツール（web fetch 等）
  - 通常の `copilotclaw_*` ツール（gateway との通信用 — モックに置き換えない）
  - `copilotclaw_debug_mock_*` ツール（危険なビルトインツールのモック版）
- `debugMockCopilotUnsafeTools: false`（デフォルト）の場合、ツール制限なし

#### Config CLI コマンド

CLI から設定ファイルを直接編集せずに設定値を変更・確認できるコマンドを提供する。openclaw の `config set` / `config get` を参考にする。

```
copilotclaw config get <key>
  → 指定キーの現在の値を表示（環境変数による上書きも考慮した解決済みの値）

copilotclaw config set <key> <value>
  → 設定ファイルの指定キーに値を書き込む
  → 環境変数が設定されている場合は、環境変数が優先される旨を警告表示
```

| サブコマンド | 用途 |
| :--- | :--- |
| `config get <key>` | 設定値の取得（解決済みの値を表示） |
| `config set <key> <value>` | 設定値の変更（config.json に書き込み） |

#### Setup 時のポート自動選択

`copilotclaw setup` 実行時に、デフォルトポート（19741）が既に使用されていた場合、空いているポートを自動的に探して設定ファイルに書き込む。

ポート選択ロジック:
- あらかじめ定義された候補ポートリストから選択する（ランダムポートではなく決定論的）
- 候補ポートは well-known ports、一般的な開発ポート（3000, 8080 等）、ラウンドナンバーとその派生を避けた番号とする
- 候補リストを順に試し、最初に空いているポートを採用する
- ポートの空き確認は `net.createServer().listen()` で実際にバインドを試みる方式とする
- 選択されたポートを `config.json` の `port` に書き込む

```
copilotclaw setup
  → デフォルトポート (19741) の空き確認
  → 空いている → そのまま使用（config に port は書き込まない = デフォルト値を使用）
  → 使用中 → 候補ポートリストから空きポートを探索
    → 空きポート発見 → config.json に port を書き込み
    → 全候補が使用中 → エラー（手動設定を促す）
```

## 機能要件

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

### テストカバレッジのギャップ

Dashboard のクライアントサイド JS 動作（SSE イベントハンドラ、processing indicator の表示/非表示、ログパネルの動的更新等）は、現在のサーバーサイド HTML レンダリングのユニットテストではカバーされていない。Playwright 導入時に優先的にカバーすべきテストケース:

- Processing indicator: agent メッセージ到着時に即時非表示になること
- SSE 接続: メッセージ到着時にチャットが更新されること
- ステータスバー: agent 互換性ラベルがリアルタイム更新されること
- ログパネル: 開閉と自動更新が動作すること

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
- `onPostToolUse` hook による新着 user message 通知
- `session.send()` 排除（session 開始時のみに限定）
- Gateway の Messages API（`GET/POST /api/channels/{{channelId}}/messages`）
- Agent バージョン互換性チェック（IPC `status` に `version` 追加、gateway 側で最低バージョン検証）
- Agent 手動停止コマンド（`packages/agent/src/stop.ts`）
- Dashboard ステータスバー（gateway status、agent version、session 状態の表示）
- 古い agent の強制停止・再起動オプション（`gateway start --force-agent-restart`）
- Agent session の意図しない停止時の channel 通知と "stopped" status
- Dashboard リアルタイム更新（SSE によるプッシュ型通信）
- Dashboard ステータス詳細モーダル（クリックで gateway/agent 詳細表示）
- Dashboard Processing インジケータ（processing 中にアニメーション付き表示）
- Workspace 機能（`~/.copilotclaw/` 以下の設定・データディレクトリ）
- 永続化（channel 情報 + メッセージ履歴の JSON ファイルベース永続化）
- Install 機能（setup コマンドで workspace 初期化）
- Update 機能（git pull ベースのセルフアップデート、file URL アップストリーム対応）
- バージョン管理ポリシーの策定とドキュメント化
- Channel アーキテクチャ再設計（ChannelProvider インターフェース導入、内蔵 chat を BuiltinChatChannel として分離）
- Gateway restart コマンド（`copilotclaw restart` で stop → start を 1 コマンド実行）
- `/api/status` に gateway version を追加
- Gateway による agent process 常時監視（30 秒ポーリングで生存確認 + バージョンチェック + 自動再起動）
- Agent session 実行中タイムアウト時の channel message 通知
- Agent session 寿命制限（デフォルト 2 日超過で replace）
- Agent session replace（deferred resume 方式: disconnect → 次の pending で resumeSession）
- `/api/status` に agentCompatibility（compatible / incompatible / unavailable）を追加
- Gateway start/restart CLI で agent ensure 完了を待ち、incompatible ならエラー終了
- Dashboard ログ表示（`/api/logs` + Logs パネル + LogBuffer）
- 自動テスト基盤（Vitest、mock session、mock fetch による agent テスト）
- Profile 機能（`COPILOTCLAW_PROFILE` による workspace・設定ファイル・gateway・agent・IPC ソケットの分離）
- 設定ファイル機能（`config.json` による動作設定、環境変数との優先順位ルール、`upstream` / `port` 設定項目）
- Setup 時のポート自動選択（デフォルトポート使用中の場合に候補リストから空きポートを探索・config に書き込み）
- Config CLI コマンド（`copilotclaw config get/set` による設定値の取得・変更）
- Doctor コマンド（環境診断・修復、非対話的、`--fix` オプション）
- デフォルトモデル選択設定（`model` / `zeroPremium` / `debugMockCopilotUnsafeTools` config + doctor チェック）
- Gateway `/api/status` に profile 名と config 設定を公開

**今後の課題:**
- Agent process 停止時の全セッション保存（disconnect → 次回起動時に resumeSession）
- コーディング支援ツール群（ファイル操作・シェル実行・検索・Git）の実装
- Observability スタックの独立リポジトリへの分離（`.example` パターンの導入を含む）
