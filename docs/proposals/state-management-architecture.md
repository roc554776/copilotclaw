# 提案: 系全体の状態管理アーキテクチャ再設計

**（全体未実現）**

本 proposal は copilotclaw の全 subsystem にまたがる状態管理の根本的な再設計を定義する。session lifecycle のみを対象とした局所的な改善ではなく、gateway 側・agent 側・IPC/cross-cutting のすべてを射程に含める。

既存の `docs/proposals/channel.md` の SessionController 設計（v0.64.0 で実現済み）は gateway 側の session lifecycle に scope を限定したものだった。本 proposal はその上位に位置し、全 subsystem を横断するアーキテクチャとして整理し直す。

---

## 背景と問題意識

### 観測されている症状

commit 履歴と実装調査から、以下の症状が観測されている。これらは表面的には異なるバグに見えるが、同じ根に由来する。

- **wait/idle race**: `copilotclaw_wait` で待機中のセッションが意図せず idle に遷移する。agent 側の keepalive（`packages/agent/src/tools/channel.ts` の `waitForPendingNotify` タイムアウトサイクル）と gateway 側の主たる idle 検知（`packages/gateway/src/daemon.ts:241-244` の `case "session.idle"` で `sessionController.onSessionIdle()` を呼ぶ経路）が独立に判断しており、どちらが「生きているか」の判断者なのか不明確。daemon.ts:311-324 は backgroundTasks がある場合に `agentManager.notifyAgent()` で補助的な通知を行う別経路であり、主たる idle 遷移の起点は 241-244 である。agent 側の `packages/agent/src/session-loop.ts` は keepalive を担わず、`BACKGROUND_TASKS_IDLE_TIMEOUT_MS`（30 分）の安全弁タイムアウトと真の idle 検知（`hasBackgroundTasks=false` の場合に resolve）を担っている
- **double-start race**: commit `fix double-start race` が示すとおり、`clientStartPromise ??= client.start()` でしか防げていない。根本的な状態機械が存在しない
- **channel status の不在**: `Channel { id, createdAt, archivedAt, model, draft }` に status フィールドがなく、channel の状態は session 経由で逆引きするしかない
- **idleSession ↔ onPhysicalSessionEnded race**: 物理セッション終了の通知と idle 遷移が競合する
- **`copilotSessionId` dead field**: `AbstractSession.copilotSessionId` が DB に存在するが production では書き込まれない。結果として end-turn-run 後の disconnect で `resumeSession` ではなく `createSession` が呼ばれ、記憶が毎回失われる
- **`generation` dead field**: `PhysicalSessionEntry.generation` が定義されているが参照箇所なし
- **`isReconciled()` dead code**: 定義されているが production で一度も呼ばれない
- **daemon.ts の observability 系 orchestrator 直接呼び出し**: `daemon.ts` が `session.usage_info` / `assistant.usage` / `session.model_change` / `subagent.started` / `subagent.completed` / `subagent.failed` の各 SDK イベント受信時に、SessionController を経由せず `orchestrator.updatePhysicalSessionTokens` / `orchestrator.accumulateUsageTokens` / `orchestrator.updatePhysicalSessionModel` / `orchestrator.addSubagentSession` / `orchestrator.updateSubagentStatus` を直接呼び出す箇所が 6 箇所存在する（lines 249, 261, 276, 279, 288, 291）。これらは session status を変更しないが、orchestrator が持つ state の一部（tokens, model, subagent 追跡）を SessionController の責務外で mutate しており、状態変更が単一の reducer を通らない構造になっている
- **send queue の ACK なし**: flush 後に ACK を待たずディスクをクリアする。flush 中のクラッシュでメッセージ消失
- **channelBackoff が ephemeral**: gateway 再起動でバックオフ状態が消失。stale 再試行ストームの可能性

### 共通の根本原因

**世界状態 (world state) とプロセス実行状態 (process state) の混在**

`PhysicalSessionEntry` の例:

```
world state:  sessionId, physicalSessionId, info.status, info.startedAt, resolvedModel, generation, reinjectCount
process state: copilotSession, abortController, sessionPromise   ← 同一 object に同居
```

**状態変更の分散**

`entry.info.status = ...` の直接 mutate が agent 側だけで複数箇所。gateway 側でも session status とは独立に、observability 系の state（tokens / model / subagent 追跡）が daemon.ts から orchestrator に直接 mutate される経路が 6 箇所存在し（`SessionController.transition()` は private のため session status 変更のみ保護されているが、それ以外の orchestrator 状態は保護されていない）、状態変更全体が単一の reducer を通らない構造になっている。

**入力イベントの非列挙**

系に入ってくる契機（user message 到着、物理セッション終了、keepalive timeout など）が有限の event 型として列挙されておらず、callback の中で気づいたら状態を書き換えるスタイルになっている。

**結果**: 状態モデル全体を網羅するテストが書けない。表面的な end-to-end テストしか存在しない。

---

## 設計原則

以下の 7 原則が本 proposal の全設計を支配する。

**原則: world state と process state の分離**

各 subsystem の world state（永続化可能で process 境界を越えて意味を持つ状態）と process state（AbortController・Promise・live SDK ref などの実行ハンドル）を別 object に分離する。world state には実行ハンドルを置かない。

**原則: 入力の有限列挙**

系に入ってくる入力を有限の event 型として列挙する。callback の中で暗黙的に状態を変更するパターンを廃止する。

**原則: 単一 reducer による状態遷移集約**

状態遷移は subsystem ごとに単一の純関数 reducer に集約する。

```
reduce(state: S, event: E) → { newState: S, commands: Command[] }
```

reducer は副作用を持たない。外部 I/O・タイマー・Promise の await は禁止。

**原則: command パターンによる副作用分離**

副作用は command として出力し、別の effect runtime が実行する。command の実行結果はまた event として系に戻る（feedback loop）。

**原則: subsystem 間の event バス通信**

subsystem 間は直接 field を触らず event でやりとりする。

**原則: `copilotclaw_wait` 状態の明示**

wait/idle race は「セッションが生きているか」の判断者を reducer 1 箇所に固定することで原理的に消える。`copilotclaw_wait` 呼び出し中は `waiting_on_wait_tool` のような明示状態を持たせ、reducer がその状態にいる間の idle 遷移を拒否する。

**原則: event bus インフラの明示的設計**

event 順序保証・重複検知などの event bus インフラを subsystem 通信設計の一部として明示する。

---

## 対象 subsystem 一覧

### Gateway 側

| subsystem | 現状の問題 |
|-----------|-----------|
| SessionOrchestrator | `session.status = ...` の直接 mutate が複数箇所（289, 336, 365 行目等）。world state と ephemeral state が混在 |
| SessionController | session status 変更は `transition()`（private）で保護されているが、daemon.ts が SessionController を介さず orchestrator の observability 系 state（tokens / model / subagent 追跡）を直接 mutate する経路が 6 箇所存在する。status 以外の orchestrator 状態が reducer 外で更新されている |
| Channel binding | Channel に status フィールドなし。session 経由の逆引きのみ |
| 保留メッセージキュー | drain パスが 2 系統（copilotclaw_wait tool と drain_pending IPC）。swallowed-message 検知との連携が不整合 |
| channelBackoff | ephemeral（DB 非永続化）。gateway 再起動でバックオフ状態消失 |
| SSE broadcaster | `clients = new Set<SseClient>()`、ephemeral、missed events の replay なし |
| SQLite 永続化層 | observability 系 mutation（token accumulation 等）が非永続化。`copilotSessionId` の dead field |
| HTTP in-flight | 追跡なし |

### Agent 側

| subsystem | 現状の問題 |
|-----------|-----------|
| PhysicalSessionEntry | world state と process state が同一 object に混在。直接 mutate が複数箇所 |
| CopilotClient singleton | `client` と `clientStartPromise` でライフサイクル管理。double-start は解消済みだが状態機械不在 |
| reinject 状態 | `reinjectCount` の直接 inc。`generation` は dead field |
| AbortController 群 | `sessionPromise` の reinject 時 overwrite。abort 漏れの可能性 |
| in-flight tool call | agent 側に追跡なし。gateway 側 `physicalSession.currentState` で追跡しているが不完全 |
| resolvedModel | `runSession()` での取得と `session.setModel()` での設定が分散 |

### IPC / cross-cutting

| subsystem | 現状の問題 |
|-----------|-----------|
| pending RPC | `pendingRequests = Map<string, {resolve, reject, timer}>`。disconnect 時に全 reject。15s timeout |
| event ordering | Unix socket FIFO 依存。async tool_call 応答の順序保証なし |
| reconnection | gateway 側 3 秒遅延再接続。agent 側は旧 stream を destroy。reconnect 中の event 消失 |
| send queue | ACK プロトコルなし。flush 中クラッシュでメッセージ消失 |
| config push | 接続時 1 度のみ。動的更新機構なし |
| copilotSessionId 整合 | gateway が `undefined` を送り続けるため、agent が常に `createSession` を呼ぶ。resume パスが機能しない |

---

## subsystem ごとの設計

### Gateway: AbstractSession subsystem

**現状**

`AbstractSessionStatus = "new" | "starting" | "waiting" | "notified" | "processing" | "idle" | "suspended"` の 7 状態だが、状態遷移が分散している。`session.status = ...` の直接 mutate が orchestrator 内に 3 箇所以上。また daemon.ts が SessionController を介さず orchestrator の observability 系 state（tokens / model / subagent 追跡）を直接 mutate する経路が 6 箇所存在し（`SessionController.transition()` は private のため session status は保護されているが、それ以外の orchestrator 状態は保護されていない）、全状態変更が単一の reducer を通らない構造になっている。

**新設計: world state 型**

```typescript
// 累積トークン使用量。observability 系（assistant.usage / session.usage_info SDK イベント由来）
interface TokenSummary {
  inputTokens: number
  outputTokens: number
  currentTokens: number   // コンテキスト内現在使用量（session.usage_info 由来）
  tokenLimit: number      // コンテキスト上限（session.usage_info 由来）
  cacheReadTokens?: number   // optional: 現状の accumulateUsageTokens 実装には存在しない。SDK の assistant.usage event がキャッシュトークン情報を提供するため、将来的な蓄積に備えて optional で定義する
  cacheWriteTokens?: number  // optional: 同上
  latestQuotaSnapshots?: Record<string, unknown>
}

// サブエージェントセッションの追跡情報（subagent.started / subagent.completed / subagent.failed SDK イベント由来）
type SubagentStatus = "running" | "completed" | "failed"

interface SubagentInfo {
  toolCallId: string
  agentName: string
  agentDisplayName: string
  status: SubagentStatus
  startedAt: string        // ISO 8601
  parentSessionId: string  // 親セッション ID（新規追加フィールド。現状実装の SubagentInfo には存在しない。現状は toolCallId から親 session を逆引きしているが、本設計では直接参照フィールドとして明示する）
}

type AbstractSessionStatus =
  | "new"
  | "starting"
  | "waiting"
  | "notified"
  | "processing"
  | "idle"
  | "suspended"

interface AbstractSessionState {
  sessionId: string
  channelId: string
  status: AbstractSessionStatus
  waitingOnWaitTool: boolean  // copilotclaw_wait 呼び出し中は true。IdleDetected を拒否するために使用
  physicalSessionId: string | undefined  // idle 状態でも保持される（v0.58.0 の physical session 常時保持設計を継承。end-turn-run disconnect 後の idle 遷移では physicalSessionId をクリアせず保持したまま idle に遷移する）
  hasHadPhysicalSession: boolean  // PhysicalSessionStarted event で true に設定。初回と強制停止後の区別に使用
  physicalSessionStartedAt: number | undefined
  resolvedModel: string | undefined
  reinjectCount: number
  accumulatedTokens: TokenSummary
  // observability 系（現状は orchestrator が直接 mutate。reducer に統合）
  subagents: SubagentInfo[]
  createdAt: number
  updatedAt: number
}
// AbortController, Promise, live SDK ref などは含まない
```

