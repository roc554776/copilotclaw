# 提案: 系全体の状態管理アーキテクチャ再設計

**（9/10 subsystem 実現済み — v0.80.0-v0.82.0）**

本 proposal は copilotclaw の全 subsystem にまたがる状態管理の根本的な再設計を定義する。session lifecycle のみを対象とした局所的な改善ではなく、gateway 側・agent 側・IPC/cross-cutting のすべてを射程に含める。

**v0.80.0 実装済み（Phase A-E）**: World state / process state の型分離（`session-events.ts`）、event 型定義（discriminated union）、AbstractSession reducer（`session-reducer.ts`、gateway）、PhysicalSession + CopilotClient reducer（`session-reducer.ts`、agent）、effect runtime（`effect-runtime.ts`）、SessionController の key メソッドを `dispatchEvent()` 経由の reducer 呼び出しに置き換え。47 新規 gateway reducer unit tests + 26 新規 agent reducer unit tests。

**v0.81.0 実装済み（直接 mutate 完全排除）**: gateway `session-orchestrator.ts` から直接 mutate メソッド 11 個を全削除（`suspendSession`・`idleSession`・`updateSessionStatus` 等）。`applyWorldState()` が唯一の書き込み経路に。gateway `session-controller.ts` の `transition()`・`broadcastStatusChange()` を削除し全遷移を `dispatchEvent()` 経由に。agent `physical-session-manager.ts` の `PhysicalSessionEntry.info` を `worldState: PhysicalSessionWorldState` に置き換え。

**v0.82.0 実装済み（残り subsystem + EventBus + backoff 永続化 + dead code 削除）**: gateway の Channel subsystem（`channel-events.ts` / `channel-reducer.ts`）、PendingQueue subsystem（`pending-queue-events.ts` / `pending-queue-reducer.ts`）、SSE Broadcaster subsystem（`sse-broadcaster-events.ts` / `sse-broadcaster-reducer.ts`）を reducer 化。agent の SendQueue reducer + RPC reducer を production code に接続（`ipc-events.ts` / `ipc-reducers.ts`）。ConfigPush reducer は設計判断により削除（stateless かつ package 依存制約のため dead code — 詳細は「ConfigPush subsystem」節を参照）。EventBus infrastructure（`event-bus.ts`）実装済み。`channel_backoff` テーブル追加（store.db schema v6→v7）でバックオフを永続化。dead code 削除（`generation`・`isReconciled`・`FlushBatch`・`DrainAcknowledged`・`MessageFlushed`）。regression tests 追加（starting stuck・processing deadlock シナリオ）。

**未実現**: IPC 型付き event union（`GatewayToAgentEvent` / `AgentToGatewayEvent`）の production 接続、`startPhysicalSession` ACK 確認プロトコル、`channel_status_change` への SSE rename、`channel_timeline_event` / `WaitToolPayload` 多型化、reconcile coordinator の request-response 化、double drain の完全排除（構造的 mutex なし）。

既存の `docs/proposals/channel.md` の SessionController 設計（v0.64.0 で実現済み）は gateway 側の session lifecycle に scope を限定したものだった。本 proposal はその上位に位置し、全 subsystem を横断するアーキテクチャとして整理し直す。

---

## SSE 配信スコープに関する設計方針

### アンバウンド session status は SSE で配信しない

session status change イベントは常に channel-scoped である（1 つのセッションは必ず 1 つの channel に bind される）。channelId のない session status イベントが発生した場合、どのクライアントに届けるかを決定する根拠がないため、SSE での配信は行わない。

これは v0.72.0 以前の実装（channelId なしで全クライアントに broadcast していた）とは異なる意図的な変更である。旧実装の broadcast は誤りであり、新実装ではこのケースを明示的に drop する。

具体的には `daemon.ts` の `setSseBroadcast` コールバックで `event.channelId === undefined` のイベントを drop し、コメントでその Intent を説明している。

---

## 背景と問題意識

### 観測されている症状

commit 履歴と実装調査から、以下の症状が観測されている。これらは表面的には異なるバグに見えるが、同じ根に由来する。

