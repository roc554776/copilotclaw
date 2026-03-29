# Session Events と Hooks の実測分析

調査日: 2026-03-28 〜 2026-03-29

## データソース

| セッション | チャンネル | イベント数 | 内容 |
|---|---|---|---|
| c7b798ec | 8be360d1 | 300 | 9回の user message、subagent 8回（explore 1 + worker 7） |
| b834dbd8 | 671c2d73 | 527 | 長期稼働セッション、session.idle 7回発生 |
| b627212c | f536a152 | 38 | debug.logLevel=debug での hook 発火検証 |

ダンプファイル: [dumps/](dumps/)

## Session Event の型と構造

### イベント型一覧

| 型 | 説明 |
|---|---|
| `assistant.turn_start` | ターン開始。`turnId`（連番文字列）と `interactionId` を持つ |
| `assistant.turn_end` | ターン終了。`turnId` のみ |
| `assistant.usage` | LLM 呼び出しごとのトークン使用量 |
| `assistant.message` | LLM のレスポンス。`content` + `toolRequests` を持つ |
| `tool.execution_start` | ツール実行開始 |
| `tool.execution_complete` | ツール実行完了 |
| `session.usage_info` | セッション全体のトークン使用状況 |
| `session.idle` | LLM がツール呼び出しを停止した状態 |
| `subagent.started` | subagent 起動 |
| `subagent.completed` | subagent 完了 |

### 各イベントの data 構造

**assistant.turn_start:**
```json
{ "turnId": "0", "interactionId": "uuid" }
```

**assistant.usage:**
```json
{
  "model": "gpt-5-mini",
  "inputTokens": 11475, "outputTokens": 630,
  "cacheReadTokens": 2304, "cacheWriteTokens": 0,
  "cost": 0, "duration": 18888,
  "initiator": "user" | "agent" | "sub-agent",
  "apiCallId": "..."
}
```

**assistant.message:**
```json
{
  "messageId": "uuid",
  "content": "テキスト応答",
  "toolRequests": [{ "toolCallId": "call_xxx", "name": "toolName", "arguments": {}, "type": "function" }],
  "parentToolCallId": "call_xxx"
}
```
`parentToolCallId` は subagent のイベントのみに付与される。

**tool.execution_start / tool.execution_complete:**
```json
{
  "toolCallId": "call_xxx",
  "toolName": "copilotclaw_wait",
  "arguments": {},
  "parentToolCallId": "call_xxx"
}
```

**session.usage_info:**
```json
{ "currentTokens": 12231, "tokenLimit": 128000 }
```

**session.idle:**
```json
{}
```
data は空オブジェクト。

**subagent.started:**
```json
{ "toolCallId": "call_xxx", "agentName": "worker", "agentDisplayName": "Worker", "agentDescription": "..." }
```

**subagent.completed:**
```json
{ "toolCallId": "call_xxx", "agentName": "worker", "agentDisplayName": "Worker" }
```

## イベント順序の典型パターン

### 通常のターン

```
assistant.turn_start  (turnId=N)
session.usage_info    (currentTokens, tokenLimit)
assistant.usage       (model, inputTokens, outputTokens, initiator="user"|"agent")
assistant.message     (content, toolRequests[])
tool.execution_start  × N個
tool.execution_complete × N個
assistant.turn_end    (turnId=N)
```

### subagent を含むターン

```
assistant.turn_start
session.usage_info
assistant.usage       (initiator="user"|"agent")
assistant.message     (toolRequests に task tool 含む)
tool.execution_start  (toolName="task")
subagent.started      (agentName, agentDisplayName)

  -- subagent 内のイベント（全て parentToolCallId 付き）--
  assistant.usage     (initiator="sub-agent")
  assistant.message   (parentToolCallId あり)
  tool.execution_start (parentToolCallId あり)
  tool.execution_complete (parentToolCallId あり)
  ...
  assistant.message   (parentToolCallId あり, content=最終結果)

subagent.completed    (agentName)
tool.execution_complete (task tool の完了)
assistant.turn_end
```

## メインエージェントと subagent のイベントを見分ける方法

**確実な方法: `data.parentToolCallId`**
- メインエージェント: `parentToolCallId` が存在しない
- subagent: `parentToolCallId` が存在し、`task` ツールの `toolCallId` と一致する

