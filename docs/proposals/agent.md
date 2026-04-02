# 提案: Agent

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

**現在のプロトコル（gateway → agent 方向のみ）:**

| メソッド | 応答 | 用途 |
| :--- | :--- | :--- |
| `status` | `{ version, startedAt, sessions: { [sessionId]: AgentSessionInfo } }` | 全 agent session の状態を一括取得（version を含む） |
| `session_status` (params: `{ sessionId }`) | `AgentSessionInfo` | 個別 agent session の状態を取得 |
| `stop` | `{ ok: true }` | graceful shutdown |

### Gateway-Agent 間通信の IPC 統一

agent process は gateway の HTTP API にアクセスしない。全通信は IPC stream 経由で行う。

**IPC Stream プロトコル:**

gateway が agent の IPC socket に `{"method": "stream"}\n` を送ると、agent は `{"ok": true}\n` を返し、その接続は永続的な双方向チャネルになる。stream 接続は同時に 1 本のみ。既存の短命 IPC 接続（status, stop, quota, models, session_messages）はそのまま動作する。

メッセージは改行区切り JSON で `type` フィールドを持つ:
- Fire-and-forget: `{"type": "...", ...}\n`
- Request-response: `{"type": "...", "id": "uuid", ...}\n` → `{"type": "response", "id": "uuid", "data": ...}\n`

**gateway → agent push:**
- `config` — stream 確立時に即送信。agent 起動時の設定取得に使う
- `pending_notify` — 新規 user message 到着時に通知。agent のポーリングを置き換え

**agent → gateway push (fire-and-forget):**
- `channel_message` — channel へのメッセージ送信
- `session_event` — SDK イベントの転送
- `system_prompt_original` — オリジナルシステムプロンプトの保存
- `system_prompt_session` — effective system prompt の保存（IPC タイプ名は互換性のため維持）

**agent → gateway request-response:**
- `drain_pending` — pending messages の取得（旧 `POST /api/channels/{{id}}/messages/pending`）
- `peek_pending` — 最古 pending のピーク（旧 `GET /api/channels/{{id}}/messages/pending/peek`）
- `flush_pending` — pending の flush（旧 `POST /api/channels/{{id}}/messages/pending/flush`）

**除去済み:**
- agent process から `COPILOTCLAW_GATEWAY_URL` 環境変数の参照
- `gatewayBaseUrl` の設定・保持
- agent 内の全 HTTP fetch 呼び出し（`fetchPendingCounts`, `peekOldestPending`, `flushPending`, `fetchGatewayConfig`, `postToGateway`, `postChannelMessage`、channel.ts 内の `pollNextInputs` の HTTP 部分）

**変更箇所:**
- `packages/agent/src/ipc-server.ts` — stream 接続の検出・永続化、双方向メッセージハンドリング、`sendToGateway` / `requestFromGateway` エクスポート
- `packages/agent/src/index.ts` — HTTP ポーリングを IPC イベント駆動に置き換え
- `packages/agent/src/agent-session-manager.ts` — `gatewayBaseUrl` / `fetchFn` を除去し、IPC 送信に置き換え
- `packages/agent/src/tools/channel.ts` — HTTP fetch を IPC に置き換え
- `packages/gateway/src/ipc-client.ts` — `IpcStream` クラスの追加（永続接続、自動再接続）
- `packages/gateway/src/agent-manager.ts` — stream 接続の確立、メッセージルーティング
- `packages/gateway/src/server.ts` — user message POST 時の `pending_notify` 送信
- `packages/gateway/src/daemon.ts` — stream 接続の確立

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

### SDK CLI 子プロセスのゾンビ化（v0.66.0 で実現済み）

agent プロセス停止時に、SDK が spawn した CLI 子プロセス（`@github/copilot/index.js`）がゾンビとして残る。

**現状の問題:**

- agent 停止時（`stopAllPhysicalSessions` / `stopPhysicalSession`）に `CopilotClient.stop()` / `forceStop()` を呼んでいない。これがゾンビの直接原因（通常の lifecycle "stop" パスでは `client.stop()` を呼んでいる）
- `CopilotClient.start()` が CLI プロセスを spawn し、`stop()` / `forceStop()` が kill する責務を持つ
- `session.disconnect()` はセッションの切断であって CLI プロセスの終了ではない
- `stopAllPhysicalSessions()` は abort + 5秒タイムアウトで打ち切るが、`client.stop()` を呼ばないため CLI プロセスが残る
- gateway の agent 再起動時は IPC `stop` コマンドを送るだけで、プロセスを直接 kill しない
- 実測で 89 個のゾンビ SDK CLI プロセスが残っていた。プレミアムリクエストを無駄に消費し続ける

**対応方針:**

- agent 停止時に `client.stop()` を呼び、タイムアウト後は `client.forceStop()` で CLI プロセスを強制終了する
- `CopilotSession` は `Symbol.asyncDispose` を実装している（SDK README に記載）。`await using session = ...` 構文を使い、スコープ離脱時の `disconnect()` 漏れを防ぐ

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
  - session が意図せず idle になった場合（LLM が tool を呼ばなかった）。ただし subagent 停止による session.idle は除外する（後述）
  - session 寿命制限に到達した場合（デフォルト 2 日）
  - stale session タイムアウト（processing 状態が 10 分超過）
  - 明示的な停止要求（`copilotclaw agent stop` 等）

### Agent Session の作業ディレクトリ

agent session を起動する際、SDK の `SessionConfig.workingDirectory` に当該 profile の workspace ディレクトリを指定する。これにより、Copilot のビルトインツール（bash, view, grep, glob 等）が操作するファイルシステムのルートが profile workspace に固定される。

- agent が gateway から受け取る workspace パスを `workingDirectory` に設定する
- profile ごとに workspace が分離される設計と一致する

### Session Keepalive 方針

`client.send()` は session の開始時以外には使わない（コスト最小化の原則）。CLI の 30 分 idle timeout を回避するため、`copilotclaw_wait` tool の内部で input をポーリングしながら待機する。tool が実行中の間はセッションは active 扱いとなり timeout しない。

```
Agent session 起動（session.send を 1 回だけ使用）
  → LLM が copilotclaw_wait を呼ぶ（tool 内で input をポーリング待機）
  → timeout 接近（25 分経過）
    → input なしで tool を返す（空の結果 + 再呼び出し指示）
    → LLM が再び copilotclaw_wait を呼ぶ（session.send 不要）
  → input 到着
    → tool が input を返す → LLM が処理
    → copilotclaw_send_message で途中報告（即時 return、何度でも呼べる）
    → 処理完了 → copilotclaw_send_message で最終回答
    → copilotclaw_wait で次の入力を待機
  → 作業中に新着通知（onPostToolUse hook の additionalContext）
    → LLM が copilotclaw_wait を呼んで user message を取得
```

この方式により:
- `session.send()` は session 開始時の 1 回のみ（以降は LLM が自律的に tool を呼び続ける）
- セッションは tool 実行中として生かし続けられる
- `copilotclaw_send_message` は即時 return なので、作業を中断せずに状況報告できる
- 新着 user message は `onPostToolUse` hook の `additionalContext` で LLM に通知される

### session.idle での subagent 停止と親 agent idle の区別（v0.57.0 で gateway 側のみ実装、agent 側未修正で未実現）

session.idle イベントには、subagent が停止しただけで親 agent はまだ `copilotclaw_wait` で待機中というケースと、親 agent 自身が idle になったケースの 2 種類がある。

**現状の問題:**

v0.57.0 で gateway 側の `onLifecycle` 判定のみ実装した（backgroundTasks 付き session.idle に対して `action: "wait"` を返す）。しかし、agent 側のセッションループ（`session-loop.ts`）は `session.idle` イベントで無条件にセッションループを終了する。gateway が `"wait"` を返しても、セッションループは既に終了しており、`copilotclaw_wait` のツールハンドラは宙に浮く。結果、セッションはゾンビ化する（gateway は active と認識、agent は何も動いていない）。

**修正方針:**

agent 側のセッションループ（`session-loop.ts` / `copilot-session-adapter.ts`）で、`session.idle` イベントに `backgroundTasks` が含まれる場合はセッションループを終了させず、subagent の完了を待つ。

```
session.on("session.idle", (event) => {
  if event.data.backgroundTasks が存在する:
    → セッションループを終了しない（subagent がまだ実行中）
  else:
    → セッションループを終了（親 agent の真の idle）
})
```