- **wait/idle race**: `copilotclaw_wait` で待機中のセッションが意図せず idle に遷移する。agent 側の keepalive（`packages/agent/src/tools/channel.ts` の `waitForPendingNotify` タイムアウトサイクル）と gateway 側の主たる idle 検知（`packages/gateway/src/daemon.ts:241-244` の `case "session.idle"` で `sessionController.onSessionIdle()` を呼ぶ経路）が独立に判断しており、どちらが「生きているか」の判断者なのか不明確。daemon.ts:311-324 は backgroundTasks がある場合に `agentManager.notifyAgent()` で補助的な通知を行う別経路であり、主たる idle 遷移の起点は 241-244 である。agent 側の `packages/agent/src/session-loop.ts` は keepalive を担わず、`BACKGROUND_TASKS_IDLE_TIMEOUT_MS`（30 分）の安全弁タイムアウトと真の idle 検知（`hasBackgroundTasks=false` の場合に resolve）を担っている
- **double-start race**: commit `fix double-start race` が示すとおり、`clientStartPromise ??= client.start()` でしか防げていない。根本的な状態機械が存在しない
- **channel status の不在**: `Channel { id, createdAt, archivedAt, model, draft }` に status フィールドがなく、channel の状態は session 経由で逆引きするしかない
- **idleSession ↔ onPhysicalSessionEnded race**: 物理セッション終了の通知と idle 遷移が競合する
- **`copilotSessionId` dead field** — v0.79.0 で解消済み: DB schema migration v3→v4 で `copilotSessionId` を `physicalSessionId` にリネーム。gateway の全 callsite を修正し、resume path が正しく機能するようになった
- **`generation` dead field**: `PhysicalSessionEntry.generation` が定義されているが参照箇所なし
- **`isReconciled()` dead code**: 定義されているが production で一度も呼ばれない
- **daemon.ts の observability 系 orchestrator 直接呼び出し** — v0.79.0 で解消済み: SessionController に `onUsageInfo` / `onAssistantUsage` / `onModelChange` / `onSubagentStarted` / `onSubagentStatusChanged` の 5 委譲メソッドを追加し、daemon.ts が SessionController 経由で orchestrator を操作するよう変更。直接呼び出し 6 箇所を削除
- **send queue の ACK なし** — v0.79.0 で解消済み: `pendingAckIds: Set<string>` + `_queueId` 自動付与、flush 後ディスク即削除を廃止し ACK 待ちに変更、gateway からの `message_acknowledged` IPC 受信後にディスク削除。agent 側責務として合理的と判定し実装
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
| SessionOrchestrator | v0.81.0 で解消済み: 直接 mutate メソッド 11 個を全削除。`applyWorldState()` が唯一の書き込み経路 |
| SessionController | v0.80.0-v0.81.0 で解消済み: `transition()` / `broadcastStatusChange()` / `VALID_TRANSITIONS` を削除。daemon.ts の observability 系直接 mutate 6 箇所も v0.79.0 で SessionController 委譲メソッドに移行済み。全状態変更が `dispatchEvent()` → reducer → `applyWorldState()` を経由 |
| Channel binding | v0.82.0 で部分解消: Channel subsystem reducer 導入（`channel-events.ts` / `channel-reducer.ts`）。backoff を含む ChannelWorldState を管理。Channel.status フィールドは非追加（DerivedChannelStatus が射影で担う） |
| 保留メッセージキュー | v0.82.0 で reducer 化済み（`pending-queue-events.ts` / `pending-queue-reducer.ts`）。drain の 2 系統を `DrainStarted` / `DrainCompleted` sequence に統一。`drainInProgress=true` の間は重複 drain を拒否 |
| channelBackoff | v0.82.0 で解消済み: `channel_backoff` テーブル（store.db schema v6→v7）で永続化。`persistChannelBackoff` / `clearChannelBackoff` / `loadChannelBackoffs()`。`SessionOrchestrator` 起動時に DB から復元するため、gateway 再起動後もバックオフ状態が保持される |
| SSE broadcaster | v0.82.0 で reducer 化済み（`sse-broadcaster-events.ts` / `sse-broadcaster-reducer.ts`）。channel / global 各スコープに replay buffer（`SSE_REPLAY_BUFFER_SIZE=100`）を追加。`ClientConnected` 時に missed events を replay |
| SQLite 永続化層 | v0.81.0 で解消済み: observability 系 mutation は reducer → `applyWorldState()` → `persistSession()` 経由。`copilotSessionId` dead field は v0.79.0 で `physicalSessionId` にリネーム（schema migration v3→v4）済み |
| HTTP in-flight | 追跡なし（明示的設計対象外。現状と同様） |