`waitingOnWaitTool` は `status` とは独立したサブフラグとして設計する。`status === "waiting"` かつ `waitingOnWaitTool === true` が wait/idle race 防止の判断条件になる。`WaitToolCalled` event で `true` に設定し、`WaitToolCompleted` event で `false` に戻す。

`PhysicalSession` 側の `status: "waiting_on_wait_tool"` とは設計上の対称性があるが役割が異なる。`PhysicalSession` では status enum の一値として扱い、`AbstractSession` ではフラグとして扱うことで、`AbstractSessionStatus` の 7 状態定義を変更せずに wait/idle race を防止できる。将来的には両者を統一する余地があるが、本 proposal では両方を明示して共存させる。

**EndReason 型定義**

物理セッション終了理由を表す型。agent 側（`PhysicalSessionManager.sendPhysicalSessionEnded`）が送信し、gateway 側（`SessionController.onPhysicalSessionEnded`）が受け取る。

```typescript
// 現行実装（session-controller.ts の onPhysicalSessionEnded）では reason !== "idle" を
// エラー系として扱い、バックオフを適用する。本設計ではこれを以下の列挙に精緻化する。
type EndReason =
  | "idle"       // セッションループが正常に完了（runSession が resolve）
  | "error"      // セッションループが例外で終了（runSession が reject）
  | "aborted"    // AbortController.abort() による明示的中断（stopPhysicalSession / disconnectPhysicalSession 経由）
```

EndReason ごとの `PhysicalSessionEnded` reducer 分岐:

- `reason === "idle"` → `idle` 遷移（正常終了。session loop が自発的に完了した場合）
- `reason === "error"` → `suspended` 遷移（+ `CancelKeepaliveTimeout` 発行、effect runtime がバックオフを記録）
- `reason === "aborted"` → `suspended` 遷移（明示的中断。ユーザー要求または gateway 指示による停止）

`reason === "error"` と `reason === "aborted"` はどちらも `suspended` に遷移するが、effect runtime の挙動が異なる。`error` の場合は effect runtime がバックオフを適用し、`sessionController.onPhysicalSessionEnded` のシステムメッセージ送信（「Agent session stopped unexpectedly」）を行う。`aborted` の場合はバックオフを適用せず、システムメッセージも送信しない。現行実装（`session-controller.ts:202-208`）の `reason !== "idle" && elapsedMs < 30_000` でバックオフを適用する条件は、`error` のみに適用する形に精緻化される。

**想定 event 型**

```typescript
// 設計注: ToolExecutionCompleted は AbstractSessionEvent に含まれない（非対称設計）。
// gateway 側の abstract session は tool start を notified → processing の遷移契機として使うだけで、
// tool completion は IdleDetected（ツール完了後の idle 検知）または次の ToolExecutionStarted で暗黙に終わる。
// よって gateway の abstract session reducer は ToolExecutionCompleted を必要としない。
// PhysicalSession subsystem（agent 側）は ToolExecutionCompleted を持つ（currentToolName の更新に使用）。
//
// 命名注: StopRequested は AbstractSessionEvent・PhysicalSessionEvent・CopilotClientEvent の 3 箇所に同名で存在する。
// TypeScript 型システム上は各 subsystem の type alias（AbstractSessionEvent, PhysicalSessionEvent, CopilotClientEvent）で
// 区別されるため衝突しない。冗長な rename（SessionStopRequested 等）は可読性を損なうため採用しない。
type AbstractSessionEvent =
  | { type: "MessageDelivered"; channelId: string; messageId: string; sender: MessageSender }
  | { type: "PhysicalSessionStarted"; physicalSessionId: string; model: string }
  | { type: "PhysicalSessionEnded"; physicalSessionId: string; reason: EndReason }
  | { type: "WaitToolCalled"; physicalSessionId: string }
  | { type: "WaitToolCompleted"; physicalSessionId: string }
  | { type: "ToolExecutionStarted"; toolName: string }
  | { type: "IdleDetected"; hasBackgroundTasks: boolean }
  | { type: "MessagesDrained"; physicalSessionId: string; messageIds: string[] }
  | { type: "ReviveRequested" }  // 明示的な revive 要求（suspended セッションを starting へ）
  | { type: "StopRequested" }   // 明示的な停止要求（waiting / notified / processing / idle → suspended）
  | { type: "PhysicalSessionAliveConfirmed" }  // reconcile coordinator が「自セッションの物理セッションは生存」と判定
  | { type: "PhysicalSessionAliveRefuted" }    // reconcile coordinator が「自セッションの物理セッションは消滅」と判定
  | { type: "MaxAgeExceeded" }
  | { type: "KeepaliveTimedOut" }
  // observability 系（daemon.ts が直接 mutate していた箇所を event 化）
  | { type: "UsageUpdated"; inputTokens: number; outputTokens: number; quotaSnapshots?: Record<string, unknown> }
  | { type: "TokensAccumulated"; currentTokens: number; tokenLimit: number }
  | { type: "ModelResolved"; model: string }  // 物理セッションが実際に使用するモデルの確定通知（session.model_change SDK イベント由来）
  | { type: "SubagentStarted"; toolCallId: string; agentName: string; agentDisplayName: string; startedAt: string }
  | { type: "SubagentStatusChanged"; toolCallId: string; status: "completed" | "failed" }
```

**reducer の責務と状態遷移**

```
new       → starting       : MessageDelivered（pending あり）
idle      → starting       : MessageDelivered（pending あり）
starting  → waiting        : PhysicalSessionStarted
waiting   → notified       : MessageDelivered（pending あり）
waiting   → waiting        : WaitToolCalled（waitingOnWaitTool フラグを on）
notified  → processing     : ToolExecutionStarted
processing → waiting       : WaitToolCalled（waitingOnWaitTool フラグを on）

waiting[waiting_on_wait_tool=true] → idle 遷移を拒否する
  — IdleDetected が来ても idle に遷移しない。WaitToolCompleted を受けるまで waiting を維持

ANY       → idle           : IdleDetected（hasBackgroundTasks=false かつ waiting_on_wait_tool=false）
waiting   → suspended      : StopRequested
notified  → suspended      : StopRequested
processing → suspended     : StopRequested
idle      → suspended      : StopRequested
new, starting, suspended では StopRequested は noop
PhysicalSessionEnded → idle / suspended（EndReason に応じた分岐は「EndReason 型定義」節を参照:
                         reason=idle → idle, reason=error|aborted → suspended）
MaxAgeExceeded → suspended : 任意の active 状態から
PhysicalSessionAliveRefuted → suspended : reconcile で消滅判定
waiting   → suspended      : KeepaliveTimedOut（intentional constraint: keepalive 監視は waiting 状態でのみアクティブ。
                               notified / processing / idle では KeepaliveTimedOut は発火しない設計であり、
                               他の状態での noop ハンドリングは不要。設計上の意図的制約として明記）
suspended → starting       : ReviveRequested | MessageDelivered（suspended セッションへの明示的 revive）
```

`ReviveRequested` と `StopRequested` の役割を明確に分離する。`ReviveRequested` は suspended セッションを明示的に再起動する要求であり、`StopRequested` は動作中のセッションを停止する要求である。`StopRequested` が `suspended` 状態に届いた場合は noop（停止を要求しても既に停止済みのため、以前の「archive 時は除く StopRequested で suspended → starting」という例外は削除）。

observability 系の event は `status` 遷移を起こさず、`AbstractSessionState` の対応フィールドのみを更新する。

- `UsageUpdated`: `accumulatedTokens.inputTokens` / `outputTokens` / `latestQuotaSnapshots` を加算・更新する。`status` 遷移なし
- `TokensAccumulated`: `accumulatedTokens.currentTokens` / `tokenLimit` を上書きする（SDK の `session.usage_info` イベント由来の現在コンテキスト使用量）。`status` 遷移なし
- `ModelResolved`: `resolvedModel` を更新する（SDK の `session.model_change` イベント由来）。`status` 遷移なし
- `SubagentStarted`: `subagents` 配列に新しい `SubagentInfo`（`status: "running"`）を追加する。`status` 遷移なし
- `SubagentStatusChanged`: `subagents` 配列の対象 `toolCallId` を持つ `SubagentInfo` の `status` を `"completed"` または `"failed"` に更新する。`status` 遷移なし

lifecycle 系の event（`KeepaliveTimedOut`, `MessagesDrained`, `PhysicalSessionAliveConfirmed`, `PhysicalSessionAliveRefuted`）の reducer 責務:

- `KeepaliveTimedOut`: keepalive タイムアウトが発生したことを受けて、gateway は session を `suspended` に遷移させ `StopPhysicalSession` command を発行する。`waitingOnWaitTool` フラグは `false` にリセットする。**intentional constraint**: keepalive 監視は waiting 状態でのみアクティブになる設計である。agent 側の `copilotclaw_wait` ツールが `keepaliveTimeoutMs` タイマーを waiting 状態への遷移時にのみ開始する（`ToolExecutionStarted` / `ToolExecutionCompleted` サイクル中や processing / notified 状態では keepalive タイマーを保持しない）。このため、notified / processing / idle 状態では `KeepaliveTimedOut` event が発火することはなく、reducer はこれらの状態における `KeepaliveTimedOut` のハンドリングを必要としない
- `MessagesDrained`: gateway の PendingQueue subsystem が drain を完了したことを受けて、`AbstractSessionState.updatedAt` を更新する（drain 完了のタイムスタンプとして機能。drain 対象 messageId の管理は PendingQueue subsystem が担うため、AbstractSession reducer では noop 相当）。PendingQueue subsystem の `DrainCompleted` event が AbstractSession reducer の `MessagesDrained` event に変換されて伝播する
- `PhysicalSessionAliveConfirmed`: reconcile coordinator が「このセッションの物理セッションは生存している」と判定した結果。reducer は noop（現在の status を維持）。`isReconciled()` dead code の責務をこの event の sequence で明示的に担う
- `PhysicalSessionAliveRefuted`: reconcile coordinator が「このセッションの物理セッションは消滅している」と判定した結果。reducer はこのセッションを `suspended` に遷移させる

**reconcile coordinator の設計**

各 AbstractSession reducer は自分のスコープのみを扱い、他セッションの情報を持たない。reconcile の全体調整は effect runtime 層の reconcile coordinator が担う。