gateway 側の `onLifecycle` 判定（v0.57.0 実装済み）はフォールバックとして残す。agent 側でセッションループが正しく継続すれば、`onLifecycle` は親 agent の真の idle でのみ呼ばれるようになる。

### physical session の常時保持（v0.58.0 で実現済み）

chat 履歴があるチャンネルでは、current physical session が常に存在する状態を維持する。

**現状の問題:**
- 物理セッションが idle で停止すると、抽象セッションが suspended になり `physicalSession` が undefined になる
- status 表示や cron 設定で物理セッションの情報（モデル等）が見えなくなり、使いづらい
- 最後に使った物理セッションは `physicalSessionHistory` に退避されるが、current として表示されない

**方針:**
- 物理セッションが idle 停止しても、SDK セッションとしては停止するが、gateway 側では `physicalSession` フィールドをクリアせず、最後に使った物理セッションの情報を current として保持し続ける
- 新しい物理セッションが開始されたときに current が上書きされる
- 物理セッションの archive（明示的な削除）は既存の機能で対応

### turn run（連続した turn 列）の概念導入（v0.58.0 で実現済み）

セッションの子として、プレミアムリクエスト 1 回の消費に対応する連続 turn 列の概念を導入する。human は「連続した turn 列のような概念に適切に呼びやすく、内容とも一致している名前をつけて」と要望しており、本 proposal では「turn run」と命名する。

**概念定義:**
- **turn run**: session.send() または resumeSession() により開始され、親 agent（subagent でない）の session.idle により終了する、連続した turn の列。プレミアムリクエスト 1 回の消費に対応する
- turn run の中では copilotclaw_wait による keepalive が繰り返され、LLM が自律的に動作し続ける
- subagent の session.idle は turn run の終了とみなさない（subagent 停止は親 agent の動作に影響しない）
- 親 agent の session.idle が来ると turn run が終了し、次の turn run 開始時にプレミアムリクエストが 1 回消費される

**turn run 境界でのモデル切り替え:**
- turn run が停止したら、次の turn run 開始時にチャンネルのモデル設定値を反映してモデルを切り替える
- 現状は物理セッション全体の archive でしかモデル切り替えのタイミングがないが、turn run の強制停止で軽量にモデル切り替えが可能になる

**turn run の強制停止:**
- 既存の physical session archive に加えて、turn run の強制停止機能を提供する
- turn run を停止すると、物理セッション自体は維持したまま、次の会話から設定したモデルが適用される
- end turn run は物理セッションを archive しない。SDK セッションは停止するが copilotSessionId を保持し、次回メッセージで resumeSession により同じ物理セッションから再開する（v0.60.0 で実現済み）
- UI: チャンネル設定モーダルに「turn run 停止」ボタンを追加。警戒色（赤）で表示する — プレミアムリクエストを消費して開始した run を捨てることになるため（v0.58.0 で実現済み）
- API: 新規エンドポイントまたは既存の lifecycle RPC を利用

### セッション status の細分化（v0.58.0 で実現済み）

抽象セッションの status をより細かく区別して表示する。

**現状の status:**
- `starting`: 物理セッション作成中
- `waiting`: copilotclaw_wait で待機中
- `processing`: LLM が処理中
- `suspended`: 物理セッションが停止し、抽象セッションのみ存続

**新しい status 体系:**

| status | 意味 |
|---|---|
| `new` | abstract session に physical session が一度も紐づいていない初期状態 |
| `starting` | 物理セッション作成中 |
| `waiting` | copilotclaw_wait で待機中（turn run は継続中） |
| `notified` | wait で待っていたが新規 message が到着し、wait が解かれるまでの遷移中 |
| `processing` | LLM が処理中（tool 実行中を含む） |
| `idle` | turn run が終了し、物理セッションは存在するが idle 状態 |
| `suspended` | 物理セッションが明示的に archive された状態（※ 現行の suspended は全ての物理セッション停止を含むが、本提案では idle と suspended を分離し、suspended は明示的 archive のみに限定する設計変更） |

**status 遷移:**
```
new → starting → waiting ⇄ notified → processing → waiting（turn run 継続）
                                                   → idle（turn run 終了）
idle → starting（次の turn run 開始、プレミアムリクエスト消費）
idle → suspended（明示的 archive）
suspended → starting（revive）
```

**`notified` status の導入理由:**
- wait で待っていたが新規 message が入ってきて、wait が解かれるまでの間を示す
- UI 上で「メッセージを受信した、処理中になるところ」を視覚的に示すことで、反応性の高い UI を実現する

### 物理セッションの意図しない停止とリカバリ

LLM が tool を呼ばずに idle になった場合、`session.send()` による停止阻止はしない（コスト最小化の原則）。このとき物理セッションは停止するが、抽象セッションは suspended 状態で残る。

```
物理セッション idle（LLM が copilotclaw_wait を呼ばなかった）
  → session.send() は呼ばない → 物理セッション停止
  → 抽象セッションは suspended に遷移（チャンネルへの紐づけは維持）
  → copilotSessionId は保持（resumeSession で会話記憶を復元するため）
  → channel に紐づく抽象セッションだった場合
    → channel に物理セッションが意図せず停止したことを通知する
```

停止後のリカバリ:
- 抽象セッションは suspended 状態でチャンネルに紐づいたまま残る
- この channel に新たに user がメッセージを送った場合:
  - 既存の抽象セッションを revive する（新規作成ではない）
  - `copilotSessionId` が保存されていれば `resumeSession` を試みる（前回の会話記憶を保持）
  - `resumeSession` が失敗した場合は `copilotSessionId` をクリアして `createSession` で新しい物理セッションを作成する
- `resumeSession` 失敗時は `copilotSessionId` をクリアして `createSession` にフォールバックする（v0.38.0 で実装済み）

### gateway 停止時の物理セッション延命（実装確認済み）

gateway が停止している間も、agent process は物理セッションを延命し続けなければならない。

**原則:**
- gateway の停止・再起動が物理セッションの破壊につながってはならない
- 物理セッションはプレミアムリクエストを消費して作成される高コストなリソースであり、不必要な破壊は許されない

**実装状況（コード確認済み）:**
- `copilotclaw_wait` の handler 全体が try/catch で囲まれ、あらゆるエラーを catch して `KEEPALIVE_INSTRUCTION` を返す（tools/channel.ts 170-218行）
- `drainPendingViaIpc` は IPC エラーを catch して空配列を返す（tools/channel.ts 62-69行）
- `waitForPendingNotify` は keepalive タイムアウトで false を返す。IPC stream 切断時も EventEmitter 側でエラーにならず、タイムアウトで正常に制御が戻る（tools/channel.ts 72-106行）
- gateway 停止 → IPC 切断 → drain 失敗（空配列）→ notify タイムアウト → keepalive レスポンス → LLM が再度 `copilotclaw_wait` を呼ぶ → ループ継続
- gateway 再接続時に IPC stream の auto-reconnect により自動的に通常動作に復帰する

**gateway 再起動時の二重セッション問題（v0.50.0 で解決済み）:**

物理セッション延命自体は機能するが、v0.49.0 までは gateway 再起動時に延命した物理セッションが正しく再利用されていなかった。v0.50.0 では agent が stream 接続時に `running_sessions` メッセージを送信し、gateway の `SessionOrchestrator.reconcileWithAgent()` が suspended セッションを revive することで解決した。以下は v0.49.0 以前の動作の記録。

```
gateway 停止
  → orchestrator.suspendAllActive() で全セッションを suspended に遷移（gateway 側のみ）
  → agent には何も通知されない — 旧物理セッションは keepalive で生存し続ける

gateway 再起動
  → 新 stream 接続 → checkAllChannelsPending()
  → orchestrator は全セッション suspended → hasActiveSessionForChannel() = false
  → startSessionForChannel() → start_physical_session を agent に送信
  → agent が新しい物理セッションを作成
  → 旧物理セッションも依然として動いている → 同一チャンネルに 2 つの物理セッションが並走
  → 両方が drain_pending を呼び、メッセージが競合する
```

v0.49.0 以前はこの問題が「gateway の停止が物理セッションの破壊につながる設計は常に許されない」の間接的な違反であった。v0.50.0 の reconciliation により解消。

### gateway 停止時の情報無損失（v0.50.0 で実現済み）

gateway が停止している間に agent process で発生した情報が消失しないようにする。