### Agent 側

| subsystem | 現状の問題 |
|-----------|-----------|
| PhysicalSessionEntry | v0.81.0 で解消済み: `PhysicalSessionEntry.info` を `worldState: PhysicalSessionWorldState` に置き換え。`applyWorldState()` / `dispatchPhysicalEvent()` / `derivePublicStatus()` を追加。world/process 分離完了 |
| CopilotClient singleton | v0.80.0 で reducer 導入済み（agent `session-reducer.ts` の `reduceCopilotClient`）。double-start 防止ロジックが状態機械として明示化。`CopilotClientWorldState.status` 管理 |
| reinject 状態 | v0.81.0 で解消済み: `reinjectCount` を `worldState.reinjectCount` 経由に統一。`generation` dead field は v0.80.0 で削除済み |
| AbortController 群 | v0.81.0 で分離済み: process state (`PhysicalSessionProcessState`) に分離。abort は `dispatchPhysicalEvent(StopRequested)` 経由 |
| in-flight tool call | 部分対応: `PhysicalSessionWorldState.currentToolName` フィールドを追加（`ToolExecutionStarted` / `ToolExecutionCompleted` で更新）。gateway 側の現在ツール追跡も同様に reducer で管理 |
| resolvedModel | v0.81.0 で統合済み: `PhysicalSessionWorldState.resolvedModel` に組み込み。`session.setModel()` は `SessionCreated` event 後に命令型コードが呼ぶ |

### IPC / cross-cutting

| subsystem | 現状の問題 |
|-----------|-----------|
| pending RPC | v0.82.0 で reducer 化済み（`ipc-reducers.ts` の `reduceRpc`）。`RpcState { pendingRequests, connectionStatus }` で状態管理。`ConnectionLost` で全 pending を reject、`ConnectionRestored` で `ReplayPendingRequests` を発行 |
| event ordering | Unix socket FIFO 依存（未変更）。RPC subsystem の FIFO request queue で subsystem 内 ordering は保証 |
| reconnection | 未変更。`ConnectionLost` / `ConnectionRestored` event を SendQueue / RPC の両 reducer が共有。reconnection ロジック自体は effect runtime が担う |
| send queue | v0.79.0 で ACK プロトコル実装済み。v0.82.0 で reducer 化済み（`ipc-reducers.ts` の `reduceSendQueue`）を production code に接続。`Initialized` event（startup disk 復元）含む全 event パスが reducer 経由に |
| config push | v0.82.0 で設計判断: reducer 不採用。10 行未満のシンプルな命令型実装が適切。詳細は「ConfigPush subsystem」節を参照 |
| copilotSessionId 整合 | v0.79.0 で解消済み: gateway 側 DB を `physicalSessionId` にリネーム（schema v3→v4）。全 callsite 修正。resume path が正しく機能するようになった |

---

## subsystem ごとの設計

### Gateway: AbstractSession subsystem

**現状（v0.80.0-v0.81.0 実装済み）**

`AbstractSessionStatus = "new" | "starting" | "waiting" | "notified" | "processing" | "idle" | "suspended"` の 7 状態。v0.80.0 で reducer 導入（gateway `session-reducer.ts` の `reduceAbstractSession`、47 unit tests）、v0.81.0 で `applyWorldState()` が唯一の書き込み経路として確立済み。以下の「新設計」は v0.80.0 以前の問題と設計意図の記録として保持する。

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

**現状（v0.82.0 実装済み）**

`Channel { id, createdAt, archivedAt, model, draft }` — status フィールドなし（DerivedChannelStatus が射影で担う設計）。v0.82.0 で reducer 導入済み（`channel-events.ts` / `channel-reducer.ts`）。`ChannelWorldState { channelId, archivedAt, model, draft, backoff }` + `BackoffState { failureCount, nextRetryAt, lastFailureReason }` を管理。`SessionStartFailed` で exponential backoff（5 分上限）計算 + `PersistBackoff` command 発行。`channel_backoff` テーブル（store.db schema v6→v7）で永続化済み。

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

**現状（v0.82.0 実装済み）**