coordinator は `runningPhysicalIds`（gateway 再起動時に agent から取得した生存中の物理 ID リスト）を受け取り、全 AbstractSession を走査して:
- 自セッションの `physicalSessionId` が `runningPhysicalIds` に含まれる → `PhysicalSessionAliveConfirmed` を当該 AbstractSession reducer に送る
- 自セッションの `physicalSessionId` が `runningPhysicalIds` に含まれない → `PhysicalSessionAliveRefuted` を当該 AbstractSession reducer に送る

`runningPhysicalIds` の取得プロトコルは IPC event として定義する（`GatewayToAgentEvent.RequestRunningSessions` / `AgentToGatewayEvent.RunningSessionsReport`）。gateway 起動時に coordinator が `RequestRunningSessions` を送信し、`RunningSessionsReport` を受信して上記の走査を実行する。詳細は「gateway-agent process 境界を跨ぐ event」節の「reconcile coordinator のプロトコル」を参照。

各 AbstractSession reducer は `PhysicalSessionAliveConfirmed` / `PhysicalSessionAliveRefuted` のいずれか一方のみを受信し、自セッションの state のみを更新する。`AbstractSessionState` に `reconcilingPhysicalIds` フィールドは不要であり、定義しない。

**想定 command 型**

```typescript
type AbstractSessionCommand =
  | { type: "StartPhysicalSession"; sessionId: string; model: string; physicalSessionId: string | undefined }
  // physicalSessionId は reducer が AbstractSessionState.physicalSessionId から取り出して付与する。
  // undefined の場合は agent が createSession、非 undefined の場合は resumeSession を呼ぶ（copilotSessionId dead field の型レベル解消）
  | { type: "StopPhysicalSession"; sessionId: string }
  | { type: "DisconnectPhysicalSession"; sessionId: string }
  | { type: "NotifyAgent"; sessionId: string }
  | { type: "PersistSession"; state: AbstractSessionState }
  | { type: "BroadcastSSE"; event: SseEvent }
  | { type: "DrainPendingMessages"; sessionId: string }
  | { type: "ScheduleKeepaliveTimeout"; sessionId: string; delayMs: number }
  | { type: "CancelKeepaliveTimeout"; sessionId: string }
```

effect runtime が command を受けて実行し、結果を再び event として reducer に戻す。

### Gateway: Channel subsystem

**現状**

`Channel { id, createdAt, archivedAt, model, draft }` — status フィールドなし。channel の状態は常に session 経由の逆引きのみ。

**新設計: world state 型**

```typescript
interface ChannelState {
  channelId: string
  archivedAt: number | undefined
  model: string | undefined
  draft: string | undefined
  backoff: BackoffState | undefined  // 現状は ephemeral。永続化が必要
}

interface BackoffState {
  failureCount: number
  nextRetryAt: number
  lastFailureReason: string
}
```

**想定 event 型**

```typescript
type ChannelEvent =
  | { type: "MessagePosted"; sender: MessageSender; content: string }
  | { type: "Archived" }
  | { type: "Unarchived" }
  | { type: "DefaultModelSet"; model: string | undefined }  // channel のデフォルトモデル変更（利用者によるモデル選択）
  | { type: "DraftUpdated"; draft: string | undefined }     // 利用者の入力途中テキストの更新（undefined はクリア）
  | { type: "SessionStartFailed"; reason: string }
  | { type: "BackoffReset" }
```

**想定 command 型**

```typescript
type ChannelCommand =
  | { type: "PersistBackoff"; channelId: string; backoff: BackoffState }
  | { type: "ClearBackoff"; channelId: string }
  | { type: "ScheduleRetry"; channelId: string; retryAt: number }
  | { type: "PersistDraft"; channelId: string; draft: string | undefined }
```

**reducer の責務**

- archived channel への `MessagePosted` は command を発行しない（cron 含む）
- `SessionStartFailed` で backoff state を更新し、`nextRetryAt` を計算して命令型ループに依存しない
- channel の backoff 状態を永続化することで gateway 再起動後も継続
- `DraftUpdated` で `ChannelState.draft` を更新し、`PersistDraft` command を発行する。`MessagePosted` 受信後は draft を `undefined` にリセットして `PersistDraft` command を発行する（送信完了後のクリア）。これは `DraftUpdated` event を経由しない意図的なショートカットである。`MessagePosted` 自体が「draft クリア」の意図を包含しているため、`DraftCleared` や `DraftUpdated(undefined)` を別途発行する必要はない。reducer は `MessagePosted` の reducer 責務内で直接 draft を `undefined` に更新する

### Gateway: PendingQueue subsystem

**現状**

`pending_queue` SQLite テーブル。drain パスが 2 系統（copilotclaw_wait tool_call と drain_pending IPC）。swallowed-message 検知との連携が不整合。

**新設計: world state 型**

```typescript
interface PendingQueueState {
  channelId: string
  messages: PendingMessage[]
  drainInProgress: boolean
  lastDrainedAt: number | undefined
}
```

**想定 event 型**

```typescript
// メッセージが queue から除去される理由
type FlushReason = "session-ended" | "force-flush" | "channel-archived"

type PendingQueueEvent =
  | { type: "MessageEnqueued"; message: PendingMessage }
  | { type: "DrainStarted"; requestId: string }
  | { type: "DrainCompleted"; requestId: string; drainedIds: string[] }
  | { type: "DrainAcknowledged"; requestId: string }  // ACK プロトコル
  | { type: "MessageFlushed"; messageId: string; reason: FlushReason }
```

**想定 command 型**

```typescript
type PendingQueueCommand =
  | { type: "DeliverMessages"; channelId: string; messages: PendingMessage[] }
  | { type: "PersistQueue"; channelId: string; messages: PendingMessage[] }
  | { type: "SendAck"; requestId: string }
```

**reducer の責務**

- drain の 2 系統を `DrainStarted` / `DrainCompleted` / `DrainAcknowledged` の sequence に統一
- `DrainAcknowledged` を受けるまで queue エントリを保持（ACK プロトコル実現）
- `drainInProgress = true` の間は重複 drain を拒否

### Gateway: SSE Broadcaster subsystem

**現状**

`clients = new Set<SseClient>()`、ephemeral、missed events の replay なし。

エンドポイントは `/api/events?channel=...` の 1 本のみ。channel 別フィルタは `SseBroadcaster.broadcast(event)` が `channelId` で内部フィルタする形で実現されている。`broadcastAll()` は呼び出し箇所なし（dead code）。global SSE エンドポイントは存在しない。

実際に SSE 送信されている event 型:
- `new_message` — channel-scoped
- `session_status_change` — channel-scoped（v0.68.1 で frontend 受信・処理を実装済み。`event.data.status` で `setSessionStatus` を更新する）

`status_update` event は frontend が handler を持つが、backend に送信側が存在しない（dead sink）。

**新設計: エンドポイント分離**

SSE エンドポイントを 2 本に分離する（未実現）:

- `/api/channels/{channelId}/events` — channel-scoped SSE（現行の `/api/events?channel=...` を置き換え）
- `/api/global-events` — global SSE（新規）

**新設計: SseEvent 型定義**

SSE で配信するイベントの全 union を定義する。channel-scoped と global でスコープが異なる。

```typescript
// channel-scoped イベント（/api/channels/{channelId}/events で配信）
type ChannelSseEvent =
  | { type: "new_message"; channelId: string; message: Message }
  | { type: "channel_status_change"; channelId: string; status: DerivedChannelStatus }
  | { type: "channel_timeline_event"; channelId: string; entry: TimelineEntry }

// global イベント（/api/global-events で配信）
type GlobalSseEvent =
  | { type: "gateway_status_change"; version: string; running: boolean }
  | { type: "agent_status_change"; version: string | undefined; running: boolean }
  | { type: "agent_compatibility_change"; compatibility: "compatible" | "incompatible" | "unavailable" }
  | { type: "channel_list_change" }
  | { type: "config_change" }
  | { type: "system_status_change" }
  // ポーリング置換のために追加される新規 event 型
  | { type: "log_appended"; entries: LogEntry[] }                 // GET /api/logs 3s ポーリングの置換
  | { type: "quota_update"; quota: QuotaInfo }                     // GET /api/quota 5s ポーリングの置換
  | { type: "models_update"; models: ModelInfo[] }                 // GET /api/models 5s ポーリングの置換
  | { type: "token_usage_update"; summary: TokenUsageSummary }     // GET /api/token-usage ポーリングの置換

// 全 SSE イベントの union
type SseEvent = ChannelSseEvent | GlobalSseEvent
```

`channel_timeline_event` の `entry` フィールドは「UI 設計方針」節に定義した `TimelineEntry` 型に準拠する。turn run 開始・停止・subagent ライフサイクル等の非メッセージイベントを包含する。

**新設計: world state 型（スコープ分離）**

`ChannelScopedSseState` は「全チャンネル分の Map」として保持する。各チャンネルの replay buffer を独立管理する。

```typescript
// 1 チャンネル分の state
interface ChannelScopedSseStatePerChannel {
  lastEventId: number
  recentEvents: ChannelSseEvent[]  // channel 別 replay buffer（上限 N 件）
}

// 全チャンネル分を保持するトップレベル state
interface ChannelScopedSseState {
  channels: Record<string, ChannelScopedSseStatePerChannel>  // key: channelId
}

interface GlobalSseState {
  lastEventId: number
  recentEvents: GlobalSseEvent[]  // global replay buffer（上限 N 件）
}
```

**event 型の分類**

channel-scoped event（`/api/channels/{channelId}/events` で配信）:
- `new_message` — チャンネルへのメッセージ到着
- `channel_status_change` — DerivedChannelStatus の変化
- `channel_timeline_event` — turn run 開始・停止、subagent ライフサイクル等の非メッセージイベント（payload は `TimelineEntry`）

global event（`/api/global-events` で配信）:
- `gateway_status_change` — gateway バージョン・起動状態の変化
- `agent_status_change` — agent バージョン・起動状態の変化
- `agent_compatibility_change` — compatibility の変化
- `channel_list_change` — チャンネルの追加・アーカイブ・変更
- `config_change` — config 設定の変化
- `system_status_change` — system 全体のステータス変化

**想定 event 型**

`SseBroadcasterEvent` の `EventPublished` はスコープ別に分割し、reducer がスコープ別の state を型レベルで安全に更新できるようにする。

```typescript
type SseBroadcasterEvent =
  | { type: "ClientConnected"; clientId: string; scope: "channel" | "global"; channelId?: string; lastEventId: number | undefined }
  | { type: "ClientDisconnected"; clientId: string }
  | { type: "ChannelEventPublished"; channelId: string; event: ChannelSseEvent }
  | { type: "GlobalEventPublished"; event: GlobalSseEvent }
```

**想定 command 型**

```typescript
type SseBroadcasterCommand =
  | { type: "SendReplayEvents"; clientId: string; events: SseEvent[] }
  | { type: "BroadcastToChannel"; channelId: string; event: ChannelSseEvent }
  | { type: "BroadcastGlobal"; event: GlobalSseEvent }
  | { type: "DisconnectClient"; clientId: string }
```

`BroadcastToAll`（旧設計）は dead code に対応するものだったため削除し、`BroadcastToChannel` と `BroadcastGlobal` に置き換える。