**実装（v0.50.0）:**
- `sendToGateway()` は IPC stream 未接続時にメモリキューにバッファリングする
- キューは JSONL ファイル（`{{dataDir}}/send-queue.jsonl`）にディスク永続化される
- agent process が停止しても、次回起動時にディスクからキューを復元する（`initSendQueue()`）
- gateway に再接続された時（`stream_connected` イベント）、`flushSendQueue()` でバッファを一括送信する
- フラッシュは `running_sessions` 報告の前に実行され、gateway は欠落していたイベントを先に受信する
- バッファサイズ上限: 10,000 メッセージ。超過時は古いものから破棄する

**残存する配達保証の限界（未実現）:**

現在の send queue は WAL（write-ahead log）の前半のみの実装。gateway 停止中のバッファリングと復元は実現しているが、flush 時の配達保証がない。

問題: `flushSendQueue()` は `socket.write()` 後に即座にディスクファイルをクリアする。Unix domain socket の `socket.write()` はデータをカーネルバッファに入れるだけで、gateway アプリケーションが読み取ったことを保証しない。flush 中に gateway がクラッシュすると、カーネルバッファ内のデータが消え、ディスクファイルも既にクリア済みのため、復元不可能になる。

対応方針: アプリケーションレイヤーの ACK プロトコルを導入する。

```
agent                              gateway
  │                                  │
  │  flush_batch (batchId, messages) │
  │─────────────────────────────────>│
  │                                  │ ← 処理完了
  │  flush_ack (batchId)             │
  │<─────────────────────────────────│
  │                                  │
  │ ← WAL から該当メッセージを削除   │
```

- agent は flush 時にディスクファイルをクリアしない。ACK 受信後に削除する
- ACK が来なければリトライする
- gateway 側はメッセージの重複を冪等処理する（session_event は ID + timestamp で識別可能）

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

### 抽象 Agent Session と物理 Copilot Session の分離

現在の実装では、物理 session（Copilot SDK session）が停止すると抽象 agent session も一緒に消滅し、channel binding が解除される。これを改め、抽象レイヤーと物理レイヤーのライフサイクルを分離する。

**現在のモデル（問題）:**

```
物理 session 停止
  → agent session を sessions Map から削除
  → channel binding を解除
  → 次の user message 到着時に、新しい agent session を作成し、新しい channel binding を張る
```

**目標のモデル:**

```
物理 session 停止
  → agent session は残存（status を "suspended" に変更）
  → channel binding は維持
  → copilotSessionId を agent session 内に保存（resume 用）
  → 次のトリガーで物理 session を再作成または resume し、既存の agent session に紐づける
```

抽象 agent session のライフサイクル:
- **作成**: channel に user message が到着し、紐づく agent session がないとき
- **active**: 物理 session が稼働中（waiting / processing）
- **suspended**: 物理 session が停止したが、抽象 session は存続中。copilotSessionId を保持
- **終了**: 明示的な停止要求（`copilotclaw agent stop` 等）のみ

channel binding の永続化:
- agent process 再起動後も channel → agent session の紐づけを維持するため、binding 情報（channelId ↔ sessionId + copilotSessionId）を `{{workspaceRoot}}/data/agent-bindings.json` に永続化する
- 永続化タイミング: `suspendSession` 時と `stopSession` 時（atomic write: tmp ファイル → rename）
- agent 起動時に永続化ファイルから suspended session を復元し、channel binding を再構築する

### 抽象セッションへのトークン消費履歴の紐づけ

物理 session が停止・再作成されても、抽象 agent session に紐づく形でトークン消費量等の履歴を追跡する。

**現状の課題:**
- 物理 session が停止すると、その session のトークン消費履歴が dashboard から参照できなくなる
- 抽象セッション単位でのトークン消費量（複数の物理 session にまたがる累積値）が把握できない

**目標:**
- 抽象 agent session に累積のトークン消費量を紐づける
- 物理 session の停止・再作成をまたいで、同一の抽象 session に帰属するトークン消費を集計できる
- dashboard から、停止済みの物理 session を含む全履歴を参照できる

### 停止した物理セッションの Dashboard 継続表示

物理セッションが停止した後も、そのセッションの情報を dashboard および SystemStatus で継続的に参照可能にする。

**現状の問題:**
- `suspendSession()` で `entry.info.physicalSession = undefined` に設定するため、物理セッション情報が消える
- dashboard / SystemStatus のモーダルや `/status` ページから、停止済みの物理セッションの情報（モデル、トークン、開始時刻、イベントへのリンク等）が参照できなくなる

**方針:**
- 抽象セッションに `physicalSessionHistory` を追加し、停止した物理セッションの情報を蓄積する
- `suspendSession()` でトークン累積後、`physicalSession` の情報を `physicalSessionHistory` に退避してから `undefined` に設定する
- dashboard では停止済みの物理セッションを折りたたみ表示（デフォルト折りたたみ、クリックで展開）する
- イベントページへのリンクも停止済みセッションから引き続きアクセス可能にする

### Gateway-Agent 責務の再配置（部分実現 — 設定値は v0.40.0、抽象セッション管理は v0.49.0 で部分移行）

gateway process だけ最新版を起動しても最新機能が使えるように、責務を再配置する。

**動機:**
- 現状、システムプロンプト・custom agent 定義・hook ロジック等は全て agent process のコード（`agent-session-manager.ts`）に埋め込まれている
- agent process を更新するにはプロセス再起動が必要であり、物理セッションが失われる
- gateway process は物理セッションを持たないため、再起動コストが低い
- 設定値と抽象セッション管理を gateway 側に寄せることで、gateway restart だけで最新機能を反映できるようにする

**移行対象:**

| 現在の所在 | 移行先 | 内容 |
|---|---|---|
| agent-session-manager.ts | gateway の agent モジュール | 抽象セッション管理（channel binding、suspended 状態、revive 判定、token 累積追跡） |
| agent-session-manager.ts | gateway → IPC 経由 | CHANNEL_OPERATOR_PROMPT、WORKER_CONFIG、SYSTEM_REMINDER |
| agent-session-manager.ts | gateway → IPC 経由 | custom agent 構成（name、description、prompt、infer） |
| agent-session-manager.ts | gateway → IPC 経由 | onPostToolUse hook のリマインド内容 |

**agent process に残る責務:**
- 物理セッションの作成・実行・停止（`createSession` / `resumeSession` / `disconnect`）
- SDK との直接通信（Copilot CLI サブプロセスの管理）
- ツールハンドラの実行（`copilotclaw_wait` 等のブロッキング処理）

**段階的移行:**
- 完全な再起動不要化は困難（SDK セッションは agent process に紐づく）
- すぐに移動できる設定（プロンプト文字列、agent 構成、リマインド内容）を先行して IPC 経由に移行する
- 抽象セッション管理の移動はより大きな変更となるため、後続フェーズで対応する

**agent process 監査結果 — gateway に移行すべきロジック（v0.49.0〜v0.54.0 で実現済み）:**

agent process の実装全体を監査した結果、以下のロジックが設計原則（agent process はミニマル、gateway の更新だけで最新機能を享受）に違反している。

CRITICAL — 抽象セッション管理:
- チャンネルバインディング管理（`channelBindings` map, `hasSessionForChannel`, `hasActiveSessionForChannel`）
- suspended セッションの永続化（`loadBindings`, `saveBindings`, `agent-bindings.json`）
- セッション復活ロジック（`reviveSession`, `startSession` での suspended チェック）
- 抽象セッション状態管理（`AgentSessionInfo`, status lifecycle, `cumulativeTokens`, `physicalSessionHistory`）

HIGH — セッションライフサイクルポリシー:
- チャンネルバックオフ（`channelBackoff` map, `isChannelInBackoff`, rapid failure detection）
- stale セッション検出とタイムアウト（`checkStaleAndHandle`, stale check timer）
- max session age 強制（`checkSessionMaxAge`）
- pending メッセージポーリング（`checkAllPending`, `peek_pending` RPC）

MEDIUM — observability / 通知ポリシー:
- システムプロンプトセクションキャプチャ（`registerTransformCallbacks`, `postCapturedPrompt`）
- セッションイベント転送（`forwardEvent`, 全イベント subscribe）
- 物理セッション状態の詳細追跡（`PhysicalSessionSummary`, token tracking）
- subagent セッション追跡（`SubagentInfo[]`, `subagent.started/completed/failed`）
- セッションライフサイクル通知（channel への "[SYSTEM] Agent session stopped unexpectedly" 送信）
- rapid failure 検出（elapsed time 計算, backoff 記録）