v0.82.0 で reducer 導入済み（`pending-queue-events.ts` / `pending-queue-reducer.ts`）。`PendingQueueState { channelId, messages, drainInProgress, lastDrainedAt }` を管理。drain 2 系統を `DrainStarted` / `DrainCompleted` / `DrainAcknowledged` sequence に統一。`drainInProgress=true` の間は重複 drain を拒否。`MessageEnqueued` で id 重複チェック。以下は問題記録と設計意図の保持。

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

**現状（v0.82.0 実装済み）**

v0.82.0 で reducer 導入済み（`sse-broadcaster-events.ts` / `sse-broadcaster-reducer.ts`）。`reduceChannelSse`（per-channel replay buffer）と `reduceGlobalSse`（global replay buffer）の 2 reducer。`SSE_REPLAY_BUFFER_SIZE=100`。`ClientConnected` 時に `SendReplayEvents` command で missed events を replay。以下は既存の設計記録（v0.75.0 時点からの参照）。

`clients = new Set<SseClient>()`、ephemeral、missed events の replay なし。

`SseClient` は `scope: { type: "channel"; channelId: string } | { type: "global" } | { type: "session"; sessionId: string }` のスコープ分離済み。エンドポイントは 3 本:
- `/api/events?channel=...` — channel-scoped（`addChannelClient`）
- `/api/global-events` — global-scoped（`addGlobalClient`、v0.72.0 で新設）
- `/api/sessions/:id/events/stream` — session-scoped（`addSessionClient`、v0.74.0 で新設）

`broadcastAll()` は存在しない（v0.72.0 で削除済み）。`broadcast()` は deprecated 互換実装として残存（channelId ありの場合は `broadcastToChannel` に委譲、なしの場合は no-op）。

実際に SSE 送信されている event 型:
- `new_message` — channel-scoped
- `session_status_change` — channel-scoped（v0.68.1 で frontend 受信・処理を実装済み。`event.data.status` で `setSessionStatus` を更新する）
- `agent_status_change` — global-scoped（v0.72.0 で新設。daemon の agent monitor が変化検知時に `broadcastGlobal` 送信）
- `agent_compatibility_change` — global-scoped（v0.72.0 で新設。同上）
- `log_appended` — global-scoped（v0.73.0 で新設。`LogBuffer.setOnAppend` hook で wire）
- `session_event_appended` — session-scoped（v0.74.0 で新設。`sessionEventStore.setOnAppend` hook で wire）
- `token_usage_update` — global-scoped（v0.75.0 で新設。`sessionEventStore.setOnAppend` hook の `assistant.usage` 分岐で 5h ウィンドウ集計を broadcast）

`status_update` dead sink は v0.72.0 で frontend handler ごと削除済み。

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
// 実装済み型のみ sse-broadcaster.ts の GlobalSseEvent union に存在する。
// 「（未実現）」マーカーの付いた型は設計上の将来計画であり、まだ実装されていない。
type GlobalSseEvent =
  | { type: "gateway_status_change"; version: string; running: boolean }      // 実装済み
  | { type: "agent_status_change"; version: string | undefined; running: boolean }  // 実装済み
  | { type: "agent_compatibility_change"; compatibility: "compatible" | "incompatible" | "unavailable" }  // 実装済み
  | { type: "channel_list_change"; channels: Channel[] }                       // v0.76.0 実装済み
  | { type: "config_change" }                                                 // （未実現）
  | { type: "system_status_change" }                                          // （未実現）
  // ポーリング置換のために追加される event 型
  | { type: "log_appended"; entries: LogEntry[] }                 // GET /api/logs 3s ポーリングの置換（v0.73.0 実装済み）
  | { type: "quota_update"; quota: QuotaInfo }                     // GET /api/quota 5s ポーリングの置換（未実現）
  | { type: "models_update"; models: ModelInfo[] }                 // GET /api/models 5s ポーリングの置換（未実現）
  | { type: "token_usage_update"; summary: TokenUsageSummary }     // GET /api/token-usage ポーリングの置換（v0.75.0 実装済み）

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
- `channel_list_change` — チャンネルの追加・アーカイブ・変更（v0.76.0 実装済み）
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

**frontend 設計（v0.72.0 で部分実現）**

- `DashboardPage` は 2 本の `EventSource` を管理する（アクティブチャンネル用 channel-scoped + global）— v0.72.0 で実現済み
- グローバル情報を表示するページは global `EventSource` のみ使用する — v0.72.0 で実現済み（`DashboardPage` / `StatusPage` ともに `/api/global-events` を subscribe）
- ポーリングで実装されている gateway/agent status・ログ・session event 等の定期取得は SSE 受信に置き換えた後に削除する — gateway/agent status は v0.72.0 で解消済み。ログ・session event のポーリングは未実現