**補助的な方法: `initiator` フィールド（assistant.usage のみ）**
- `"user"` / `"agent"` → メインエージェント
- `"sub-agent"` → subagent

**使えない方法:**
- トップレベル `parentId` — 全データで 0 件。完全に未使用
- 時系列での `subagent.started` / `subagent.completed` の間 — 並列 subagent やイベント到着順序のずれで崩れる

## turnId とリセット

- `turnId` は文字列の連番 ("0", "1", "2", ...)
- `session.idle` イベントの後にリセットされて 0 に戻る
- つまり turnId は「`session.send()` から次の idle まで」の区間内でのみ連番
- subagent は `turn_start`/`turn_end` を発行しない

## copilotclaw_wait によるツール呼び出しループの維持

Copilot SDK の `session.send()` は1回の呼び出しで LLM のツール呼び出しループを開始する。LLM がツールを呼び続ける限りループは継続し、追加の `session.send()` は不要（= 追加のプレミアムリクエストは消費されない）。

`copilotclaw_wait` はこの仕組みを利用する:
- LLM が `copilotclaw_wait` を呼ぶと、ツール結果を返さずにユーザー入力が来るまでブロックする
- LLM から見るとツール実行中なので、ループは終了しない（`session.idle` が発火しない）
- ユーザー入力が来ると `copilotclaw_wait` がその内容をツール結果として返し、LLM はループ内で処理を継続する
- 1回の `session.send()` で複数のユーザー入力を処理できる

`session.idle` の発生は、LLM が `copilotclaw_wait` を呼ばずに停止したことを意味し、設計上の失敗（LLM の指示追従失敗）として扱う。

**実例:**
- c7b798ec: 9回の入力、turnId 0→29 連番、idle 0回、プレミアムリクエスト 1回
- b834dbd8: idle 7回、turnId リセット 6回、idle のたびにプレミアムリクエスト消費

**設計意図（raw-requirements より）:**
- `client.send()` は session の開始時以外は使わない
- session keepalive のための `session.send()` も不要にする — tool 内で keepalive を完結させる
- agent session はコストが高い（プレミアムリクエスト消費）。起動した session はできるだけ長く使い続ける
- idle = セッションの意図しない停止として扱う
- `copilotclaw_wait` を使わずにターンを終了すると、デッドロックになりセッションが停止する

## onPostToolUse Hook の実測結果

### hook input のフィールド

| フィールド | 存在 | 備考 |
|---|---|---|
| sessionId | Yes | 型定義にない。ランタイムでは含まれる |
| timestamp | Yes | |
| cwd | Yes | |
| toolName | Yes | |
| toolArgs | Yes | |
| toolResult | Yes | |
| parentToolCallId | **No** | |
| agentName | **No** | |

invocation: `{ sessionId }` のみ。

### subagent での hook 発火

**結論: `onPostToolUse` は subagent のツール実行では発火しない。**

debug.logLevel=debug で検証（セッション b627212c）:

hook 発火ログ:
```
postToolUse: tool=copilotclaw_wait
postToolUse: tool=report_intent
postToolUse: tool=task
postToolUse: tool=copilotclaw_send_message
```
全てメインエージェントのツール。

同セッションの subagent ツール実行（session event で確認済み）:
```
tool.execution_start  tool=report_intent  PARENT=call_WY0Bzab  ← subagent
tool.execution_start  tool=bash           PARENT=call_WY0Bzab  ← subagent
```
これらに対応する hook 発火ログはない。

### SDK 内部の hook メカニズム

SDK ソースコード（`@github/copilot-sdk` dist/cjs/client.js）の調査結果:

- CLI が JSON-RPC で `hooks.invoke` リクエストを SDK に送る
- SDK の `CopilotClient.handleHooksInvoke(params)` が `params.sessionId` でセッションを特定
- `session._handleHooksInvoke(hookType, input)` でハンドラを呼ぶ
- SDK 側では parent/subagent の区別はない — CLI から RPC が来れば無条件にハンドラを呼ぶ

**hook が subagent で発火しないのは CLI 側の判断。** CLI がメインエージェントのツール実行時のみ `hooks.invoke` RPC を発行する。

