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

### assistant.message イベントのタイムライン自動反映

channel に紐づく agent session の `assistant.message` イベントを監視し、そのメッセージを channel タイムラインに sender=agent のメッセージとして自動投稿する。

意図: agent は本来 `copilotclaw_send_message` tool で channel にメッセージを送るべきだが、LLM が tool を呼ばずにテキスト応答を生成することがある。この場合、ユーザーからは agent が無応答に見える。`assistant.message` イベントをフォールバックとして channel に反映することで、agent のテキスト応答が確実にユーザーに届くようにする。

```
agent session イベント購読（session.on("assistant.message", ...)）
  → assistant.message イベント受信
  → content が空でないか確認
  → channel binding が存在するか確認
  → 条件を満たす → channel タイムラインに sender=agent のメッセージとして POST（postChannelMessage）
  → 条件を満たさない → 何もしない
```

- `copilotclaw_send_message` tool と `assistant.message` の両方が同じ内容を送る可能性がある。重複排除は現時点では行わない（agent のメッセージが届かないリスクの方が、重複するリスクより大きいため）
- `assistant.message` はターンごとに複数回発生しうる（tool call の合間に assistant がテキストを返す場合）。各メッセージを個別に channel に反映する
- 空文字列や content が存在しないイベントは無視する

### Custom Agent 構成

Copilot SDK の `customAgents` 機能を用いて、copilotclaw のシステムプロンプトを custom agent の固有プロンプトとして設定する。これにより、context compaction が発生してもシステムプロンプトが消失せず、`copilotclaw_receive_input` の呼び出し義務が安定的に維持される。

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
  tools: null, // all built-in tools + copilotclaw_receive_input, copilotclaw_send_message, copilotclaw_list_messages
  prompt: "You are a copilotclaw agent bound to a channel. ...(system prompt)...",
  infer: false, // subagent として推論で選ばれてはならない
}
```

システムプロンプトの内容（`prompt` フィールド）:
- `copilotclaw_receive_input` を呼び出してユーザーの入力を待つこと
- 処理後は `copilotclaw_send_message` で応答を送り、再び `copilotclaw_receive_input` を呼ぶこと
- `additionalContext` で新着通知が届く可能性があること
- **CRITICAL**: `copilotclaw_receive_input` を呼び出さずに停止すると、デッドロックが発生し、セッションが永久に応答不能になる。これは回復不可能な致命的障害であり、絶対に避けなければならない

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

worker には `copilotclaw_receive_input` を含めない。subagent はユーザー入力を直接受け取る立場にないため。`copilotclaw_send_message` と `copilotclaw_list_messages` は、subagent がチャンネルの文脈を参照したり、作業進捗を報告するために使用する。

### onPostToolUse hook によるシステムプロンプト補強（定期リマインド）

`copilotclaw_receive_input` の呼び出し義務が compaction やコンテキスト圧迫で失われることを防ぐため、`onPostToolUse` hook の `additionalContext` を利用して定期的にリマインドする。

#### 発火条件

channel に紐づく agent session でのみ発火する。subagent の tool 実行では絶対に発火してはならない（subagent は `copilotclaw_receive_input` を持たず、普通に停止すべきため）。

SDK の `onPostToolUse` hook は subagent の tool 実行でも発火する（subagent は同じセッションを resume するため）。`invocation.sessionId` も常に同じ値であり、hook inputs に `parentToolCallId` は含まれない。つまり、SDK の hook system には parent と subagent を区別する手段がない。

そのため、`toolName` で判別する。`copilotclaw_receive_input` は parent agent (channel-operator) のみに与えられる唯一の専用ツールであり、subagent (worker) には提供されない。`copilotclaw_send_message` と `copilotclaw_list_messages` は worker も使用するため、これらでのゲートは不可。

リマインドと通知は `toolName === "copilotclaw_receive_input"` の場合にのみ発火する

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
CRITICAL REMINDER: You MUST call copilotclaw_receive_input to wait for user input.
Stopping without calling copilotclaw_receive_input causes an irrecoverable deadlock.
After processing a task, always call copilotclaw_send_message to send your response,
then call copilotclaw_receive_input to wait for the next input. NEVER stop or idle
without copilotclaw_receive_input.
</system>
```

#### システムプロンプトへの記載

channel-operator の `prompt` フィールドに以下を含める:

- `additionalContext` に、現在の tool use とは無関係だが重要な指示が `<system>` タグで差し込まれることがある
- そのような指示は、copilotclaw システムからの運用上の重要指示であり、必ず従うこと

LLM は最初と最後の情報に重みを置く傾向があるため、この説明はシステムプロンプトの末尾付近に配置する。

### Subagent 完了通知

subagent の完了・失敗を親 agent にリアルタイムに通知する仕組み。subagent は親 agent から非同期的に dispatch されるため、完了を知覚する手段がないと、親は subagent の結果を活用できない。

通知手段は2つ:

**手段: copilotclaw_receive_input での通知（親が待機中の場合）**

親 agent が subagent を dispatch した後、ほとんどの場合 `copilotclaw_receive_input` で待機する。subagent が完了/失敗したとき、`copilotclaw_receive_input` の内部で保持している subagent 完了イベントキューをチェックし、user message の到着と同様に tool の戻り値として subagent 停止情報を返す。

```
copilotclaw_receive_input 実行中
  → subagent.completed or subagent.failed イベント発生
  → イベントキューに蓄積
  → ポーリングサイクルでキューをチェック
  → キューにイベントあり → tool result として subagent 停止情報を返す
    （user message が同時にあれば、それも一緒に返す）
```

**手段: onPostToolUse hook での通知（親が作業中の場合）**

親 agent がまだ他の tool を実行している最中に subagent が完了した場合、`onPostToolUse` hook の `additionalContext` に subagent 停止情報をねじ込む。既存の新着 user message 通知と同様のメカニズム。

```
任意の tool 実行完了
  → onPostToolUse 発火
  → subagent 完了イベントキューをチェック
  → キューにイベントあり → additionalContext に subagent 停止情報を追加
```

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
    「新しい user message があります。copilotclaw_receive_input で即時確認してください。」
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
| `currentState` | `string` | 現在の状態（idle, tool 呼び出し中, etc.） |
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

### Dashboard Processing インジケータ

Agent session が processing 状態のとき、chat UI の末尾にアニメーション付きの「processing...」インジケータを表示する。

表示条件:
- `/api/status` ポーリング（5秒間隔）で session status が "processing" のとき表示

非表示条件（いずれか）:
- `/api/status` ポーリングで session status が "processing" 以外に変わったとき
- SSE `new_message` イベントで sender が "agent" のメッセージが到着したとき（即時非表示 + status リフレッシュ）
- chat リフレッシュ時に前回の visible 状態を復元（リフレッシュで消えないようにする）

注意: processing indicator のクライアントサイド動作（SSE イベントによる即時非表示等）はサーバーサイド HTML レンダリングのユニットテストではカバーできない。Playwright 導入時にブラウザ E2E テストとして優先的にカバーすべきテストケース。