**ポーリング置換対象（網羅リスト）**

以下は現時点で frontend が定期取得に使用しているポーリングと、それぞれの置換先 SSE スコープの設計判断である。

| ページ | ポーリング対象 API | 間隔 | 置換先 SSE | 置換方針 |
|---|---|---|---|---|
| `DashboardPage` | `GET /api/status` | ~~5s~~ | global SSE | **v0.72.0 で解消済み**。初回マウント時の snapshot fetch（gateway version 取得）+ `/api/global-events` の `agent_status_change` / `agent_compatibility_change` 受信で更新。周期ポーリングは削除済み |
| `DashboardPage` | `GET /api/logs` | ~~3s（Logs パネル表示中のみ）~~ | global SSE | **v0.73.0 で解消済み**。`LogBuffer.setOnAppend` フックで `broadcastGlobal({ type: "log_appended", entries: [entry] })` を wire。`DashboardPage` は `logsVisible` 変化時に one-shot snapshot fetch + SSE `log_appended` 受信でリアルタイム更新。周期ポーリングは削除済み |
| `StatusPage` | `GET /api/status` | ~~5s~~ | global SSE | **v0.72.0 で解消済み**。`DashboardPage` と同様に初回 snapshot + `/api/global-events` 受信に置き換え済み |
| `StatusPage` | `GET /api/quota` | 5s | global SSE | 新規 global event `quota_update` を追加し、クォータ情報が更新された時点で broadcast する。`system_status_change` に含めるか独立 event にするかは実装時に決定する（未実現）|
| `StatusPage` | `GET /api/models` | 5s | global SSE | 新規 global event `models_update` を追加する。モデル一覧は変化頻度が低いため、初回接続時の `SendReplayEvents` で最新値を受け取り、変化時のみ更新 event を受信する設計が合理的（未実現）|
| `StatusPage` | ~~`GET /api/token-usage` (5h window) 60s~~ | ~~60s~~ | global SSE | **v0.75.0 で解消済み**。`sessionEventStore.setOnAppend` に `assistant.usage` 分岐を追加し、append 時に 5h ウィンドウ集計を `broadcastGlobal({ type: "token_usage_update", summary })` で配信。StatusPage の SSE onmessage で受信して `tokenUsage5h` を更新。`usePolling(refreshPeriods, 60000)` は削除済み |
| `StatusPage` | 複数期間の `GET /api/token-usage` | ~~60s~~ | one-shot fetch | **v0.75.0 で解消済み**（polling 廃止）。`refreshPeriods` は初回マウント時に 1 度だけ呼び出す。期間別 tokenUsagePeriods の SSE リアルタイム更新は別 scope |
| `SessionEventsPage` | ~~`GET /api/sessions/{sessionId}/events` 2s~~ | ~~2s~~ | session-scoped SSE | **v0.74.0 で解消済み**。`/api/sessions/{sessionId}/events/stream` SSE エンドポイントを新設し、`sessionEventStore.setOnAppend` フックで `broadcastToSession` を wire。`SessionEventsPage` は EventSource で購読し、`session_event_appended` を受信してリアルタイム追記（id ベース dedup 付き）。周期ポーリングは削除済み |

各ポーリング置換に対応する global event（`log_appended`（v0.73.0 実装済み） / `quota_update` / `models_update` / `token_usage_update`）の型定義は「新設計: SseEvent 型定義」節の `GlobalSseEvent` を参照。

**`SessionEventsPage` の置換方針注記（v0.74.0 で実現済み）**

v0.74.0 で session-scoped SSE を新規追加する方針が採用・実装された。`/api/sessions/{sessionId}/events/stream` エンドポイントを新設し、`SseClientScope` に `{ type: "session"; sessionId: string }` スコープを追加。`sessionEventStore.setOnAppend` フックで `broadcastToSession(sessionId, { type: "session_event_appended", event })` を wire。`SessionEventsPage` は EventSource で購読し、id ベース dedup でリアルタイム追記する。周期ポーリングは削除済み。

channel-scoped SSE を拡張する案（`channel_timeline_event`）は DashboardPage のタイムライン UI 向けに別途残存する設計とし、raw session event stream は session-scoped SSE で配信する方針が確定した。