LOW — 運用:
- workspace bootstrap（`ensureWorkspaceReady`, git init, bootstrap files 作成）

**移行後の agent process の責務（v0.51.0 時点の実態）:**
- gateway から指示を受けて物理セッションを作成・実行・停止する
- SDK との直接通信（Copilot CLI サブプロセスの管理）
- ツールハンドラの実行（`copilotclaw_wait` 等のブロッキング処理）
- セッション終了を gateway に報告する（成功/失敗/idle exit）
- gateway から受け取った設定でセッションを構成する（プロンプト、カスタムエージェント、knownSections、clientOptions、sessionConfigOverrides — 全てパススルー）
- SDK フック発火時に gateway に RPC を送り、応答をそのまま SDK に返す（gateway 停止時はフォールバック動作）
- SDK イベントを全て無条件に gateway に forward する（catch-all）
- gateway 停止時は物理セッションを自律的に延命する（keepalive cycle、フォールバック動作）

**agent 更新が必要になるケース（v0.51.0 時点）:**
- SDK API 自体の変更（型変更、新しい必須引数等）
- SDK に新しいフックタイプが追加された場合（makeHookHandler の登録に追加が必要）
- IPC プロトコルの拡張（新メッセージタイプ、新 RPC メソッド）
- 新しい copilotclaw_* ツールの追加、既存ツールのハンドラ変更

**gateway-configurable 範囲の拡大（実現済み）:**

v0.50.0-v0.51.0 で、設定値だけでなく振る舞い（SDK イベント購読、SDK フックロジック、セッション設定）も gateway-configurable になった。以下に実現状況をまとめる。

**前提制約: gateway 停止時の物理セッション延命は絶対要件。** gateway が停止していても agent は物理セッションを自律的に維持し続けなければならない。gateway の停止が物理セッションの破壊につながる設計は許されない。以下の全ての方針はこの制約の下で設計する。

実現済み:
- SDK イベントを全て無条件に forward し、gateway 側でフィルタリングする: **v0.50.0 で実現済み。** `session.on(handler)` catch-all で SDK の全イベントを無条件に forward するよう変更。新しい SDK イベントタイプが追加されても agent 更新不要。fire-and-forget なので gateway 停止時も物理セッションに影響しない

config 化・パラメトライズ（v0.50.0 で実現済み）:
- KNOWN_SECTIONS リストの gateway config 化: `knownSections` フィールドで gateway から送信。agent はそのまま使う。新しいセクション追加が gateway-only で可能
- send queue の overflow ポリシーの config 化: `maxQueueSize` フィールドで gateway から送信。agent は `setMaxQueueSize()` で適用
- カスタムエージェント定義の動的リスト化: `customAgents` 配列 + `primaryAgentName` で任意のリストを送信。agent がそのまま SDK に渡す。新 agent type 追加が gateway-only で可能
- CopilotClient コンストラクタ引数のパラメトライズ: `clientOptions` で gateway から送信。agent は `githubToken` とマージして SDK に渡すパススルー構造
- createSession config のパラメトライズ: `sessionConfigOverrides` で gateway から送信。agent が baseConfig にマージして SDK に渡す

ロジックの gateway 移行:
- SDK フックを gateway RPC 経由にする汎用機構（v0.51.0 で実現済み）: SDK の全フック（onPreToolUse, onPostToolUse, onUserPromptSubmitted, onSessionStart, onSessionEnd, onErrorOccurred）を事前に登録し、フック発火時に gateway に RPC（`{ type: "hook", hookName, sessionId, copilotSessionId, channelId, input }`）を送る。gateway が応答を返せばそれを使用、gateway 停止時は agent がフォールバック動作（onPostToolUse の場合は keepalive リマインダー）を自律実行。新しいフックタイプが SDK に追加された場合は agent の登録コードに追加が必要だが、フックのロジック変更は gateway 更新のみで反映される
- ツール定義の動的注入と処理の gateway 委譲（v0.53.0 で実現済み）: ツールの定義（名前、description、parameters スキーマ）を gateway config で送り、agent が SDK の `defineTool` で動的に登録する。gateway の更新だけでツールの追加・変更・削除が可能になる。ツールの処理本体も gateway に置く。agent のツールハンドラは generic dispatcher として gateway に RPC を送り、gateway が処理結果を返す。agent はそのまま SDK に返す。
  - `copilotclaw_wait` は特殊: agent に初めから存在を約束する（常に登録）。基本は gateway に RPC でロジックを委譲するが、gateway 停止時は agent 内の既定ロジック（keepalive cycle）にフォールバックして処理を継続する。これにより gateway 停止時も物理セッションが維持される
  - `copilotclaw_wait` 以外のツール: gateway 停止時は RPC が失敗する。ツールハンドラはエラーを返すのではなく、「gateway に接続できないため処理できない」旨を SDK に返す（物理セッションを壊さないため）
  - 前提制約: ツール RPC 失敗が物理セッション破壊につながる設計は許されない
- 物理セッションのライフサイクル判断を gateway に委ねる（v0.52.0 で実現済み）: SDK の `session.idle`（LLM がツールを呼ばずにターンを終了）や error 発生時に、agent は gateway に lifecycle RPC（`{ type: "lifecycle", event: "idle"|"error", sessionId, channelId, elapsedMs, error? }`）を送り、gateway が `{ action: "stop"|"reinject"|"wait", clearCopilotSessionId? }` で応答する。gateway が `stop` を返した場合のみ agent が `client.stop()` で物理セッションを破棄する。`reinject` の場合は `session.send()` で再投入してセッションを継続する。gateway 不在時のデフォルトは `wait`（物理セッションを破棄しない）

残存する設計違反 — agent が channel 概念を知っていた（v0.54.0 で解決済み）:
- agent の `startSession` が `boundChannelId` を必須とする（ないと例外）
- ツールが `channelId` で pending メッセージをフィルタリング（`drain_pending`, `peek_pending` が `channelId` をキーにする）
- `agent_notify` が `channelId` でフィルタリング
- lifecycle RPC に `channelId` を含める
- channel は gateway/dashboard の概念であり、agent が知るべきではない。agent は gateway が割り当てた不透明なセッショントークンだけで動作すべき。そのトークンが内部的に抽象セッション ID であるかどうかは gateway の事情であり、agent は関知しない
- 対応方針: agent の IPC プロトコルから `channelId` を除去し、gateway が `start_physical_session` で渡すセッショントークンのみで動作するようにする。`drain_pending`, `peek_pending`, `agent_notify`, `tool_call`, `hook`, `lifecycle` は全てこのトークンをキーにする。gateway がトークンと channelId のマッピングを管理し、agent は channel の存在を知らない

残存する設計違反 — agent のコードで抽象セッションと物理セッションの区別が曖昧だった（v0.54.0 で解決済み）:
- agent 内の変数名・メソッド名で「session」が抽象セッションと物理セッションのどちらを指すか不明確。例: `startSession`, `StartSessionOptions`, `sessionId`, `getSessionStatuses`, `suspendSession` 等
- agent は物理セッションだけを扱うため、agent 内の session 関連の命名は全て物理セッションであることを明示すべき
- 対応方針: agent 内の命名を全て physical を明示する形に変更する。例: `startSession` → `startPhysicalSession`, `StartSessionOptions` → `PhysicalSessionOptions`。抽象セッションと物理セッションの両方を指す場合のみ「session」を使う

残存する設計違反 — agent に gateway のポリシー判断情報が直接渡されていた（v0.54.0 で解決済み）:
- `zeroPremium` が agent に渡されている。これはモデル選択ポリシーであり、gateway が `resolveModel` で解決してモデル名を渡すだけでいい。agent 内の `resolveModel()` fallback にも zeroPremium 判定ロジックが残存している
- `debugMockCopilotUnsafeTools` が agent に渡されている。これはツール選択ポリシーであり、gateway が `toolDefinitions` で使えるツールを決めて渡すだけでいい。agent 内に `availableTools` フィルタリングロジックが残存している
- 対応方針: `zeroPremium` と `debugMockCopilotUnsafeTools` を agent の config から除去。agent は gateway から渡された解決済みの結果（モデル名、ツール定義リスト）をそのまま SDK に渡すパススルーになる