**reducer の責務**

- `ClientConnected` 時に scope（channel / global）と `lastEventId` を参照して missed events を replay
- `ChannelEventPublished` 時に `channels[channelId].recentEvents` に追記し、上限超過時に古いものを削除
- `GlobalEventPublished` 時に `GlobalSseState.recentEvents` に追記し、上限超過時に古いものを削除
- channel-scoped と global のそれぞれで replay buffer を独立管理する
- `session_status_change` は v0.68.1 で frontend 受信・処理を実装済み。新設計では `channel_status_change` として再定義する（エンドポイント分離の際に移行する）
- `status_update`（frontend handler はあるが backend 送信側なし）は廃止し、`gateway_status_change` / `agent_status_change` 等の global event に置き換える

process state（実際の SSE ソケット）は effect runtime が管理し、world state には含めない。

**frontend 設計（未実現）**

- `DashboardPage` は 2 本の `EventSource` を管理する（アクティブチャンネル用 channel-scoped + global）
- グローバル情報を表示するページは global `EventSource` のみ使用する
- ポーリングで実装されている gateway/agent status・ログ・session event 等の定期取得は SSE 受信に置き換えた後に削除する

**ポーリング置換対象（網羅リスト）**

以下は現時点で frontend が定期取得に使用しているポーリングと、それぞれの置換先 SSE スコープの設計判断である。

| ページ | ポーリング対象 API | 間隔 | 置換先 SSE | 置換方針 |
|---|---|---|---|---|
| `DashboardPage` | `GET /api/status` | 5s | global SSE | `gateway_status_change` / `agent_status_change` / `agent_compatibility_change` + `channel_status_change` の受信で置き換える。`system_status_change` event も gateway/agent 状態変化時に送信する |
| `DashboardPage` | `GET /api/logs` | 3s（Logs パネル表示中のみ） | global SSE | 新規 global event `log_appended` を追加し、LogBuffer へのアペンド時に broadcast する。frontend は `log_appended` を受信して Logs パネルをリアルタイム更新する |
| `StatusPage` | `GET /api/status` | 5s | global SSE | `DashboardPage` と同一の global SSE を subscribe し、`gateway_status_change` / `agent_status_change` / `agent_compatibility_change` で更新する |
| `StatusPage` | `GET /api/quota` | 5s | global SSE | 新規 global event `quota_update` を追加し、クォータ情報が更新された時点で broadcast する。`system_status_change` に含めるか独立 event にするかは実装時に決定する |
| `StatusPage` | `GET /api/models` | 5s | global SSE | 新規 global event `models_update` を追加する。モデル一覧は変化頻度が低いため、初回接続時の `SendReplayEvents` で最新値を受け取り、変化時のみ更新 event を受信する設計が合理的 |
| `StatusPage` | `GET /api/token-usage` (5h window) | 5s | global SSE | 新規 global event `token_usage_update` を追加し、トークン消費が記録されるたびに broadcast する。`TokenUsagePage` の自動更新（1 分ポーリング）も同 event で置き換える |
| `StatusPage` | 複数期間の `GET /api/token-usage` | 60s | global SSE | 同上。`token_usage_update` を受信した frontend が最新データを pull するか、event payload にサマリーを含める形で対応する（実装時に決定） |
| `SessionEventsPage` | `GET /api/sessions/{sessionId}/events` | 2s | channel-scoped SSE または session-scoped SSE | 専用 session-scoped SSE エンドポイントを追加するか、既存の channel-scoped SSE（`/api/channels/{channelId}/events`）を拡張して session event の差分を `channel_timeline_event` として配信する設計を採用する（詳細は下記注を参照） |

各ポーリング置換に対応する新規 global event（`log_appended` / `quota_update` / `models_update` / `token_usage_update`）の型定義は「新設計: SseEvent 型定義」節の `GlobalSseEvent` を参照。

**`SessionEventsPage` の置換方針注記**

`SessionEventsPage` は特定 sessionId の session event stream を 2s ポーリングで取得している。置換候補は 2 つある。

- **session-scoped SSE を新規追加する**（`/api/sessions/{sessionId}/events/stream`）: session に特化した専用エンドポイントとして追加する。SSE Broadcaster subsystem にセッションスコープのレイヤーを追加する必要がある
- **channel-scoped SSE を拡張する**: channel に紐づく physical session の event を `channel_timeline_event` の一部として channel-scoped SSE で配信する。session event の raw dump（`SessionEventsPage` の現在の表示内容）は channel-scoped の概念から外れるため、この場合は SessionEventsPage は独立した SSE を持つことになる

設計判断: channel-scoped SSE の `channel_timeline_event` で turn run 開始・停止・subagent ライフサイクルを配信する設計（上記「event 型の分類」節参照）は DashboardPage のタイムライン UI が対象であり、`SessionEventsPage` の raw session event stream とは用途が異なる。実装フェーズで session-scoped SSE の追加を優先し、raw event stream は session-scoped SSE で配信する方針を暫定とする。

### Agent: PhysicalSession subsystem

**現状**

`PhysicalSessionEntry` に world state と process state が混在。直接 mutate が複数箇所。`generation` は dead field。

**新設計: world state 型**

```typescript
type PhysicalSessionStatus =
  | "starting"
  | "running"
  | "waiting_on_wait_tool"
  | "reinject"
  | "ending"
  | "ended"

interface PhysicalSessionWorldState {
  sessionId: string           // 抽象セッション ID
  physicalSessionId: string | undefined
  status: PhysicalSessionStatus
  startedAt: number | undefined
  resolvedModel: string | undefined
  reinjectCount: number
  currentToolName: string | undefined  // in-flight tool call の追跡。ToolExecutionStarted で設定、ToolExecutionCompleted で undefined にリセット
}

// process state は別 object に分離
interface PhysicalSessionProcessState {
  copilotSession: CopilotSession | undefined
  abortController: AbortController | undefined
  sessionPromise: Promise<void> | undefined
}
```

**想定 event 型**

```typescript
// 命名注: StopRequested は AbstractSessionEvent・PhysicalSessionEvent・CopilotClientEvent の 3 箇所に同名で存在する。
// TypeScript 型システム上は各 subsystem の type alias で区別されるため衝突しない。
type PhysicalSessionEvent =
  | { type: "StartRequested"; sessionId: string; model: string }
  | { type: "ClientStarted" }
  | { type: "SessionCreated"; physicalSessionId: string }
  | { type: "WaitToolCalled" }
  | { type: "WaitToolReturned"; messages: DrainedMessage[] }
  | { type: "ToolExecutionStarted"; toolName: string }
  | { type: "ToolExecutionCompleted"; toolName: string }
  | { type: "IdleDetected"; hasBackgroundTasks: boolean }
  | { type: "ReinjectDecided" }
  | { type: "StopRequested" }
  | { type: "DisconnectRequested" }
  | { type: "SessionEnded"; reason: EndReason }
  | { type: "ErrorOccurred"; error: Error }
```

**想定 command 型**

```typescript
type PhysicalSessionCommand =
  | { type: "CreateSession"; sessionId: string; model: string }
  | { type: "ResumeSession"; sessionId: string; physicalSessionId: string; model: string }
  | { type: "SetModel"; sessionId: string; model: string }
  | { type: "SendMessage"; sessionId: string; messages: DrainedMessage[] }
  | { type: "AbortSession"; sessionId: string }
  | { type: "NotifyGatewayStarted"; sessionId: string; physicalSessionId: string }
  | { type: "NotifyGatewayEnded"; sessionId: string; physicalSessionId: string; reason: EndReason }
```

**reducer の責務**

- `IdleDetected` が来た時、`status === "waiting_on_wait_tool"` であれば idle 遷移を拒否
- `ReinjectDecided` で `reinjectCount` をインクリメント。`maxReinject` 超過時は `StopRequested` を command として出力
- `WaitToolCalled` で status を `waiting_on_wait_tool` に遷移

### Agent: CopilotClient singleton subsystem

**現状**

`client: CopilotClient | undefined` と `clientStartPromise: Promise<void> | undefined` でライフサイクルを管理。double-start race は `clientStartPromise ??=` で防止済みだが、状態機械不在。

**新設計: world state 型**

```typescript
type CopilotClientStatus = "uninitialized" | "starting" | "running" | "stopping" | "stopped"

interface CopilotClientState {
  status: CopilotClientStatus
}

// process state は別 object
interface CopilotClientProcessState {
  client: CopilotClient | undefined
  startPromise: Promise<void> | undefined
}
```

**想定 event 型**

```typescript
// 命名注: StopRequested は AbstractSessionEvent・PhysicalSessionEvent・CopilotClientEvent の 3 箇所に同名で存在する。
// TypeScript 型システム上は各 subsystem の type alias で区別されるため衝突しない。
type CopilotClientEvent =
  | { type: "StartRequested" }
  | { type: "StartCompleted" }
  | { type: "StopRequested" }
  | { type: "StopCompleted" }
  | { type: "ErrorOccurred"; error: Error }
```

**想定 command 型**

```typescript
type CopilotClientCommand =
  | { type: "StartClient" }
  | { type: "StopClient" }
```

**reducer の責務**

- `StartRequested` を `starting` 以外の状態でのみ受け付ける（double-start 排除）
- `status === "running"` でのみ session 作成 command を発行可能

### IPC / cross-cutting: SendQueue subsystem

**現状**

`send-queue.jsonl` にバッファリング。ACK プロトコルなし。flush 中クラッシュでメッセージ消失。

**新設計: world state 型**

```typescript
interface SendQueueState {
  messages: QueuedMessage[]
  flushInProgress: boolean
  pendingAckIds: string[]  // Set ではなく配列で保持（JSON 直列化可能。world state は永続化可能の原則に準拠）
}
```

**想定 event 型**

```typescript
type SendQueueEvent =
  | { type: "MessageEnqueued"; message: QueuedMessage }
  | { type: "FlushStarted"; batchIds: string[] }
  | { type: "MessageAcknowledged"; messageId: string }
  | { type: "FlushCompleted" }
  | { type: "ConnectionLost" }
  | { type: "ConnectionRestored" }
```

**想定 command 型**

```typescript
type SendQueueCommand =
  | { type: "FlushBatch"; messages: QueuedMessage[] }
  | { type: "PersistQueue"; messages: QueuedMessage[] }
  | { type: "SendAck"; messageId: string }
```

**reducer の責務**

- `MessageAcknowledged` を受けるまで `pendingAckIds` にエントリを保持
- `ConnectionLost` で `flushInProgress = false` にリセット。`pendingAckIds` は保持
- `ConnectionRestored` で pending 分を含めて再 flush

### IPC / cross-cutting: RPC subsystem

**現状**

`pendingRequests = Map<string, {resolve, reject, timer}>`。disconnect 時に全 reject。event の順序は Unix socket FIFO に依存。

**新設計: world state 型**