**session-scoped SSE の Last-Event-ID reconnect replay 設計（v0.77.0 実装済み）**

channel / global の replay は SSE broadcaster の in-memory replay buffer 設計（`ChannelScopedSseStatePerChannel.recentEvents` / `GlobalSseState.recentEvents`）を使うが、session-scoped SSE は SSE broadcaster の actor model とは独立した簡易設計として実装した。理由: session event は既に `SessionEventStore` の DB に永続保存されており、追加の in-memory buffer を持たなくてよいため。

実装済みの要素:

- **`SessionEventStore.listEventsAfterId(sessionId, afterId, limit?)`**: 指定した物理セッション ID に属する event のうち、`id > afterId` となるものを昇順に `limit` 件以内で返す（`SESSION_REPLAY_LIMIT=500` で頭打ち）。`afterId` が有限でない場合は空配列を返す

- **SSE frame の `id:` line**: `sse-broadcaster.ts` に `formatSessionSseFrame(event)` を export し、`event.event.id` が定義されている場合に `id: <id>\n` line を付与する。`broadcastToSession` はこの関数を使い format drift を防ぐ。`event.event.id` が undefined の場合は id line なしのフォールバック

- **`session-replay.ts`**: `replaySessionEventsAfter(res, sessionId, afterId, sessionEventStore)` を実装。接続直後に `res.write()` で直接書き込むことで reconnect client のみが catch-up を受け取る。daemon.ts から re-export されるためテストは daemon.ts からの import で動作する

- **catch-up 配信の流れ**: `/api/sessions/:id/events/stream` endpoint で `sseBroadcaster.addSessionClient(res, sessionId)` の後に `Last-Event-ID` header を parse し、有効な数値なら `replaySessionEventsAfter` を呼ぶ。その後は通常の `broadcastToSession` 経由の push が継続する

- **`SessionEventsPage` の dedup との整合**: `SessionEventsPage` は `processedIds: Set<number>` で受信済み event ID を追跡し、重複を排除する実装が v0.74.0 時点で存在する。replay による重複配信はこの dedup ロジックで frontend 側が吸収するため、replay と通常 push の競合は問題にならない

- **SSE broadcaster との関係**: session-scoped SSE の catch-up は SSE broadcaster を経由せず、`session-replay.ts` の関数が直接 `SessionEventStore` に query して送信する独立した実装とした。これにより channel / global の replay buffer 設計への影響を与えない

### Agent: PhysicalSession subsystem

**現状（v0.80.0-v0.81.0 実装済み）**

v0.80.0 で reducer 導入（agent `session-reducer.ts` の `reducePhysicalSession`、26 unit tests）、v0.81.0 で `PhysicalSessionEntry.info` を `worldState: PhysicalSessionWorldState` に置き換え完了。`generation` dead field は v0.80.0 で削除済み。以下は問題記録と設計意図の保持。

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

**設計判断: agent 側 reducer の command は破棄する（二層構造）**

agent 側の `dispatchPhysicalEvent()` は reducer の `commands` 出力を意図的に破棄する。理由:

- **agent は薄く保つ原則**: gateway 側には effect runtime（`effect-runtime.ts`）という副作用実行層を持つが、agent 側に同等の重い実行層を追加することは「agent は薄く」設計方針に反する。
- **副作用は既存命令型コードが担う**: `attachSessionLifecycle()` / `runSession()` の命令型コードが実際の副作用（session 作成・abort・lifecycle 通知等）を実行する。reducer はその状態遷移が正しいことを保証する純関数として機能し、命令型コードは reducer の `newState` を読んで判断する。
- **状態遷移の正確性は保証される**: 副作用の実行タイミングは命令型コードが制御するが、状態モデルの整合性（どの状態からどの状態へ遷移可能か、どのフィールドをどう更新するか）は reducer が唯一の真実源として保証する。

command 型定義（`PhysicalSessionCommand`）は将来 agent 側 effect runtime を導入する際の blueprint として残す。現時点では型定義のみ存在し、production code から実行されることはない。

### Agent: CopilotClient singleton subsystem

**現状（v0.80.0 実装済み）**

v0.80.0 で reducer 導入（agent `session-reducer.ts` の `reduceCopilotClient`）。`CopilotClientWorldState { status: CopilotClientStatus }` で状態管理。double-start 防止が状態機械として明示化。以下は問題記録と設計意図の保持。

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