残存する設計違反 — agent の初期化シーケンスにタイミング問題がある（解決済み）:
- IPC stream 接続 → config push → agent が PhysicalSessionManager 作成 → `stream_connected` ハンドラ登録、の順序で初期化される
- `stream_connected` イベントはハンドラ登録前に発火するため、最初の接続で `running_sessions` report が送られない
- 場当たり的な修正（ハンドラ登録直後に即座に `running_sessions` を送信）が入っている
- 対応方針: `stream_connected` ハンドラを config 受信前に登録する。ハンドラ内で PhysicalSessionManager の存在を確認し、あれば `running_sessions` を送る。なければ初回接続と判断し、config 受信・PhysicalSessionManager 作成後に改めて送る。band-aid コードを削除する

残存する設計違反 — pooled CopilotClient の初期化が不完全（解決済み）:
- `getModels()`/`getQuota()` で pooled client を使う際に毎回 `client.start()` を呼んでいる
- 本来は client 作成時に一度 `start()` を呼び、以降は start 済みの client を再利用すべき

残存する設計違反 — agent がメッセージ種別を解釈していた（v0.53.0 で解決済み）:
- agent の `combineMessages()` が sender 種別（cron, system, user）を見て `[CRON TASK]`、`[SYSTEM EVENT]` 等のプレフィクスを付与している。これは gateway 停止時の copilotclaw_wait フォールバックパスで使われる
- agent はメッセージの種別を知る必要がない。何を LLM に渡して何を渡さないかの判断、メッセージのフォーマットは gateway の責務
- 対応方針: `drain_pending` の応答にフォーマット済みテキストを含めるか、store に入れる時点でフォーマット済みにする。agent のフォールバックは渡されたメッセージをそのまま結合するだけにする

**v0.54.0 時点の監査結果 — agent に残るロジックの分類:**

意図的に agent に残しているロジック（gateway 停止時の物理セッション延命のため）:
- keepalive ポーリング（drain→wait→drain）: gateway 停止時に `copilotclaw_wait` が自律的に物理セッションを延命する唯一の手段。gateway オンライン時は `tool_call` RPC で gateway が処理する
- hook fallback（`postToolUseFallback`）: gateway 停止時にリマインダーと pending 通知を最低限提供する。gateway オンライン時は hook RPC で gateway が処理する
- モデル選択 fallback（`resolveModel`）: gateway がモデルを解決できなかった場合のため。gateway オンライン時は gateway の `resolveModel` が主導する
- ライフサイクル fallback（`queryLifecycleAction` のデフォルト `"wait"`）: gateway 停止時に物理セッションを破棄しないため

v0.54.0 で解決済みの設計違反:
- swallowed-message 検出: agent から `pendingReplyExpected` フラグを削除。gateway の `onToolCall` ハンドラがセッションごとに追跡し、`copilotclaw_wait` 呼び出し時に判定・注入する
- reinject 上限: `MAX_REINJECT` を agent のハードコードから gateway config（`maxReinject`）に移行
- reminderState: agent から `reminderState`、`reminderThresholdPercent`、`systemReminder` を削除。gateway が `session_event`（`session.usage_info`, `session.compaction_complete`）を監視し、`onHook` の `onPostToolUse` 応答にリマインダーを含める
- コメント内の「abstract session」言及を修正

**v0.49.0 移行の経緯:**

v0.44.0〜v0.48.0 にかけて、設計原則（agent はミニマル、gateway が制御する）に反して agent 側に pending ポーリング、flush ロジック、stream 再接続時の pending チェック、バックオフ等を場当たり的に追加してしまった。その結果、cron が止まる問題が繰り返し発生し、gateway を更新しても agent を再起動しない限り修正が反映されない状態に陥った。v0.49.0 ではこれらのアドホックなコードを全て削除し、gateway 側の SessionOrchestrator に一元化する大規模な修正を行った。

**v0.49.0 移行後のコードレビューで発見された残存問題（一部は v0.50.0 で解決済み）:**

v0.49.0 で CRITICAL（チャンネルバインディング、suspended 永続化、復活、状態管理）と HIGH（バックオフ、stale 検出、max age、pending ポーリング）の項目は gateway 側 SessionOrchestrator に移行された。しかし、agent process にまだ以下のロジックが残存していた。v0.50.0 で一部を解決。

CRITICAL — 抽象セッション状態の二重管理（v0.50.0 で解決済み）:
- `suspendSessionState()` からトークン累積と physicalSessionHistory 管理を削除
- `AgentSessionInfo` から `physicalSession`、`subagentSessions` を削除。agent は status と boundChannelId のみ保持
- 物理セッション状態（currentState, tokens, subagent）は gateway の SessionOrchestrator が session_event から構築
- `/api/status` は orchestrator のデータを `agent.sessions` にマージして返すよう変更。フロントエンドは単一のデータソースを参照

CRITICAL — gateway 再起動時の二重セッション（v0.50.0 で解決済み）:
- agent が stream 接続時に `running_sessions` メッセージで動作中物理セッション一覧を送信
- gateway の `SessionOrchestrator.reconcileWithAgent()` が suspended セッションを revive
- reconcile 後に `checkAllChannelsPending()` を呼ぶため、revive 済みチャンネルへの新規セッション開始を防止
- sessionId 不整合（agent 側で独自 UUID を生成していた問題）も同時に修正。agent は gateway から渡された sessionId をそのまま使用するよう変更

HIGH — モデル選択ポリシーが agent にある（v0.50.0 で部分解決）:
- gateway が `resolveModel()` を持ち、物理セッション開始前に gateway 側でモデルを決定して agent に渡すよう変更
- agent は渡された resolvedModel をそのまま使用し、渡されない場合のみ自前の `resolveModel()` にフォールバック
- 残存: agent 側の `resolveModel()` は fallback として存在し続ける。agent を更新しなければ fallback アルゴリズムの変更は反映されない

HIGH — keepalive タイムアウトが agent にハードコード（v0.50.0 で解決済み）:
- `DEFAULT_KEEPALIVE_TIMEOUT_MS` 定数を `tools/channel.ts` から削除
- `keepaliveTimeoutMs` を `AgentPromptConfig` に追加し、gateway から IPC 経由で送信するよう変更
- `AgentSessionManager` コンストラクタが `keepaliveTimeoutMs` を受け取り、`createChannelTools` に渡す
- gateway を再起動するだけで keepalive タイムアウトを変更できるようになった

MEDIUM — 物理セッション状態の詳細追跡が agent にある（v0.50.0 で解決済み）:
- `PhysicalSessionSummary` の更新と `SubagentInfo[]` の追跡を agent から削除
- gateway の daemon.ts `onSessionEvent` ハンドラが session_event のイベントタイプに応じて SessionOrchestrator のメソッドを呼び出し、リアルタイムで状態を構築
- 対応イベント: tool.execution_start/complete, session.idle, session.usage_info, assistant.usage, session.model_change, subagent.started/completed/failed

MEDIUM — リマインダーポリシーが agent にハードコード（v0.50.0 で部分解決）:
- `reminderThresholdPercent` を `AgentPromptConfig` に追加し、gateway から IPC 経由で送信するよう変更
- `AgentSessionManager` コンストラクタが値を受け取り、コンテキスト使用率判定に使用
- gateway を再起動するだけでリマインダー閾値を変更できるようになった
- 残存: `session.compaction_complete` 後の即時リマインドフラグは agent 内にハードコードされたまま

LOW — workspace bootstrap が二重実行される可能性（v0.50.0 で解決済み）:
- `ensureWorkspaceReady()` を agent-session-manager.ts から削除
- workspace bootstrap は gateway の `ensureWorkspace()`（daemon.ts 起動時）のみが担当するよう一元化

**動作確認課題:**

- v0.44.0〜v0.48.0 で agent 側に追加した pending チェック・flush・バックオフのコードが正しく削除されているか
- それらの機能が gateway 側の SessionOrchestrator で正しく代替されているか
- gateway 再起動後に cron が正常に発火し、セッションが revive されるか
- セッション idle exit 後に pending が flush され、次の cron が dedup でブロックされないか
- agent 再起動（stream disconnect）後に gateway が全セッションを suspended に遷移し、再接続時に pending を検出して revive するか
- **gateway 再起動（agent 生存）時に旧物理セッションとの二重セッションが発生しないか（v0.50.0 で running_sessions reconciliation により対応済み、検証要）**
- gateway 再起動で agent を再起動せずに最新の gateway ロジックが機能するか（設計原則の検証）
- SessionOrchestrator の SQLite 永続化が gateway 再起動をまたいで正しく復元されるか
- agent-bindings.json からの一括マイグレーションが正しく動作するか
- `/api/status` が orchestrator の抽象セッション状態と agent の物理セッション状態を正しくマージしているか
- 複数チャンネルの並走 cron が独立して動作するか