含意:
- SDK は hook を parent/subagent 区別なく処理する能力がある
- CLI が subagent のツールでは hook RPC を発行しない
- hook が subagent で発火しないのは SDK の制約ではなく CLI の挙動。将来 CLI が更新されれば subagent でも hook が発火する可能性がある
- copilotclaw のコードは現在この挙動に依存している（toolName ゲートを削除済み）。CLI の挙動が変わった場合、hook ハンドラが subagent のツールでも発火するようになるが、リマインドの頻度制御は `reminderState` で行っているため大きな問題にはならない

## その他の観測事実

- 並列 subagent を指示しても SDK は順次実行する（2つの task を並列呼び出ししたが、subagent.started/completed が重複せず順次処理された）
- `copilotclaw_wait` は何があってもエラーを返さない設計。エラーを返すとツール呼び出しループが異常終了し、物理 session が停止する（raw-requirements: receive-input-never-error.md）
- `assistant.message` の `content` はメインエージェントでは空文字列のことが多い（ツール呼び出しのみの場合）。subagent の最終メッセージには結果が入る
- `tool.execution_start` と `tool.execution_complete` は並列ツール呼び出しの場合、start が複数連続してから complete が返る
- `initiator` の `"agent"` は `copilotclaw_wait` 解除後のターン再開時に出現する

## 統計

| 指標 | c7b798ec | b834dbd8 | b627212c |
|---|---|---|---|
| イベント総数 | 300 | 527 | 38 |
| subagent 呼び出し数 | 8 | 5 | 1 |
| parentToolCallId 付きイベント | 64 | 158 | 8 |
| トップレベル parentId 付きイベント | 0 | 0 | 0 |
| session.idle | 0 | 7 | 0 |
| turnId リセット | 0 | 6 | 0 |

## 負荷テスト中のセッション死亡

セッション c7b798ec がハーネスエンジニアリング調査タスク中に死亡。

- コンテキスト 41,142 / 128,000 トークン (32.1%) で turnId 51 の LLM が最終応答をテキスト出力
- `copilotclaw_send_message` も `copilotclaw_wait` も呼ばずに停止
- `session.idle` 発火 → セッション死亡
- コンテキスト増大に伴い、システムプロンプトの「`copilotclaw_wait` を必ず呼べ」という指示が埋もれて無視される確率が上がると考えられる
- `onPostToolUse` hook の定期リマインドが設計されているが、コンテキスト増大に対して十分でなかった可能性

詳細: [dumps/session-death-under-load.md](dumps/session-death-under-load.md)

## 未解決の問題

### channel メッセージと session event の不整合

チャンネル 8be360d1 で、channel メッセージ（store.db）に記録されている agent 応答（13:50:43, 13:50:47）に対応する session event が session-events.db に存在しない。

- 両方とも同じ IPC stream 経由で送られる（`sendToGateway()` 関数を共有）
- gateway 側の `handleAgentMessage` で `channel_message` と `session_event` は同じ switch 文で処理される
- 片方だけ届いて片方が消える合理的な理由がコード上に見当たらない
- 考えられる可能性: IPC stream のバッファリングやパケット分割のタイミングでの欠落、gateway 再起動と agent のセッション処理の競合
- 再現手順は不明。継続調査が必要

### SYSTEM メッセージの連続発生

チャンネル 671c2d73 で `[SYSTEM] Agent session stopped unexpectedly` が大量に連続発生。

- 04:35 台: 7 回連続（約5秒間隔）。ユーザーメッセージは 1 件のみ
- 09:50 台: 6 回連続（約5秒間隔）。ユーザーメッセージは 1 件のみ
- 合計 37 回の SYSTEM メッセージが記録されている
- バックオフ実装あり（`RAPID_FAILURE_THRESHOLD_MS = 30_000`、`BACKOFF_DURATION_MS = 60_000`）だが、30秒以上動いたセッションの idle exit にはバックオフが適用されない
- `pending_notify` は gateway の user message POST 時にしか送られない（1回のみ）のに、何がセッションの再起動をトリガーしているか特定できていない
- raw-requirements の「エラー無限ループの抑制」「連続失敗時にバックオフを設ける」に違反