**現状（v0.79.0-v0.82.0 実装済み）**

v0.79.0 で ACK プロトコル実装済み。v0.82.0 で reducer（`ipc-reducers.ts` の `reduceSendQueue`）を production code に接続済み。`Initialized` event による startup disk 復元、`FlushStarted` / `MessageAcknowledged`（全 ACK で `ClearDisk`）、`ConnectionLost` / `ConnectionRestored` の全パスが reducer 経由。以下は問題記録と設計意図の保持。

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

**現状（v0.82.0 実装済み）**

v0.82.0 で reducer（`ipc-reducers.ts` の `reduceRpc`）を production code に接続済み。`RpcState { pendingRequests: PendingRequestMetadata[], connectionStatus }` で状態管理。`RequestSent` / `ResponseReceived` / `RequestTimedOut` / `ConnectionLost`（全 pending reject）/ `ConnectionRestored`（`ReplayPendingRequests`）の全パスが reducer 経由。以下は問題記録と設計意図の保持。

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

**現状（v0.82.0 設計判断: reducer 不採用）**

gateway 接続時に 1 度だけ config を agent に送信する。動的更新は `AgentManager.setConfigToSend()` が stream 接続済みであれば即時送信、未接続であれば `configToSend` フィールドに保持して接続時に送信するシンプルな命令的実装。

**設計判断: ConfigPush reducer は不採用（dead code を削除）**

当初、本提案では reducer 化を計画し `ipc-reducers.ts` / `ipc-events.ts` に型定義・reducer 実装を追加した（v0.82.0）。しかし調査の結果、以下の理由により reducer 化を見送り、実装を削除した。

- **state management が 1 メソッドで完結している**: `AgentManager.setConfigToSend(config)` が gateway 側の唯一の呼び出し元であり、接続済みなら即送信・未接続なら `configToSend` フィールドに保持して接続時送信という 2 パスが 10 行未満のコードで完結している。reducer を挟んでも state の遷移パターンが増えるだけで複雑性が下がらない。
- **package 依存方向の制約**: ConfigPush reducer を production の送受信パスに wiring しようとすると、gateway 側 `AgentManager` が agent 側 `ipc-reducers.ts` を import する逆依存が生じる（`packages/gateway` → `packages/agent`）。これは既存のパッケージ依存制約に反するため、gateway 側に reducer を移動する選択肢も取れない。
- **dead code**: 実装した reducer は production code から一度も呼ばれず、unit test のみで参照されていた。dead code を残すことは Intent-First Governance の「メカニズムが Contract を汚染しない」原則に反する。

**現在の実装 (`packages/gateway/src/agent-manager.ts`)**

```typescript
setConfigToSend(config: Record<string, unknown>): void {
  this.configToSend = config;
  if (this.stream !== null && this.stream.isConnected() && this.configToSend !== null) {
    this.stream.send({ type: "config", config: this.configToSend });
  }
}
// stream "connected" event: if (this.configToSend !== null) this.stream.send(...)
```

この実装で ConfigPush の要件（接続時初回 push + 動的更新）は満たされている。将来、ConfigPush の複雑性が増す（例: retry、versioning、部分更新）場合は、gateway 側に独立した reducer を設計することを検討する。

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

`docs/proposals/status.md` の未実現項目との対応（v0.79.0 更新済み）:

| status.md 未実現項目 | 本 proposal での扱い / 実現状況 |
|--------------------|-------------------------------|
| gateway 側の copilotSessionId → physicalSessionId 統一 | v0.79.0 で実現済み（DB schema migration v3→v4、全 callsite 修正） |
| gateway 停止時の情報無損失（SendQueue ACK プロトコル） | 設計 TODO（保留中）。agent 側か gateway 側か設計判断未確定。将来課題として残置 |

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

**v0.79.0 で実現済み**:
- `waitingOnWaitTool: boolean` — `AbstractSessionState` に追加済み。`onToolExecutionStart("copilotclaw_wait")` で `true`、`onToolExecutionComplete()` でリセット。selector が `waitingOnWaitTool` を使用した正確な idle 遷移ブロックを実現
- `hasHadPhysicalSession: boolean` — `AbstractSessionState` に追加済み。`updatePhysicalSession()` 呼び出し時に `true` に設定。selector が `physicalSessionHistory.length > 0` 代替として使用

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