### 物理 Session 停止後の記憶保持

物理 session が停止した後に再開する際、直前のコンテキスト（会話履歴や作業状態）をできる限り保持する。

**方式: 優先的に resumeSession を使用**

物理 session 停止時に `session.disconnect()` で状態を保存し、copilotSessionId を抽象 agent session に保持する。再開時に `client.resumeSession(copilotSessionId, config)` で復元する。SDK が会話履歴を保持しているため、完全な記憶の継続が期待できる。

```
物理 session 停止
  → session.disconnect() で状態保存
  → copilotSessionId を抽象 agent session に保存

再開トリガー（user message 到着等）
  → 保存された copilotSessionId があれば client.resumeSession() で復元
  → copilotSessionId がなければ（agent restart 後に永続化が間に合わなかった等）新規作成
    → 新規作成時は copilotclaw_list_messages で直近の会話履歴を取得し、初期プロンプトに含める
```

**フォールバック: 会話履歴の注入**

resumeSession が使えない場合（copilotSessionId が失われた場合や、resume が失敗した場合）は、`copilotclaw_list_messages` で直近の会話履歴を取得し、新規 session の初期プロンプトにコンテキストとして含める。完全な記憶保持ではないが、ユーザーにとっての体験の断絶を最小化する。

### Channel ツール

カスタムツール名は `copilotclaw_` プレフィクスで統一する。

| ツール名 | 用途 | 戻り |
| :--- | :--- | :--- |
| `copilotclaw_send_message` | channel にメッセージを送信する | 即時 return |
| `copilotclaw_wait` | channel の未処理 user message をポーリングで受け取る | input 到着 or keepalive timeout で return |
| `copilotclaw_list_messages` | channel の過去メッセージを取得する | 即時 return |

#### copilotclaw_send_message

- パラメータ: `{ message: string }`
- channel にメッセージを POST し、即座に return する
- 作業途中の状況報告に使用する（ポーリングを伴わないため、作業フローをブロックしない）

#### copilotclaw_wait

- パラメータ: なし
- channel の未処理 user message をポーリングで待機する（keepalive timeout: 25 分）
- 同一 channel に未処理の user message が複数ある場合、一括取得して連結して返す
- keepalive timeout 到達時は空の結果を返し、即座に再呼び出しを指示する
- session が idle になるのはこの tool の keepalive timeout 時のみ（`session.send()` によるプレミアムリクエスト消費は約 30 分に 1 回）

#### copilotclaw_list_messages

- パラメータ: `{ limit?: number }`（デフォルト: 5）
- channel の過去メッセージを最新順に取得する
- 各メッセージに sender（`"user"` or `"agent"`）を付与する

### assistant.message イベントのタイムライン自動反映

agent は本来 `copilotclaw_send_message` tool で channel にメッセージを送るべきだが、LLM が tool を呼ばずにテキスト応答を生成することがある。この場合、ユーザーからは agent が無応答に見える。`assistant.message` イベントをフォールバックとして channel に反映することで、agent のテキスト応答が確実にユーザーに届くようにする。

**処理の実行場所: gateway 側（`onSessionEvent`）**

gateway は既に `session_event` として `assistant.message` を受信しているため、gateway の `onSessionEvent` ハンドラで `assistant.message` イベントを検出し、channel タイムラインに反映する。agent 側では `assistant.message` に対する個別の `channel_message` 送信は行わない。

```
gateway onSessionEvent ハンドラ
  → session_event（eventType: "assistant.message"）受信
  → data.content が空でないか確認
  → sessionId から channel binding を解決
  → 条件を満たす → channel タイムラインに sender=agent のメッセージとして追加 + SSE broadcast
  → 条件を満たさない → 何もしない
```

設計根拠: gateway は既に `session_event` として `assistant.message` を受信しているので、gateway 側の `onSessionEvent` で処理すべき。agent 側で直接 `channel_message` を送信するのは wrong-side ロジック。（v0.62.0 で実現済み。MIN_AGENT_VERSION を 0.62.0 に引き上げ）

- `copilotclaw_send_message` tool と `assistant.message` の両方が同じ内容を送る可能性がある。重複排除は現時点では行わない（agent のメッセージが届かないリスクの方が、重複するリスクより大きいため）
- `assistant.message` はターンごとに複数回発生しうる（tool call の合間に assistant がテキストを返す場合）。各メッセージを個別に channel に反映する
- 空文字列や content が存在しないイベントは無視する

### Custom Agent 構成

Copilot SDK の `customAgents` 機能を用いて、copilotclaw のシステムプロンプトを custom agent の固有プロンプトとして設定する。これにより、context compaction が発生してもシステムプロンプトが消失せず、`copilotclaw_wait` の呼び出し義務が安定的に維持される。

#### channel-operator（channel 対話用 agent）

user と直接やりとりする唯一の agent。session 作成時に `agent: "channel-operator"` で即座にアクティブ化する。

```typescript
{
  name: "channel-operator",
  displayName: "Channel Operator",
  description: "The primary agent that directly communicates with the user through the channel. "
    + "WARNING: This agent must NEVER be called as a subagent. "
    + "NEVER NEVER NEVER dispatch this agent as a subagent — doing so will cause catastrophic failure. "
    + "This agent is EXCLUSIVELY the top-level operator that manages the channel lifecycle.",
  tools: null, // all built-in tools + copilotclaw_wait, copilotclaw_send_message, copilotclaw_list_messages
  prompt: "You are a copilotclaw agent bound to a channel. ...(system prompt)...",
  infer: false, // subagent として推論で選ばれてはならない
}
```

システムプロンプトの内容（`prompt` フィールド）:
- `copilotclaw_wait` を呼び出してユーザーの入力を待つこと
- 処理後は `copilotclaw_send_message` で応答を送り、再び `copilotclaw_wait` を呼ぶこと
- `additionalContext` で新着通知が届く可能性があること
- **CRITICAL**: `copilotclaw_wait` を呼び出さずに停止すると、デッドロックが発生し、セッションが永久に応答不能になる。これは回復不可能な致命的障害であり、絶対に避けなければならない

`infer: false` に設定する理由: `infer: true` の場合、CLI ランタイムが推論で subagent としてこの agent を選択する可能性がある。channel-operator は subagent として動作してはならないため、推論対象から除外する。

#### worker（subagent 用 agent）

subagent として呼び出される汎用 agent。

```typescript
{
  name: "worker",
  displayName: "Worker",
  description: "The ONLY agent to dispatch as a subagent. "
    + "When you need to delegate work to a subagent, you MUST use this agent — there is no other option. "
    + "This is the sole subagent available for task delegation. Always use 'worker' for any subagent dispatch.",
  tools: null, // all built-in tools + copilotclaw_send_message, copilotclaw_list_messages
  prompt: "", // 特別なシステムプロンプトは不要
  infer: true, // subagent として推論で選ばれることを許可
}
```

worker には `copilotclaw_wait` を含めない。subagent はユーザー入力を直接受け取る立場にないため。`copilotclaw_send_message` と `copilotclaw_list_messages` は、subagent がチャンネルの文脈を参照したり、作業進捗を報告するために使用する。

### onPostToolUse hook によるシステムプロンプト補強（定期リマインド）

`copilotclaw_wait` の呼び出し義務が compaction やコンテキスト圧迫で失われることを防ぐため、`onPostToolUse` hook の `additionalContext` を利用して定期的にリマインドする。

#### 発火条件

channel に紐づく agent session でのみ発火する。subagent の tool 実行では絶対に発火してはならない（subagent は `copilotclaw_wait` を持たず、普通に停止すべきため）。

SDK の `onPostToolUse` hook は subagent のツール実行では発火しない（v0.39.0 の debug ログによる実測で確認済み）。CLI が `hooks.invoke` RPC をメインエージェントのツール実行時のみ送信するため。SDK 自体には parent/subagent の区別はない。

したがって、hook ハンドラ内で `toolName` による subagent 排除ゲートは不要。全ての hook 呼び出しはメインエージェントのツール実行であることが保証される。リマインドの発火頻度は `reminderState.needsReminder`（10% ごと + compaction 直後）で制御する。

### デバッグ用ログレベル（v0.39.0 で実現済み）