```typescript
// world state: JSON 直列化可能な metadata のみを含む
type PendingRequestMetadata = {
  requestId: string
  method: string
  payload: unknown
  sentAt: string      // ISO 8601
  timeoutMs: number
}

interface RpcState {
  pendingRequests: PendingRequestMetadata[]  // Map ではなく配列で保持（JSON 直列化可能。world state の原則に準拠）
  connectionStatus: "connected" | "disconnected" | "reconnecting"
}

// process state: callbacks と timer は process 内のみで持つ。world state には含めない
// Map を使用して構わない（process state は JSON 直列化を要求しない）
// reducer は PendingRequestMetadata のみを扱い、callbacks / timers には関知しない
// プロセス再起動時は破棄され、永続化対象外
interface RpcProcessState {
  callbacks: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  timers: Map<string, NodeJS.Timeout>
}
```

**想定 event 型**

```typescript
type RpcEvent =
  | { type: "RequestSent"; requestId: string; method: string; payload: unknown; sentAt: string; timeoutMs: number }
  // sentAt, timeoutMs, payload を含むことで reducer が PendingRequestMetadata を構築できる
  | { type: "ResponseReceived"; requestId: string; data: unknown }
  | { type: "RequestTimedOut"; requestId: string }
  | { type: "ConnectionLost" }
  | { type: "ConnectionRestored" }
```

**想定 command 型**

```typescript
type RpcCommand =
  | { type: "SendRequest"; requestId: string; method: string; payload: unknown }
  | { type: "RejectRequest"; requestId: string; error: Error }
  | { type: "ReplayPendingRequests"; requests: PendingRequestMetadata[] }  // effect runtime が reducer の state から取り出した pending request metadata を payload として持つ。reducer の純粋性を保つために state への直接参照を command に含めない
```

**reducer の責務**

- `ConnectionLost` で pending requests を reject ではなく suspended に移行
- `ConnectionRestored` で suspended requests を再送
- 順序保証のため request queue を FIFO で管理

### IPC / cross-cutting: ConfigPush subsystem

**現状**

gateway 接続時に 1 度だけ config を agent に送信する。接続後の動的更新機構なし。

**新設計: world state 型**

```typescript
interface ConfigPushState {
  lastPushedAt: number | undefined
  config: AgentConfig | undefined
}
```

**想定 event 型**

```typescript
type ConfigPushEvent =
  | { type: "ConfigUpdated"; config: AgentConfig }
  | { type: "AgentConnected" }
  | { type: "PushCompleted"; pushedAt: number }
```

**想定 command 型**

```typescript
type ConfigPushCommand =
  | { type: "SendConfigToAgent"; config: AgentConfig }
```

**reducer の責務**

- `AgentConnected` 時に現在の config が存在すれば `SendConfigToAgent` command を発行（初回 push）
- `ConfigUpdated` 時に接続中であれば即時 `SendConfigToAgent` command を発行（動的更新）
- 接続時の初回 push と動的更新を同一パスで処理し、push 漏れを防ぐ

### 未詳細設計 subsystem の統合先

対象 subsystem 一覧では 20 の subsystem を列挙しているが、上記で詳細設計を示したのは 9 subsystem（AbstractSession, Channel, PendingQueue, SSE Broadcaster, PhysicalSession, CopilotClient singleton, SendQueue, RPC, ConfigPush）である。残り 11 subsystem（Gateway 側 4 + Agent 側 4 + IPC/cross-cutting 側 3）は以下のとおり上位 subsystem に統合される。個別に独立した reducer を持たず、それぞれの親 subsystem の state・event・command に組み込む形で実現する。

**Gateway 側**

| 未詳細設計 subsystem | 統合先 | 統合方針 |
|---------------------|--------|---------|
| SessionOrchestrator | AbstractSession subsystem に包含 | 現状の `SessionOrchestrator` が担う「全セッションの status 管理と永続化」は、AbstractSession reducer の state（`AbstractSessionState`）と `PersistSession` command の effect runtime として再配置する。SQLite への書き込みは effect runtime が担い、orchestrator は reducer の薄いラッパーになる |
| SessionController | AbstractSession reducer + effect runtime に分解 | 現状の `SessionController` はすでに reducer 的な責務を持つ（`VALID_TRANSITIONS` による遷移検証）。これを純関数 reducer に変換し、副作用（`notifyAgent` / SSE broadcast 等）は effect runtime に委ねる |
| SQLite 永続化層 | AbstractSession subsystem の `PersistSession` command の effect runtime | world state の変更が発生するたびに `PersistSession` command を発行し、effect runtime が SQLite に書き込む。SQLite 自体は state を持たず、reducer の外に置く |
| HTTP in-flight | 追跡なし（明示的設計対象外） | 現状と同様に追跡しない。in-flight request のキャンセルは HTTP server のプロセス終了に委ねる。必要になれば別途設計する |

**Agent 側**

| 未詳細設計 subsystem | 統合先 | 統合方針 |
|---------------------|--------|---------|
| reinject 状態 | PhysicalSession subsystem に包含 | `PhysicalSessionWorldState.reinjectCount` として state に組み込む。`ReinjectDecided` event で increment。`PhysicalSessionProcessState` の `sessionPromise` overwrite は effect runtime が管理する |
| AbortController 群 | PhysicalSession subsystem の process state に包含 | `PhysicalSessionProcessState.abortController` として分離済み。abort の発火は `StopRequested` / `DisconnectRequested` event に対する command として effect runtime が実行する。abort 漏れは effect runtime が責任を持ち、reducer は関知しない |
| in-flight tool call | PhysicalSession subsystem に包含 | `PhysicalSessionWorldState` に `currentToolName: string | undefined` フィールドを追加し、`ToolExecutionStarted` / `ToolExecutionCompleted` event で更新する。gateway 側の `currentState` 追跡（observability 系）とは用途が異なるため、agent 側は独自に持つ |
| resolvedModel | PhysicalSession subsystem に包含 | `PhysicalSessionWorldState.resolvedModel` として state に組み込む。`session.setModel()` の呼び出しは `SessionCreated` event 後に effect runtime が実行する `SetModel` command として設計する |

**IPC / cross-cutting**

| 未詳細設計 subsystem | 統合先 | 統合方針 |
|---------------------|--------|---------|
| event ordering | RPC subsystem に包含 | RPC subsystem の FIFO request queue が event ordering を担う。subsystem 内 strict ordering は event bus の実装で保証する（各 subsystem の event キューを 1 つずつ処理） |
| reconnection | RPC subsystem + SendQueue subsystem に包含 | `ConnectionLost` / `ConnectionRestored` event を両 subsystem が共有する。reconnection ロジック（3 秒遅延等）は effect runtime が担い、reducer は connection status のみ追跡する |
| copilotSessionId 整合 | AbstractSession subsystem（gateway 側）と PhysicalSession subsystem（agent 側）に分散して包含 | gateway の AbstractSession reducer が `DisconnectRequested` command を発行した際に `physicalSessionId` を state に保持し、次の `StartPhysicalSession` command に含める。agent 側は受け取った `physicalSessionId` が非 `undefined` の場合のみ `resumeSession` を呼ぶ。`GatewayToAgentEvent.StartPhysicalSession` 型が `physicalSessionId: string | undefined` を持つことで型レベルで整合を強制する |

---

## subsystem 間の通信（event bus）

### ordering と delivery semantics

subsystem 内の event は FIFO キューで順序を保証する。subsystem 間の event は非同期だが、以下の保証を持つ。

- **同一 subsystem 内**: strict ordering。reducer は event を 1 つずつ処理し、次の event は前の reducer 呼び出しが完了してから処理
- **subsystem 間**: at-least-once delivery。命令の実行が確認されるまで command を再発行可能にする
- **gateway ↔ agent process 境界**: IPC stream の FIFO 性を利用。ただし reconnect 中の event は SendQueue に一時退避し、reconnect 後に配信

### dedup と重複検知

- 各 event に `eventId`（UUID）を付与する
- dedup セットは **event bus infrastructure が持ち、各 subsystem の world state には含めない**。各 subsystem の world state 型（`AbstractSessionState`, `RpcState` 等）に `processedEventIds` フィールドは存在しない
- event bus 自体の state（dedup set、event order log 等）は infrastructure state として独立して定義する

### event bus infrastructure subsystem

event bus infrastructure は独立した subsystem として設計する。他の subsystem（`AbstractSessionState` 等）とは分離され、router 兼 dedup judge として機能する。

**world state 型**

```typescript
interface EventBusInfrastructureState {
  processedEventIds: string[]  // recent window（配列で JSON 直列化可能）
  // process 再起動時は recent window のみ復元するため、限定的な冪等性保証を提供する。
  // 長期保持が必要な場合は TTL 付きの永続化を別途検討する
}
```

**想定 event 型**

```typescript
// event bus infrastructure が受信する event。eventId と対象 subsystem を必ず含む
type EventBusInfrastructureEvent =
  | { type: "EventArrived"; eventId: string; targetSubsystem: string; payload: unknown }
```

**想定 command 型**

```typescript
// event bus infrastructure が発行する command。dedup 判定結果を各 subsystem に伝える
type EventBusInfrastructureCommand =
  | { type: "DispatchToSubsystem"; eventId: string; targetSubsystem: string; payload: unknown }
  // dedup 判定により重複と判断した event はこの command を発行しない（silent drop ではなく判定ログに記録）
  | { type: "RecordDuplicateEvent"; eventId: string; targetSubsystem: string }
```

**reducer の責務**

- `EventArrived` 受信時に `processedEventIds` に `eventId` が含まれるか確認する
  - 含まれない場合: `processedEventIds` に追加し、`DispatchToSubsystem` command を発行する
  - 含まれる場合: `RecordDuplicateEvent` command を発行し、dispatch しない（重複排除）
- `processedEventIds` は recent window のみ保持する。window サイズは実装時に定める（例: 最新 1000 件）

dedup set は process state として保持することも選択肢となる。process 再起動後は recent window を失うが、ACK プロトコルと組み合わせることで実用上の消失リスクを許容範囲に抑える。gateway ↔ agent 間の ACK プロトコルにより、受信確認済みの message のみキューから削除する。

### gateway-agent process 境界を跨ぐ event

IPC stream で交換する event は以下の種類に限定する。現状の ad-hoc メッセージングを置き換える。

**gateway → agent**:

```typescript
type GatewayToAgentEvent =
  | { type: "StartPhysicalSession"; sessionId: string; model: string; physicalSessionId: string | undefined }
  | { type: "StopPhysicalSession"; sessionId: string }
  | { type: "DisconnectPhysicalSession"; sessionId: string }
  | { type: "ConfigUpdated"; config: AgentConfig }
  | { type: "RequestRunningSessions" }
  // gateway 起動時に reconcile coordinator が agent に送信する。agent は RunningSessionsReport で応答する。
  // request-response として設計し、gateway 側は一定時間（例: 5 秒）応答を待ったのち reconcile を完了とする
```

**agent → gateway**:

```typescript
type AgentToGatewayEvent =
  | { type: "PhysicalSessionStarted"; sessionId: string; physicalSessionId: string }
  | { type: "PhysicalSessionEnded"; sessionId: string; physicalSessionId: string; reason: EndReason }
  | { type: "SessionEvent"; sessionId: string; event: CopilotSdkEvent }
  | { type: "MessageAck"; messageId: string }
  | { type: "WaitToolResult"; sessionId: string; result: WaitToolPayload }
  | { type: "RunningSessionsReport"; physicalSessionIds: string[] }
  // RequestRunningSessions に対する応答。agent が現在保持している非 suspended セッションの
  // physicalSessionId 一覧を返す。現行実装の PhysicalSessionManager.getRunningPhysicalSessionsSummary()
  // に相当する情報をこの message に集約する
```