**v0.79.0 で実現済み**:

agent 側の `physical-session-manager.ts` の session キャッチオールが SDK イベントの `parentId` を outer IPC wrapper に引き上げて含めるよう修正した。gateway 既存の `msg["parentId"]` フィルタが正しく機能するようになり、`data["parentToolCallId"]` と `msg["parentId"]` の 2 経路でフィルタリングが機能する（二重防御）。

実装済みの IPC プロトコル:

```typescript
// v0.79.0 実装済み: session キャッチオールで parentId を outer wrapper に引き上げ
// { type: "session_event", sessionId, parentId: sdkEvent.parentId, event: sdkEvent }
// (parentId は string かつ length > 0 のときのみ含める)
```

### メッセージ sender 識別の設計（v0.78.0 で部分実現）

**v0.78.0 実装済みスキーマ**

`Message.sender` フィールドは後方互換のまま維持し、`Message.senderMeta` フィールドを追加。

```typescript
// 既存（後方互換維持）
sender: "user" | "agent" | "cron" | "system"

// v0.78.0 追加（agent メッセージのみ設定）
senderMeta?: {
  agentId: string;
  agentDisplayName: string;
  agentRole: "channel-operator" | "worker" | "subagent" | "unknown";
}
```

DB migration v4→v5 で `messages.senderMeta TEXT` カラムを追加（JSON シリアライズ）。既存 agent 行はデフォルト channel-operator meta で backfill 済み。

**v0.78.0 sender 特定ロジック**

- `assistant.message` session event の `data.parentToolCallId` で channel-operator / subagent を判別（`resolveAgentSenderMeta` in `packages/gateway/src/message-sender.ts`）
- `copilotclaw_send_message` ツール呼び出しは channel-operator 固定（subagent はこのツールを持つが、識別は parentToolCallId 経由に限定）
- worker ロールの識別は将来課題（現在は subagent に統一; agentRole = "subagent"）

**未実現（将来課題）**

- worker と sub-worker の区別（SDK の task tool インターフェース分析が前提）
- sub-subagent の parentToolCallId チェーン追跡

#### task tool インターフェース分析と agent 命名戦略（将来課題）

SDK の Task tool（subagent を呼び出すツール）のインターフェースを把握し、かつシステムプロンプトを工夫することで、agent ごとに異なる名前を割り当てる設計が必要である。v0.78.0 では `assistant.message` の `parentToolCallId` + `orchestrator.subagentSessions` による自動識別で channel-operator / subagent の 2 種を区別するに留まる。

**候補となる設計アプローチ（将来）**

- **sdk-tool-arg**: Task tool の引数として `agent_name` / `display_name` を渡す設計
- **session-event-tracking**: session event の tool call event から subagent の identity を特定する設計（v0.78.0 で部分実現）
- **self-declared-naming**: システムプロンプトで agent に自身の名前を認識させる設計

### UI 設計方針（v0.78.0 で部分実現）

**タイムライン UI の統一ストリーム設計（将来課題）**

チャンネルのタイムライン UI を「メッセージ + 非メッセージイベント」の統一ストリームとして扱う設計は将来課題のまま。

```typescript
// 将来課題
type TimelineEntry =
  | { entryType: "message"; message: Message }
  | { entryType: "turn-run-started"; sessionId: string; timestamp: string }
  | { entryType: "turn-run-ended"; sessionId: string; timestamp: string; reason: string }
  | { entryType: "subagent-started"; toolCallId: string; agentName: string; agentDisplayName: string; timestamp: string }
  | { entryType: "subagent-lifecycle"; toolCallId: string; agentName: string; status: "idle" | "completed" | "failed"; timestamp: string }
```

**エージェントアイコン・プロフィールモーダル（v0.78.0 実現済み）**

- 各メッセージに `MessageAvatar` コンポーネント（`packages/gateway/frontend/src/components/MessageAvatar.tsx`）でアイコン + 表示名を表示
- agent アイコンをクリックすると `ProfileModal` コンポーネント（`packages/gateway/frontend/src/components/ProfileModal.tsx`）が開く（agentId、agentRole の Info タブ + Intent タイムライン placeholder タブ）
- 連続した `agentRole === "subagent"` メッセージ（同 agentId）は `<details>` グループに collapse 表示

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