config ファイルに `debug.logLevel` 設定を追加し、通常は出力されない debug レベルのログを有効化できるようにする。

**config 設計:**
- 設定キー: `debug.logLevel`（`"info"` | `"debug"`）
- デフォルト: `"info"`（debug ログは出力されない）
- config スキーマバージョンのマイグレーション（v3→v4）で `debug` 名前空間を追加

**debug ログの対象:**
- `onPostToolUse` hook の呼び出し: toolName、実行結果の概要、additionalContext の有無
- `onPostToolUse` hook のゲート判定: どのツールで発火し、どのツールでスキップされたか
- その他、調査時に有用な内部状態

**実装方針:**
- `AgentSessionManagerOptions` に `debugLogLevel` を追加
- `this.log()` とは別に `this.debug()` メソッドを用意し、`debugLogLevel === "debug"` の場合のみ出力する
- gateway から agent への config push で `debug` 設定を伝搬する

#### 発火頻度

毎回発火するとコンテキストを浪費するため、以下の条件で制御する:

- **定期リマインド**: `session.usage_info` イベントの `currentTokens` / `tokenLimit` を監視し、context 使用率が前回リマインド時から 10% 以上増加した場合に、次の `onPostToolUse` で 1 回だけ発火する
- **compaction 直後リマインド**: `session.compaction_complete` イベントを受信したら、次の `onPostToolUse` で即座に 1 回発火する（compaction 後は LLM の動作が不安定になりやすいため）

```
session.usage_info イベント受信
  → currentUsagePercent = currentTokens / tokenLimit
  → lastReminderPercent + 0.10 ≤ currentUsagePercent の場合
    → needsReminder = true

session.compaction_complete イベント受信
  → needsReminder = true
  → lastReminderPercent = 0（リセット — compaction 後は使用率が下がるため）

onPostToolUse 発火（channel に紐づく親 agent のみ）
  → needsReminder === true の場合
    → additionalContext に <system> タグ付きリマインドを挿入
    → needsReminder = false
    → lastReminderPercent = currentUsagePercent
```

#### リマインド内容

`additionalContext` に挿入する内容:

```
<system>
CRITICAL REMINDER: You MUST call copilotclaw_wait to wait for user input.
Stopping without calling copilotclaw_wait causes an irrecoverable deadlock.
After processing a task, always call copilotclaw_send_message to send your response,
then call copilotclaw_wait to wait for the next input. NEVER stop or idle
without copilotclaw_wait.
</system>
```

#### システムプロンプトへの記載

channel-operator の `prompt` フィールドに以下を含める:

- `additionalContext` に、現在の tool use とは無関係だが重要な指示が `<system>` タグで差し込まれることがある
- そのような指示は、copilotclaw システムからの運用上の重要指示であり、必ず従うこと

LLM は最初と最後の情報に重みを置く傾向があるため、この説明はシステムプロンプトの末尾付近に配置する。

### Subagent 完了通知（v0.43.0 で実現済み — gateway 側 agent_notify 統一方式）

subagent の完了・失敗を親 agent にリアルタイムに通知する仕組み。subagent は親 agent から非同期的に dispatch されるため、完了を知覚する手段がないと、親は subagent の結果を活用できない。

subagent call はネストされることがある。直接呼び出した subagent の停止（成功・失敗両方）のみを通知する。session event の `parentToolCallId` で直接呼び出しかどうかを判定できる。

**設計原則:**
- wait 中のイベント処理をアドホックに行わない。統一的な通知の仕組みを使う
- フィルタリングロジック（直接呼び出し判定等）は gateway process 側に置く。agent process は通知を受けて wait を解除するだけ
- 理由: agent process をミニマルに保ち、gateway の更新だけで最新機能を享受できるコンセプトを維持する

**現状の問題:**
- `subagentCompletionQueue` にイベントは積まれるが、`pollNextInputs` のブロック（`waitForPendingNotify` の25分タイムアウト待ち）を解除する仕組みがない
- subagent 完了後、最大25分間 wait が解除されない
- フィルタリングロジック（直接呼び出し判定）が agent process 側にある

**対応方針:**

```
agent process
  → subagent.completed / subagent.failed session event を gateway に送信（既存の forwardEvent で実現済み）

gateway process（daemon.ts の onSessionEvent ハンドラ）
  → session event を受信
  → 直接呼び出し判定: event の toolCallId が親 agent が直接呼び出した task ツールの toolCallId と一致するか
  → 直接呼び出しの場合のみ、agent に通知を push（IPC stream 経由、pending_notify と同じ仕組み）

agent process
  → 通知を受信 → copilotclaw_wait のブロックを解除
  → tool result として subagent 停止情報を返す
```

**直接呼び出しの判定（gateway 側）:**
- `subagent.completed` / `subagent.failed` イベントの `data.toolCallId` は、subagent を起動した `task` ツールの `toolCallId` と一致する
- ネストされた孫 subagent の completion イベントは、親 agent が直接呼び出した `toolCallId` と一致しないため、通知しない

**agent 側の統一的な wait 解除:**
- gateway からの push 通知を1つの汎用チャネル（例: `agent_notify`）に統一する
- agent 側は通知の種類を一切区別しない。「通知が来たら wait を解除して drain する」だけ
- 通知の種類（メッセージ到着、subagent 完了、将来の新機能）は全て gateway 側が決定し、gateway が agent_notify を push する
- これにより、新しい通知種類を追加する際に agent process のコードを変更する必要がない（gateway の更新だけで対応できる）
- 現在の `pending_notify` もこの汎用チャネルに統合する

**親が作業中の場合の通知:**
- 親 agent がまだ他の tool を実行中に subagent が完了した場合、`onPostToolUse` hook の `additionalContext` で通知する（既存の仕組みを流用）

subagent 停止情報には以下を含む（`subagent.completed` / `subagent.failed` イベントのデータ）:
- `toolCallId` — dispatch 時の tool call ID
- `agentName` / `agentDisplayName`
- `status` — "completed" or "failed"
- `error` — 失敗時のエラーメッセージ
- `model`, `totalToolCalls`, `totalTokens`, `durationMs` — 実行統計

### Post Tool Use Hook による新着通知


channel に紐づく agent session では、SDK の `onPostToolUse` hook を登録する。

```
任意の tool 実行完了
  → onPostToolUse 発火
  → 当該 channel に未読の user message があるか gateway に確認
  → 未読あり → additionalContext に通知を追加:
    「新しい user message があります。copilotclaw_wait で即時確認してください。」
  → 未読なし → 何もしない
```

channel に紐づく agent session の起動時プロンプトには、「tool の response の additionalContext で新着通知がされる可能性がある」ことを含める。

### Gateway の起動フロー

VSCode の CLI デタッチ方式（`spawn({ detached: true })` + `child.unref()`）を参考に、CLI プロセスとサーバープロセスを分離する。

CLI 出力には gateway のバージョンを含める。

```
CLI (copilotclaw gateway start)
  → health check
  → healthy → "already running" + gateway バージョンを表示して CLI 終了
  → unhealthy → リトライ（数回）→ タイムアウトで起動失敗
  → port free → サーバープロセスを detached spawn → health check で起動確認 + gateway バージョン表示 → CLI 終了

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

### Copilot 物理セッションの状態可視化

agent process 上の論理的な agent session と、Copilot SDK 上の物理的な session の両方の状態を API およびダッシュボードで確認できるようにする。

#### データ構造

```
agent session（論理）
  → copilot physical session（SDK session）
    → subagent physical session（0〜複数、SDK ランタイムが生成）