**reconcile coordinator のプロトコル**

gateway 起動時（または agent との IPC 再接続時）に reconcile coordinator が以下の sequence で実行する。

- reconcile coordinator が gateway → agent の `RequestRunningSessions` を送信する
- agent は `PhysicalSessionManager.getRunningPhysicalSessionsSummary()` の結果を `RunningSessionsReport.physicalSessionIds` として返す
- reconcile coordinator は `physicalSessionIds` を `runningPhysicalIds` として受け取り、全 AbstractSession を走査する
- 各 AbstractSession に `PhysicalSessionAliveConfirmed` または `PhysicalSessionAliveRefuted` を配信する

**既存の自発送信（`running_sessions` IPC メッセージ）との関係**

現行実装では agent が接続時に自発的に `running_sessions` 系の情報を gateway に送信するパターンが存在する可能性がある（`SessionController.onReconcile` で `orchestrator.reconcileWithAgent` を呼ぶ経路）。新設計では reconcile を `RequestRunningSessions` / `RunningSessionsReport` の request-response に統一し、自発送信は廃止する。理由: gateway が reconcile の開始タイミングを制御できる（接続確立後に gateway 側の state が準備完了してから request を送れる）ため、race を防ぎやすい。agent 側は request を受けて応答するだけでよく、自発的なタイミング管理が不要になる。

---

## 既存の症状の解消トレース

### wait/idle race

**現状**: agent 側の keepalive（`packages/agent/src/tools/channel.ts` の `waitForPendingNotify` タイムアウトサイクル）と gateway 側の主たる idle 検知（`packages/gateway/src/daemon.ts:241-244` の `case "session.idle"` で `sessionController.onSessionIdle()` を呼ぶ経路）が独立に「セッションが生きているか」を判断する。daemon.ts:311-324 は `backgroundTasks.agents` が存在する場合に `agentManager.notifyAgent()` で補助的な通知を行う経路であり、idle 遷移そのものを決定するのは 241-244 の `sessionController.onSessionIdle()` である。加えて agent 側の `packages/agent/src/session-loop.ts` が持つ `BACKGROUND_TASKS_IDLE_TIMEOUT_MS`（30 分）安全弁も独立したタイムアウトとして動作しており、判断者が 3 箇所に分散している。

**新設計での解消**: `session.idle` SDK イベントは agent プロセスが gateway に `AgentToGatewayEvent.SessionEvent`（SDK イベントラッパー）として転送する。gateway は受信した `SessionEvent` を AbstractSession reducer の `AbstractSessionEvent.IdleDetected` に変換して投入する（二段階）。agent が IPC 上に送るのは `SessionEvent` wrapper であり、`AbstractSessionEvent.IdleDetected` は gateway 内部の変換結果として reducer に渡される型である。AbstractSession reducer が `waitingOnWaitTool === true` の間の `IdleDetected` を拒否する（reducer 内条件: `state.waitingOnWaitTool && event.type === "IdleDetected"` → idle 遷移なし）。daemon.ts の 241-244（`sessionController.onSessionIdle()` 呼び出し）と 311-324（`agentManager.notifyAgent()` 補助通知）は、それぞれ `IdleDetected` event の投入と `NotifyAgent` command の発行として reducer + effect runtime に統合される。判断者が reducer 1 箇所に固定されるため、race が原理的に発生しない。`BACKGROUND_TASKS_IDLE_TIMEOUT_MS` 安全弁は agent 側の effect runtime が `KeepaliveTimedOut` event として統一的に扱う。

### double-start race

**現状**: `clientStartPromise ??= client.start()` で防止。状態機械不在。

**新設計での解消**: CopilotClient reducer の `status` が `"uninitialized"` の時のみ `StartRequested` を受け付ける。`starting` / `running` の状態では `StartRequested` を無視する command（または noop）を返す。`clientStartPromise` への直接代入は不要になる。

### channel status の不在

**現状**: `Channel` に status フィールドなし。session 経由の逆引きのみ。

**新設計での解消**: Channel subsystem が独自の state（`backoff`、`archivedAt` 等）を管理し、それ自体が first-class な概念になる。channel の状態を参照する際は session を経由しない。

### idleSession ↔ onPhysicalSessionEnded race

**現状**: idle 遷移と物理セッション終了通知が競合する経路がある。

**新設計での解消**: reducer は event を FIFO で 1 つずつ処理する。`IdleDetected` と `PhysicalSessionEnded` が同時に届いても、どちらか先に処理された方の状態遷移が確定する。後から届いた event は現在の状態に応じて適切に処理される（例: 既に `suspended` であれば `IdleDetected` は noop）。

### copilotSessionId dead field と resume パスの機能不全

**現状**: gateway が `startPhysicalSession` に `physicalSessionId: undefined` を送り続ける。agent は常に `createSession` を呼び、会話記憶が失われる。

**新設計での解消**: `StartPhysicalSession` event が明示的に `physicalSessionId` を含む型を持つ。gateway の AbstractSession reducer は `DisconnectRequested` command を発行した際に `physicalSessionId` を state に保持し、次の `StartPhysicalSession` command にそれを含めて送る。`physicalSessionId` が `undefined` の場合のみ `createSession`、そうでなければ `resumeSession` を呼ぶ。dead field 問題は型レベルで解消される。

### send queue のメッセージ消失

**現状**: ACK プロトコルなし。flush 後にディスクをクリアするため、flush 中クラッシュで消失。

**新設計での解消**: SendQueue reducer が `MessageAcknowledged` を受けるまで `pendingAckIds` にエントリを保持する。gateway 側が ACK を送信後にのみキューエントリを削除する。`ConnectionLost` でフラッシュを中断しても、`pendingAckIds` の内容は保持され、再接続後に再送される。

### daemon.ts による observability 系 state の直接 mutate

**現状**: daemon.ts は `session.usage_info` / `assistant.usage` / `session.model_change` / `subagent.*` イベント受信時に、`orchestrator.updatePhysicalSessionTokens` / `orchestrator.accumulateUsageTokens` / `orchestrator.updatePhysicalSessionModel` / `orchestrator.addSubagentSession` / `orchestrator.updateSubagentStatus` を SessionController を介さずに直接呼び出す（6 箇所、lines 249, 261, 276, 279, 288, 291）。session status は `SessionController.transition()`（private）で保護されているが、それ以外の observability 系 state は保護されていない。

**新設計での解消**: daemon.ts は event を発行するだけで状態更新を行わない。`UsageUpdated` / `TokensAccumulated` / `ModelResolved` / `SubagentStarted` / `SubagentStatusChanged` 等の event を event bus に投入し、AbstractSession reducer がこれらも処理する。daemon.ts は command を effect runtime として実行するのみ。すべての state mutation が reducer を経由するため、状態全体の一貫性が型レベルで保証される。

### `generation` / `isReconciled` dead code

**新設計での解消**: reducer の state 型から dead field を削除する。`isReconciled` の責務は reconcile coordinator が各 AbstractSession に `PhysicalSessionAliveConfirmed` / `PhysicalSessionAliveRefuted` event を送る sequence として明示化する。

---

## 既存 proposal との関係

| 既存 proposal | 関係 |
|--------------|------|
| `docs/proposals/channel.md`: SessionController 設計（v0.64.0 で実現済み） | 本 proposal が上位。SessionController は「gateway 側 AbstractSession subsystem の reducer」として本設計に包含される。既存実装を新設計に段階的に移行する際の出発点 |
| `docs/proposals/channel.md`: モデル切り替え（未実現） | 本 proposal の AbstractSession reducer と PhysicalSession reducer の協調で実現される。turn run 終了時に次回 `StartPhysicalSession` command に新モデルを含める |
| `docs/proposals/channel.md`: 「メッセージ消費とセッションステータス管理のバグ修正」セクション（L242-317）の残件（startPhysicalSession ack タイムアウト監視、IPC reconnect flush 順序） | 本 proposal に包含。PendingQueue subsystem の ACK プロトコルと SendQueue subsystem の `ConnectionRestored` 再送で解消 |
| `docs/proposals/agent.md`: PhysicalSessionEntry 混在問題 | 本 proposal の「PhysicalSession subsystem の world/process 分離」として吸収 |
| `docs/proposals/agent.md`: CopilotClient シングルトン | 本 proposal の「CopilotClient singleton subsystem」として吸収 |
| `docs/proposals/agent.md`: send queue / channelBackoff の散在記述 | 本 proposal の「SendQueue subsystem」「Channel subsystem の BackoffState」として統合 |
| `docs/proposals/status.md`: 未実現 3 件 | 本 proposal がアーキテクチャ的な上位設計。以下を参照。なお「end turn run の disconnect 方式」は v0.68.0 で実装済みとなったため、未実現 4 件から 3 件に減少している |

`docs/proposals/status.md` の未実現 3 件との対応:

| status.md 未実現項目 | 本 proposal での扱い |
|--------------------|-------------------|
| gateway 側の copilotSessionId → physicalSessionId 統一 | `StartPhysicalSession` event の型設計で解消。dead field を型から除去 |
| メッセージ消費バグ修正の残件（startPhysicalSession ack / IPC reconnect flush 順序） | PendingQueue subsystem の ACK プロトコルと SendQueue subsystem の `ConnectionRestored` 再送で解消 |
| gateway 停止時の情報無損失（ACK プロトコル） | SendQueue subsystem の `MessageAcknowledged` で解消 |

---

## 移行戦略

一発書き換えは実際のプロダクトでは不可能なため、段階的に移行する。

**フェーズ: world/process 分離**

既存の `PhysicalSessionEntry` と `AbstractSession` を world state と process state に分割する。まず型を分割し、mutate を既存の setter 経由に集約する準備段階。コードの動作は変えない。

**フェーズ: event 型の定義**

各 subsystem の event 型を TypeScript で定義する。まだ reducer を作らず、既存 callback 内で event object を生成するだけ（`handleEvent(event)` に委譲するが内部は既存ロジック）。event の有限列挙が完成する。

**フェーズ: reducer の導入（agent 側 PhysicalSession から開始）**

agent 側の PhysicalSession subsystem から reducer を導入する。理由: gateway 側より影響範囲が小さく、テストが書きやすい。`PhysicalSessionProcessState` を runtime に分離し、`reduce(state, event)` を実装。既存のテストが通ることを確認する。

**フェーズ: reducer の導入（gateway 側 AbstractSession）**

gateway 側の AbstractSession reducer を実装する。SessionController の既存実装を reducer に変換する。`VALID_TRANSITIONS` 表を reducer の state machine として再実装。daemon.ts の直接 orchestrator 呼び出し箇所（status 変更・observability 系含む全 6 箇所）を event 投入に置き換える。

**フェーズ: channel subsystem と event bus の導入**

Channel subsystem に独自 state を持たせる。subsystem 間の event バスを実装し、直接 field アクセスを event 投入に置き換える。

**フェーズ: IPC event の型付けと ACK プロトコル**