```

#### API エンドポイント

IPC `status` レスポンスの各 session に、物理セッション情報を追加する:

| フィールド | 型 | 意味 |
| :--- | :--- | :--- |
| `physicalSession` | `PhysicalSessionSummary?` | Copilot SDK セッションのサマリー |
| `subagentSessions` | `PhysicalSessionSummary[]` | subagent の物理セッション一覧 |

PhysicalSessionSummary:

| フィールド | 型 | 意味 |
| :--- | :--- | :--- |
| `sessionId` | `string` | SDK session ID |
| `model` | `string` | 使用中のモデル |
| `startedAt` | `string` | 開始時刻 |
| `currentState` | `string` | 現在の状態（idle, tool 呼び出し中, etc.）。後述の「currentState の正確な追跡」を参照 |
| `currentTokens` | `number?` | 現在のコンテキストトークン数（`session.usage_info` イベントから取得） |
| `tokenLimit` | `number?` | 最大コンテキストウィンドウサイズ（`session.usage_info` イベントから取得） |
| `totalInputTokens` | `number?` | 累計入力トークン数（`assistant.usage` イベントから積算） |
| `totalOutputTokens` | `number?` | 累計出力トークン数（`assistant.usage` イベントから積算） |

#### assistant.usage イベントの活用

`assistant.usage` イベント（ephemeral）は LLM API コールごとに発火し、以下の情報をリアルタイムで提供する:

- `inputTokens` / `outputTokens` を積算 → 物理セッションの累計消費トークン数
- `quotaSnapshots` → プレミアムリクエスト残量のリアルタイム更新（`/api/quota` の IPC 往復を省略可能）
- `cost` → API コールごとのコスト追跡
- `parentToolCallId` → subagent のコストを分離して追跡可能

#### サマリー表示（ダッシュボードモーダル）

ステータス詳細モーダルに以下を追加:
- プレミアムリクエスト残量/上限（`assistant.usage` イベントの `quotaSnapshots` からリアルタイム取得、または `client.rpc.account.getQuota()` からフォールバック取得）
- 利用可能なモデルとプレミアムリクエスト乗数（`client.rpc.models.list()` から取得）
- 各物理セッションのサマリー（session ID, model, コンテキスト使用率, 累計トークン消費, 経過時間, 状態）
- 経過時間はクライアントサイドで `startedAt` から動的計算して表示

#### 詳細表示（個別セッション選択時）

モーダル内で物理セッションをクリックすると詳細パネルを展開表示:
- サマリーの全項目
- 現在のコンテキスト内容（`session.getMessages()` で取得した会話履歴）
- IPC `session_messages` メソッド → gateway `/api/sessions/{{sessionId}}/messages` で公開

### 物理セッション currentState の正確な追跡（v0.44.0 で実現済み）

`currentState` は SDK の `tool.execution_start` / `tool.execution_complete` イベントに依存しているが、`copilotclaw_wait` の keepalive サイクルにおいてツール完了から次のツール呼び出しまでの間に一瞬 `idle` に遷移し、実際のアプリケーション状態を反映しない。

**対応方針:**

`onStatusChange` コールバックでアプリケーション側の状態遷移を `currentState` にも反映する:

- `onStatusChange("waiting")` 呼び出し時 → `currentState = "tool:copilotclaw_wait"` に設定
- `onStatusChange("processing")` 呼び出し時 → `currentState` は変更しない（直後に SDK の `tool.execution_complete` で正しく `idle` になる）
- SDK の `tool.execution_start` / `tool.execution_complete` イベントは引き続き他のツール（`copilotclaw_send_message`、`grep` 等）の状態追跡に使用する
- `copilotclaw_wait` に対する `tool.execution_complete` でも `idle` にリセットされるが、直後に `onStatusChange("waiting")` が `tool:copilotclaw_wait` に上書きするため、結果的に正しい状態が維持される

**変更箇所:**

- `packages/agent/src/agent-session-manager.ts`: `onStatusChange` コールバック内で `status === "waiting"` の場合に `physicalSession.currentState` も設定

### postToolUse ログのセッション ID 付与（v0.44.0 で実現済み）

postToolUse のログにセッション ID を含め、複数セッション並走時の診断を可能にする。

**対応方針:**

- `onPostToolUse` hook 内の `this.debug()` 呼び出しに、抽象セッション ID を追加する
- 形式: `postToolUse: [{{sessionId}}] tool={{toolName}}`

**変更箇所:**

- `packages/agent/src/agent-session-manager.ts`: `onPostToolUse` hook 内のログにセッション ID を付与

### Dashboard Processing インジケータ

Agent session が processing 状態のとき、chat UI の末尾にアニメーション付きの「processing...」インジケータを表示する。

表示条件:
- `/api/status` ポーリング（5秒間隔）で session status が "processing" のとき表示

非表示条件（いずれか）:
- `/api/status` ポーリングで session status が "processing" 以外に変わったとき
- SSE `new_message` イベントで sender が "agent" のメッセージが到着したとき（即時非表示 + status リフレッシュ）
- chat リフレッシュ時に前回の visible 状態を復元（リフレッシュで消えないようにする）

注意: processing indicator のクライアントサイド動作（SSE イベントによる即時非表示等）はサーバーサイド HTML レンダリングのユニットテストではカバーできない。Playwright 導入時にブラウザ E2E テストとして優先的にカバーすべきテストケース。

### セッション失敗時のバックオフ

セッション開始が即座に失敗した場合に、ポーリングループが即再試行して無限ループに陥ることを防止する。

実装:
- セッションが短時間（30秒未満）で失敗した場合、`recordBackoffIfRapidFailure` がチャンネルにバックオフ（60秒）を記録する
- ポーリングループで `isChannelInBackoff` をチェックし、バックオフ中のチャンネルはスキップする
- バックオフ期間が経過すると自動的に解除される

### エラー詳細のユーザー通知

"[SYSTEM] Agent session stopped unexpectedly." メッセージにエラーの概要を含め、ユーザーが原因を把握できるようにする。

実装:
- `notifyChannelSessionStopped` にオプショナルな `reason` パラメータを追加
- `.catch((err) => ...)` ブロックでエラーメッセージを抽出して渡す
- 正常終了（idle）時は理由なし、エラー時は理由を含む: "[SYSTEM] Agent session stopped unexpectedly: {{reason}}. A new session will start when you send a message."

### copilotclaw_wait のエラー不可侵性

`copilotclaw_wait` ツールはいかなる状況でも絶対にエラーを返さない。エラーを返すと agent の物理 session が停止し、デッドロックに陥る。

設計原則:
- どのような例外（ネットワーク障害、gateway ダウン、不正なレスポンス等）が発生しても、ツールハンドラ内でキャッチする
- エラー時はタイムアウト時と全く同じレスポンスを返す（copilotclaw_wait の再呼び出し指示）
- エラーの発生事実や理由を response に含めない — agent がエラーを知覚するとデッドロックの危険がある
- エラーはシステムログ（console.error）にのみ記録する

実装方針:
- `wait` ハンドラの最外層を try-catch で囲む
- catch 節ではエラーをログに記録し、タイムアウト時と同じレスポンスオブジェクトを返す
- throw は絶対にしない

```
wait handler:
  try {
    ... (既存のポーリングロジック)
  } catch (err) {
    console.error("[agent] receive_input internal error (suppressed):", err)  // ログのみ
    return { userMessage: KEEPALIVE_INSTRUCTION }  // タイムアウトと同一
  }
```

影響範囲:
- `packages/agent/src/tools/channel.ts` — `wait` ハンドラに最外層 try-catch 追加

### copilotclaw_wait（旧 copilotclaw_receive_input からの rename）

`copilotclaw_wait` を `copilotclaw_wait` に rename する。ツールの本質はユーザー入力の受信だけでなく、「自分のやることがなくなった全ての状況で呼び出す」汎用的な待機メカニズムであるため。

**rename 対象:**
- ツール名: `copilotclaw_wait` → `copilotclaw_wait`
- `PARENT_ONLY_TOOL` 定数
- 変数名 `wait`（channel.ts 内、旧 `receiveInput`）
- テスト内のツール名参照
- ドキュメント内の全参照（raw-requirements, requirements, proposals 内。ただし raw-requirements は human 原文のため追記で対応し、既存テキストは改変しない）

**channel-operator システムプロンプトの更新方針:**

既存の DEADLOCK PREVENTION 警告を、より広い利用シーンをカバーする形に更新する:

- `copilotclaw_wait` は、直近一時的にでも自分のやることがなくなったときに必ず呼ぶ
- `copilotclaw_wait` を使わずにターンを終了するとデッドロック（セッション停止、回復不能）
- 利用シーン:
  - 会話のターンをユーザーに渡すとき、ユーザーの回答を待つとき
  - subagent を呼び出したあと、自分自身がやることがなくなって、それを待つ状態になったとき
  - 全ての作業を完遂したとき
  - 何をすればいいか分からないとき
  - 想定しないシステム的な異常事態に陥ったとき

**互換性への影響:**
- agent 側のツール名が変わるため、gateway-agent の IPC プロトコル自体には影響しない（ツール名は Copilot SDK 内部の概念であり、IPC プロトコルの一部ではない）
- ただし、`onPostToolUse` hook のゲート判定で `PARENT_ONLY_TOOL` を参照しているため、rename 後も一貫性を保つ必要がある