gateway ↔ agent 間の IPC を `GatewayToAgentEvent` / `AgentToGatewayEvent` の型付き event として再実装。SendQueue に ACK プロトコルを追加する。

**フェーズ: SSE broadcaster と config push の動的化**

SSE broadcaster に replay buffer を導入。config push を接続時 1 度から event-driven な動的更新に変更。

---

## テスト戦略

### reducer の単体テスト

reducer は純関数であるため、I/O なしで単体テストが書ける。

```typescript
// 例
test("WaitToolCalled 中は IdleDetected で idle 遷移しない", () => {
  const state0 = { status: "waiting", waitingOnWaitTool: false, ... }
  const state1 = reduce(state0, { type: "WaitToolCalled" }).newState
  expect(state1.status).toBe("waiting")
  expect(state1.waitingOnWaitTool).toBe(true)

  const { newState: state2, commands } = reduce(state1, { type: "IdleDetected", hasBackgroundTasks: false })
  expect(state2.status).toBe("waiting")  // idle に遷移しない
  expect(commands).not.toContain(expect.objectContaining({ type: "StopPhysicalSession" }))
})
```

### command 列の assert

reducer の戻り値の `commands` を検証することで、副作用の意図を単体テストで確認できる。

```typescript
test("MaxAgeExceeded で DisconnectPhysicalSession を発行する", () => {
  const { commands } = reduce(runningState, { type: "MaxAgeExceeded" })
  expect(commands).toContainEqual({ type: "DisconnectPhysicalSession", sessionId: "..." })
})
```

### event 系列の網羅

複数 event の連続を渡すヘルパーを作成し、race condition シナリオをテストで表現する。

```typescript
// 例: PhysicalSessionEnded と IdleDetected が同時に届くシナリオ
const finalState = replayEvents(initialState, [
  { type: "WaitToolCalled" },
  { type: "PhysicalSessionEnded", physicalSessionId: "ps-abc123", reason: "error" },
  { type: "IdleDetected", hasBackgroundTasks: false },
])
expect(finalState.status).toBe("suspended")
```

### subsystem 間 event 通信のテスト

event bus の mock を使って subsystem 間の event のやりとりをテストする。特定の event を投入した時に別の subsystem に期待する event が発行されることを確認する。

### process 境界を跨ぐ event のテスト

IPC stream の mock（メモリ内双方向チャネル）を用意して、gateway 側と agent 側を同一プロセス内で接続し、end-to-end の state machine を検証する。現状の `session-orchestrator.test.ts` の race シミュレートを、event 系列の入力として再実装する。

---

## チャンネルステータス・イベント抽象化・エージェント識別の設計（部分実現）

本節は `docs/raw-requirements/channel-status-and-events-redesign.md`（2026-04-14）の要望に基づく設計拡張である。要求定義は `docs/requirements/channel-status-and-events.md` に記載されている。

### Gateway: Channel subsystem の拡張 — 表示用ステータスの射影

**v0.71.0 で部分実現**: `DerivedChannelStatus` 型定義と `selectDerivedChannelStatus` 純関数（`channel-status-selector.ts`）を実装済み。`session-controller.ts` の `broadcastStatusChange` で selector を呼び SSE event data に `derivedStatus` を付与済み。`DashboardPage.tsx` で `session_status_change` 時に `derivedStatus` を優先表示するよう実装済み。

以下の項目は proposal として未実現のまま残存:
- `client-not-started` 状態（CopilotClient 観測経路）— selector は常に `clientStarted = true` を仮定。CopilotClient の状態を観測する経路が未実装
- `waitingOnWaitTool` フィールド — `AbstractSessionState` には存在しない。selector は `session.status` と `hasPending` で近似判定
- `hasHadPhysicalSession` フィールド — `AbstractSessionState` には存在しない。`physicalSessionHistory.length > 0` で代替

Channel subsystem の現設計（上記「Gateway: Channel subsystem」節）を以下のように拡張する。

**表示用ステータス型の定義**

```typescript
type DerivedChannelStatus =
  | "client-not-started"          // SDK client が未起動
  | "no-physical-session-initial" // 初回: physical session が未作成
  | "no-physical-session-after-stop" // 強制停止後: physical session なし
  | "idle-no-trigger"             // physical session あり。turn run 未開始、トリガーなし
  | "pending-trigger"             // turn run 未開始、起動トリガーが発生中
  | "running"                     // turn run 実行中（copilotclaw_wait 待機中でない）
```

`DerivedChannelStatus` は Channel subsystem の world state には直接書き込まない。以下の入力から effect runtime 層の selector 関数が導出する（pure function）。

| 入力 | 参照元 |
|---|---|
| CopilotClient の status | CopilotClientState.status |
| physical session の有無 | AbstractSessionState.physicalSessionId |
| physical session の起源 | AbstractSessionState の history（初回か強制停止後かを判定）|
| abstract session の status | AbstractSessionState.status |
| copilotclaw_wait 待機中フラグ | AbstractSessionState.waitingOnWaitTool |
| pending trigger の有無 | PendingQueueState.messages の存在 |

**射影ロジック（疑似コード）**

```
function derivedChannelStatus(
  clientStatus: CopilotClientStatus,
  sessionState: AbstractSessionState,
  pendingQueue: PendingQueueState,
): DerivedChannelStatus {
  if (clientStatus !== "running") return "client-not-started"

  if (sessionState.physicalSessionId === undefined) {
    // 初回か強制停止後かを区別する
    if (sessionState.hasHadPhysicalSession) return "no-physical-session-after-stop"
    return "no-physical-session-initial"
  }

  // suspended 状態: physicalSessionId は保持されているが物理セッション接続が切断されている。
  // pending trigger があれば pending-trigger として射影し、なければ idle-no-trigger。
  // suspended セッションは次の pending trigger で自動 resume される設計のため、
  // "no-physical-session-after-stop" とは区別せず idle 系に射影する。
  if (sessionState.status === "suspended") {
    if (pendingQueue.messages.length > 0) return "pending-trigger"
    return "idle-no-trigger"
  }

  // starting 状態: 物理セッションの起動処理中（PhysicalSessionStarted を待っている段階）。
  // idle → starting 遷移では physicalSessionId が保持されているため（v0.58.0 の常時保持設計）、
  // この分岐に到達する（これは想定経路）。new → starting 遷移では physicalSessionId が
  // undefined のため上の physicalSessionId === undefined 分岐でキャッチされる。
  // suspended → starting 遷移でも physicalSessionId は保持されているため同様にここに到達する。
  // pending があれば human 要望「起動トリガーが発生した状態」に整合して pending-trigger に
  // 射影する。pending なし（ReviveRequested による明示的 revive 等）は idle-no-trigger。
  if (sessionState.status === "starting") {
    if (pendingQueue.messages.length > 0) return "pending-trigger"
    return "idle-no-trigger"
  }

  // copilotclaw_wait 待機中は turn run が開始済みでも agent は待機中であり running ではない。
  // human の要望「copilotclaw_wait の待ち状態が解除され、稼働中の状態も含む」は、
  // wait が "解除された後" の running を指す。wait 中（waitingOnWaitTool=true）は running に含めない。
  if (sessionState.status === "waiting" && sessionState.waitingOnWaitTool) {
    // pending trigger があれば pending-trigger として射影
    if (pendingQueue.messages.length > 0) return "pending-trigger"
    return "idle-no-trigger"
  }

  if (
    sessionState.status === "notified" ||
    sessionState.status === "processing"
  ) return "running"

  if (
    sessionState.status === "waiting" &&
    !sessionState.waitingOnWaitTool &&
    pendingQueue.messages.length > 0
  ) return "pending-trigger"

  // idle かつ pending あり: MessageDelivered が届いたが idle → starting 遷移がまだ処理されていない
  // 過渡状態。理論上は MessageDelivered event で即座に idle → starting に遷移するため実際には
  // 観測されにくいが、並行動作で観測されうるため正しい射影として pending-trigger を返す。
  if (
    sessionState.status === "idle" &&
    pendingQueue.messages.length > 0
  ) return "pending-trigger"

  // ここに落ちるケース:
  // - idle 状態かつ pending なし（PhysicalSessionEnded 後の正常終了待機中。
  //   turn run が完了しトリガー未着の状態）
  // - waiting かつ waitingOnWaitTool=false かつ pending なし（WaitToolCompleted 直後または
  //   PhysicalSessionStarted 直後の初期待機でまだ pending が届いていない待機）
  // - new → starting 遷移直後で PhysicalSessionStarted 未受信かつ physicalSessionId=undefined
  //   のケースは上の physicalSessionId===undefined 分岐でキャッチされるため、ここには到達しない
  return "idle-no-trigger"
}
```

**設計判断**: 射影関数の責務は reducer ではなく effect runtime 層の selector として分離する。理由: reducer は状態遷移の純関数として保ち、表示用の導出ロジックを reducer に混入させない。`DerivedChannelStatus` は SSE broadcast 時と frontend API レスポンス時に selector を呼び出して動的に計算する。

`AbstractSessionState` に `hasHadPhysicalSession: boolean` フィールドを追加し、`PhysicalSessionStarted` event で `true` に設定する。これにより初回と強制停止後の区別が可能になる。

**UI への反映**: Dashboard のステータスバーを「選択中のチャンネル名 + そのステータス」の形式に変更する。

### Gateway: AbstractSessionEvent の拡張 — イベント抽象化

現設計（上記「Gateway: AbstractSession subsystem」節）の `AbstractSessionEvent` を拡張し、メッセージ以外の入力イベントを有限列挙に含める。

`copilotclaw_wait` の返却値構造（`WaitToolPayload`）を、`userMessage` フィールド 1 つから多様なイベント型を列挙できる構造に変更する。

```typescript
// 現状: WaitToolPayload = { userMessage: string } のみ
// 新設計: 複数のイベント型を列挙
type WaitToolPayload =
  | { type: "message"; sender: MessageSender; content: string }
  | { type: "subagent-completed"; toolCallId: string; agentName: string }
  | { type: "subagent-failed"; toolCallId: string; agentName: string; error: string }
  | { type: "keepalive" }  // keepalive のみの場合（トリガーなし）
```

channel operator が `copilotclaw_wait` から受け取る返却値がイベント型の分岐として明確に記述でき、sender フィールドの値に応じた条件分岐コードが不要になる。

### Gateway: sub-subagent 通知抑制の強化

現状の `data["parentToolCallId"]` フィルタ（`packages/gateway/src/daemon.ts`）は機能しているが、outer wrapper 経由のフィルタ（`msg["parentId"]`）は agent 側が `parentId` を outer wrapper に含めないため機能していない。

**新設計での対応**:

agent 側の session キャッチオール（`physical-session-manager.ts`）が SDK イベントを `SessionEvent` として gateway に転送する際、SDK イベント内の `parentId` を outer wrapper に引き上げて含める。

```typescript
// 現状: { type: "SessionEvent", sessionId, event: sdkEvent }
// 新設計: { type: "SessionEvent", sessionId, parentId: sdkEvent.parentId, event: sdkEvent }
type AgentToGatewayEvent =
  | { type: "SessionEvent"; sessionId: string; parentId: string | undefined; event: CopilotSdkEvent }
  // ...
```

gateway 側は `msg["parentId"]` が非 undefined かつ対応するセッションが直接呼び出しでない場合に通知を抑制する。これにより `data["parentToolCallId"]` と `msg["parentId"]` の 2 経路でフィルタリングが機能する（二重防御）。

### メッセージ sender 識別の設計

**メッセージスキーマの拡張**

`Message.sender` を以下のように拡張する。

```typescript
type MessageSender =
  | { type: "user" }
  | { type: "agent"; agentId: string; agentDisplayName: string; agentRole: "channel-operator" | "worker" | "unknown" }
  | { type: "cron"; jobId: string }
  | { type: "system" }
```

既存の `"user" | "agent" | "cron" | "system"` の 4 値文字列から、sender の詳細情報を持つ discriminated union に変更する。DB スキーマは sender_type カラムと sender_meta（JSON）カラムに分割する（既存 sender カラムからの移行）。

**sender 特定の実装方針**

`copilotclaw_send_message` ハンドラ（`packages/gateway/src/daemon.ts`）が tool call event を受信した時点で、セッションの subagent 追跡情報（`AbstractSessionState.subagents`）を参照し、呼び出し元の agentId を特定する。

session event の tool call event（SDK の `tool_call.start` 相当）を `SessionEvent` として gateway に転送し、gateway が `copilotclaw_send_message` の呼び出し元 agent を特定する経路を検討する。セッション event が subagent/sub-subagent のイベントも拾える場合、tool call event から sender を特定できる（要 SDK 動作検証）。

#### task tool インターフェース分析と agent 命名戦略（未実現・要 SDK 動作検証）

SDK の Task tool（subagent を呼び出すツール）のインターフェースを把握し、かつシステムプロンプトを工夫することで、agent ごとに異なる名前を割り当てる設計が必要である。現時点では SDK の動作検証が完了していないため、以下は候補アプローチの整理と暫定設計方針にとどまる。

**調査対象（SDK 動作検証が必要な点）**

- SDK の Task tool がサブエージェント呼び出し時にどのような引数を受け取るか
- `subagent_type` や agent name を指定する手段が Task tool の引数として存在するか
- サブエージェントに異なる display name を割り当てるインターフェースの存在（SDK が API として提供しているか）
- サブエージェント内部から自分の identity（自分がどの名前・役割で起動されたか）を参照する API の存在

**候補となる設計アプローチ**

- **sdk-tool-arg**: Task tool の引数として `agent_name` / `display_name` を渡す設計 — SDK が API として提供している場合に採用できる。ゲートウェイ側での自動識別が可能で、agent の協力を必要としない
- **self-declared-naming**: システムプロンプトで agent に自身の名前を認識させ、`copilotclaw_send_message` / `copilotclaw_intent` 呼び出し時に名前を明示的に渡させる設計 — SDK の API に依存しないが、agent がシステムプロンプトの指示に従うことに依存する
- **session-event-tracking**: session event の tool call event から、サブエージェントがセッション内でどの `agent-type` として起動されたかを特定する設計 — 自動化でき agent の協力が不要だが、SDK が subagent の session event を適切に公開している必要がある
- **parent-assigned-id**: 親エージェント側がサブエージェント起動時に ID を割り当て、その対応表を gateway に事前送信する設計 — sdk-tool-arg / self-declared-naming / session-event-tracking のいずれも不十分な場合のフォールバック

**決定基準**

- SDK 動作検証の結果により sdk-tool-arg が可能であれば最優先
- sdk-tool-arg が不可能な場合、session-event-tracking が次善（自動化でき、agent の協力不要）
- session-event-tracking が不可能な場合、self-declared-naming を採用（ただし agent がシステムプロンプトの指示に従うことに依存）
- parent-assigned-id は sdk-tool-arg / self-declared-naming / session-event-tracking のいずれも不十分な場合のフォールバック

**暫定設計方針（SDK 検証前）**

現時点では session-event-tracking を本命として設計を進める。`SessionEvent` に含まれる tool call event から subagent の identity を特定する試みを行い、SDK 動作検証の結果によって上記決定基準に基づき最終設計を確定する。SDK 動作検証が本設計全体の blocker であり、検証完了まで実装に着手しない。

### UI 設計方針

本 proposal は frontend の実装詳細には踏み込まないが、以下の設計方針を定める。

**タイムライン UI の統一ストリーム設計**

チャンネルのタイムライン UI を「メッセージ + 非メッセージイベント」の統一ストリームとして扱う。backend API は timeline エントリの型を以下のように拡張する。

```typescript
type TimelineEntry =
  | { entryType: "message"; message: Message }
  | { entryType: "turn-run-started"; sessionId: string; timestamp: string }
  | { entryType: "turn-run-ended"; sessionId: string; timestamp: string; reason: string }
  | { entryType: "subagent-started"; toolCallId: string; agentName: string; agentDisplayName: string; timestamp: string }
  | { entryType: "subagent-lifecycle"; toolCallId: string; agentName: string; status: "idle" | "completed" | "failed"; timestamp: string }
```

**エージェントアイコン・プロフィールモーダル**

- 各メッセージにアイコン + 表示名を表示する（sender.type と agentRole で視覚的に区別）
- agent アイコンをクリックするとプロフィールモーダルが開く（agentId、agentRole、モデル、ステータス）
- subagent / sub-subagent からのメッセージはデフォルトで collapse 表示

**intent の表示**

- `copilotclaw_intent` で記録された intent はタイムライン本体には表示せず、agent のプロフィールモーダル内でのみ時系列表示する

### copilotclaw_intent tool の設計

v0.70.0 で tool 定義・gateway handler（`handleIntentToolCall`）・in-memory 記録（`IntentsStore` singleton）・システムプロンプト制約（channel-operator / worker の両方に単独呼び出し禁止制約を追加）を実装済み。API エンドポイント（`GET /api/channels/:channelId/intents/:agentId`）・UI 表示（プロフィールモーダル内 intent タイムライン）・SQLite 永続化（intents テーブル）は未実現。

**tool 定義**

```typescript
// tool 名: copilotclaw_intent
// 引数
interface CopilotclawIntentArgs {
  intent: string  // agent が何をしようとしているかのテキスト記述
}
// 返却値: 即時 return（ポーリングなし）
// 成功時: { acknowledged: true }
```

**システムプロンプト制約**

channel-operator と worker のシステムプロンプトに以下の制約を追加する:
- `copilotclaw_intent` は他のツールと同時に呼び出すこと（単独での呼び出しは禁止）
- 呼び出し例: `copilotclaw_intent`（intent 記述）と `Bash`（実際の作業）を同時実行

**保存先**: intent は messages テーブルとは別の intents テーブルに保存する。`channelId`、`agentId`、`content`、`timestamp` を持つ。

**API**: `GET /api/channels/:channelId/intents/:agentId` で特定エージェントの intent 一覧を返す（プロフィールモーダル表示用）。

### channel operator / worker のツール割り当て整理

**現状（v0.69.0 で修正済み）**

`tools: null` による暗黙割り当ては廃止された。`CustomAgentDef.copilotclawTools` フィールドを追加し、`client.rpc.tools.list({})` で取得した builtin tool 名と `copilotclawTools` を結合して各 custom agent の `tools` に明示指定するよう変更された。channel-operator には `["copilotclaw_wait", "copilotclaw_list_messages", "copilotclaw_send_message"]`、worker には `["copilotclaw_list_messages", "copilotclaw_send_message"]` を付与する（`copilotclaw_wait` は worker に付与しない）。

なお、`copilotclaw_intent` tool は v0.70.0 で実装済み。channel-operator / worker の `copilotclawTools` への追加も v0.70.0 で実現済み。API エンドポイント・UI 表示・SQLite 永続化は未実現のまま。

**新設計: 明示的 tool list**

SDK の server-scoped RPC `client.rpc.tools.list()` を使って builtin tool 名を取得し、custom agent 定義の `tools` フィールドに明示的な tool 名配列を設定する。

**SDK API の実体**（`@github/copilot-sdk@0.2.0` で確認済み）:

- `CopilotClient.rpc` は `createServerRpc(connection)` の戻り値を公開する getter（`client.d.ts:62`）
- `createServerRpc` は session 作成前でも呼べる server-scoped RPC 群を返す（`rpc.d.ts:971`）
- その中に `tools.list(params: ToolsListParams): Promise<ToolsListResult>` が含まれる（`rpc.d.ts:976-978`）
- 戻り値 `ToolsListResult` の形状: `{ tools: { name: string; namespacedName?: string; description: string; parameters?: object; instructions?: string }[] }`
- `CustomAgentConfig.tools?: string[] | null`（`types.d.ts:605`）— tool **名前** の配列（tool object 全体ではない）。`null`/`undefined` は「全 builtin tool 許可」のデフォルトを意味する

```typescript
// createSession / resumeSession の直前に毎回呼ぶ。model は指定しない。
const toolsListResult = await client.rpc.tools.list({})
const builtinToolNames: string[] = toolsListResult.tools.map((t) => t.name)

const channelOperatorDef: CustomAgentConfig = {
  name: "channel-operator",
  // ...
  tools: [
    ...builtinToolNames,
    "copilotclaw_wait",
    "copilotclaw_list_messages",
    "copilotclaw_send_message",
    "copilotclaw_intent",  // 新規追加
  ],
  prompt: "...",
}

const workerDef: CustomAgentConfig = {
  name: "worker",
  // ...
  tools: [
    ...builtinToolNames,
    "copilotclaw_list_messages",
    "copilotclaw_send_message",
    "copilotclaw_intent",  // 新規追加
    // copilotclaw_wait は含めない
  ],
  prompt: "...",
}
```

`tools: null` を廃止し、`tools: [...]` の明示指定に変更する。`client.rpc.tools.list` は `createSession` および `resumeSession` を呼び出す直前に毎回実行して最新の builtin tool 名一覧を取得する。**結果を cache してはいけない**（SDK 側の tool set が変わる可能性を考慮）。

**model パラメータは指定しない**（`{}` で呼ぶ）。`ToolsListParams.model` を指定すると SDK 定義「Optional model ID — when provided, the returned tool list reflects model-specific overrides」の通りモデル固有のオーバーライドが結果に反映されてしまうが、copilotclaw としてはこのモデル別オーバーライドを望まない。どのモデルでも同じ builtin tool set を使いたいので、モデル非依存のデフォルト結果を得るために `model` は省略する。

したがって呼び出し経路は「`createSession` / `resumeSession` を呼ぶ手前で `await client.rpc.tools.list({})` → 得られた `tools[].name` を `customAgents[].tools` に設定 → createSession/resumeSession 実行」の順。reinject による再作成、end-turn-run 後の再 `createSession`、dynamic model switch 後の再作成など、session を新しく作る経路すべてで都度取得する。

**注意**: `CustomAgentConfig.tools` は string[] である（`Tool<any>[]` を渡せるのは `SessionConfig.tools` の方で、両者は別物）。ここで配列に入れるのは tool 名の文字列であり、tool 実装オブジェクトではない。copilotclaw_* tools の実装は従来通り `SessionConfig.tools: Tool<any>[]` として渡され、agent 定義側では名前で参照される。
