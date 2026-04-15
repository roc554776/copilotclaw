# 要求定義: チャンネルステータス・イベント抽象化・エージェント識別

本ファイルは `docs/raw-requirements/channel-status-and-events-redesign.md`（2026-04-14 ブロック）に記録された利用者要望を構造化した要求定義である。

関連ファイル:
- `docs/requirements/channel.md` — チャンネル基本要求
- `docs/requirements/custom-agents.md` — Custom Agents 要求
- `docs/proposals/state-management-architecture.md` — 実装設計

---

### Req: チャンネルの表示用ステータス定義（v0.71.0 で部分実現）

チャンネルの内部状態（abstract session / physical session / turn run / CopilotClient の複合状態）を、表示用の排他的な enum 値に射影する。

- 射影対象の内部状態の組み合わせは複雑であるが、表示上は 1 チャンネルにつき 1 つの排他的なステータスが確定する
- ステータスはユーザーにとって便利な情報を提供する設計である
- ステータスバーの表示形式は「選択中のチャンネル名 + そのステータス」を明示する形が望ましい

定義する表示用ステータス enum の値:

| ステータス値 | 意味 |
|---|---|
| `client-not-started` | SDK client が起動していない（全チャンネル共通の状態）|
| `no-physical-session-initial` | 初回なので当該チャンネルに対応する physical session が存在しない（abstract session は常に存在する）|
| `no-physical-session-after-stop` | physical session の強制停止後なので physical session が存在しない（普段は前回の physical session を引き継ぐためこの状態は珍しい。abstract session は常に存在する）|
| `idle-no-trigger` | physical session はあるが turn run が開始されておらず、起動トリガーとなるイベントも発生していない |
| `pending-trigger` | turn run 未開始だが起動トリガーとなるイベントが発生している状態（ここから turn run が開始される想定）|
| `running` | turn run が開始されており、copilotclaw_wait で待機中ではない（wait の待ち状態が解除され稼働中の状態を含む）|

- `no-physical-session-initial` と `no-physical-session-after-stop` は両方 physical session が存在しないが、意味が異なるため区別する
- 上記 enum 値は導出値であり、Channel subsystem の world state に直接書き込まれる値ではない。abstract session status・physical session の有無・turn run 状態・CopilotClient status の組み合わせから導出される（導出の具体的な実装方法は proposal に委ねる）

v0.71.0 で実現した部分:
- `DerivedChannelStatus` 型定義（6 値）と `selectDerivedChannelStatus` 純関数（`channel-status-selector.ts`）を実装
- `session-controller.ts` の `broadcastStatusChange` で selector を呼び、SSE event data に `derivedStatus` を付与
- `DashboardPage.tsx` で `session_status_change` 受信時に `derivedStatus` を優先表示

未実現のまま:
- `client-not-started` 状態（CopilotClient 観測経路）— selector は `clientStarted = true` を固定仮定。CopilotClient の起動状態を観測する経路が未実装のため、この値は実際には返されない

### Req: イベント抽象化（未実現）

channel operator が知覚すべき入力を「メッセージ」に一本化せず、有限列挙されたイベント型として整理する。

- 現状は全ての入力をメッセージとして処理しており、sender フィールド等でメッセージの意味を区別しているため、コードが複雑になっている
- メッセージイベントは「チャンネルにメッセージが届いた」という 1 種別に過ぎない
- メッセージ以外に channel operator が知覚すべきイベントが存在する（サブエージェント完了、keepalive timeout、turn run 開始・終了 など）
- `copilotclaw_wait` の返却値は、メッセージ以外に多様なイベント型が返却される構造に変更する（具体的な型定義は proposal に委ねる）
- channel operator の判断ロジックがイベント型の分岐として明確に記述できるようになること

### Req: ネスト subagent 完了通知の抑制

`docs/requirements/custom-agents.md` の「Req: ネスト subagent 完了通知の抑制」を参照。本ファイルの single source of truth は `custom-agents.md` である。

### Req: メッセージ sender 識別（未実現）

チャンネルのタイムラインに表示されるメッセージに、送信者（sender）を正確に識別する情報を付与する。

- 現状: `sender` フィールドは `"user" | "agent" | "cron" | "system"` の 4 値。`"agent"` はどの agent が送ったかを区別しない
- `copilotclaw_send_message` を呼び出した agent が channel-operator なのか subagent なのか sub-subagent なのかを区別できるようにする
- hooks は親エージェント（channel-operator）にしか機能しないため、hooks を使って subagent/sub-subagent の sender を特定することは困難
- session event の tool call event を利用することで、subagent/sub-subagent が `copilotclaw_send_message` を呼び出した記録を拾える可能性がある（session event が subagent/sub-subagent のイベントも拾えるか要検証）
- agent は id と表示名（display name）を持つため、内部的に区別できる
- 送信者として個別の agent を識別できる（agent の種別・id・表示名による区別）（具体的なスキーマ・型定義は proposal に委ねる）

識別対象（外部観察可能な区別）:
- `user`: ユーザーからのメッセージ
- `agent:channel-operator`: channel-operator agent からのメッセージ
- `agent:worker`: worker subagent からのメッセージ
- `agent` その他: その他の agent（種別・id・表示名で識別）
- `cron`: cron ジョブからのメッセージ
- `system`: system からのメッセージ

### Req: エージェントアイコン・プロフィールモーダル・collapse 表示（未実現）

チャンネルのタイムライン UI において、メッセージ送信者を視覚的に識別できるようにする。

- 各メッセージにアイコン + 表示名を表示する（user / channel-operator / worker / その他 agent の種別ごとにデザインを変える）
- agent アイコンをクリックすると、プロフィールモーダルが開く
  - プロフィールモーダルに表示する情報: agent タイプ、モデル名、ステータス（session event で確認できる範囲）
- subagent / sub-subagent からのメッセージはデフォルトで折り畳み（collapse）表示し、必要に応じて展開できるようにする
- task tool（subagent を呼び出すツール）のインターフェースとシステムプロンプトの工夫により、agent ごとに異なる表示名が割り当てられるようにする

### Req: チャンネルタイムライン UI の非メッセージ要素（未実現）

チャンネルのタイムライン UI には、メッセージ以外のイベントも表示する。

- turn run の開始・停止イベントをタイムライン上に表示する
- subagent / sub-subagent の開始・idle・停止等のライフサイクルイベントをタイムライン上に表示する
- これらの非メッセージ要素は、メッセージとは視覚的に区別して表示する（例: システムイベントとしてスタイルを変える）
- タイムライン UI を「メッセージ + 非メッセージイベント」の統一ストリームとして扱う設計にする

### Req: copilotclaw_intent tool（v0.70.0 で部分実現）

agent が何をしようとしているのかをチャンネルに伝えるための専用 tool を追加する。

v0.70.0 で実現した部分:
- tool 名: `copilotclaw_intent`（toolDefinitions に追加済み）
- 他のツールと同時に呼び出す設計（単独呼び出し禁止のシステムプロンプト制約を channel-operator / worker の両方に付与済み）
- channel-operator と worker の両方への付与（copilotclawTools に追加済み）
- gateway 側 handler（`handleIntentToolCall`）で受信し、in-memory IntentsStore に記録

未実現のまま:
- intent のタイムライン表示（agent のプロフィールモーダル内での時系列表示）— UI 未実装
- `GET /api/channels/:channelId/intents/:agentId` API エンドポイント — 未実装
- SQLite 永続化（intents テーブル）— 未実装
- GitHub Copilot の intent 機能と同様のコンセプト

### Req: SSE による channel 情報のリアルタイム配信（未実現）

チャンネルのメッセージ・イベントステータス等、チャンネル別の情報は SSE で push 配信される。

- チャンネル別 SSE エンドポイントを通じて、そのチャンネルに関係するイベントをリアルタイムに受信できる
- frontend は SSE を受信してチャンネル表示を即時更新する（ポーリングに依存しない）
- チャンネルのステータス変化（セッション状態・turn run 状態等）は、変化が生じた時点で即座に画面に反映される
- session event のページも同様に、新着イベントがポーリングなしでリアルタイムに表示される
- ポーリング由来の更新遅延が発生しない

v0.68.1 で部分実現: `session_status_change` SSE event の frontend 受信・処理を実装した（`DashboardPage` の SSE onmessage handler に分岐を追加し、`event.data.status` で `setSessionStatus` を更新）。SSE エンドポイント分離・ポーリング置換は未実現のまま。

v0.74.0 で追加実現: session event ページのリアルタイム化（`/api/sessions/:id/events/stream` session-scoped SSE エンドポイント新設、`SessionEventsPage` の EventSource 購読とポーリング削除）。

### Req: グローバル情報のための専用 SSE（v0.72.0 で部分実現）

チャンネル固有でない情報（gateway/agent バージョン、compatibility、system status、channel list、config 等）は専用の global SSE エンドポイントで push 配信される。

- channel-scoped SSE とは別に、global SSE エンドポイントを設ける
- gateway status / agent status / compatibility / config 変更等のグローバルイベントを push 配信する
- グローバル情報を表示する画面では、状態変化が生じた時点で即座に画面に反映される（ポーリング由来の遅延が発生しない）
- グローバル情報の表示は global SSE のみに依存する（ポーリングを使用しない）

v0.72.0 で実現した部分:
- `/api/global-events` エンドポイント新設（`builtin-chat-channel.ts`）
- `agent_status_change` / `agent_compatibility_change` の global SSE push（daemon の agent monitor が変化検知時に `broadcastGlobal` 送信）
- `DashboardPage` / `StatusPage` が `/api/global-events` を subscribe し、上記 event 受信で UI 更新

v0.73.0 で追加実現:
- `log_appended` global event（`LogBuffer.setOnAppend` フックで `broadcastGlobal` を wire。`DashboardPage` の `log_appended` 受信処理と `logsVisible` 変化時の one-shot snapshot fetch）

v0.74.0 で追加実現（補足 — primary scope は global だが同インフラを session scope にも拡張）:
- `SseClientScope` に `{ type: "session"; sessionId: string }` スコープを追加し、`addSessionClient` / `broadcastToSession` / `SseSessionEvent` を実装。`sessionEventStore.setOnAppend` フックで session-scoped broadcast を wire。global SSE とは独立したエンドポイント（`/api/sessions/:id/events/stream`）として提供

v0.75.0 で追加実現:
- `token_usage_update` global event を新設。`sessionEventStore.setOnAppend` の `assistant.usage` 分岐で 5h ウィンドウ集計を `broadcastGlobal` 送信。StatusPage の SSE handler で受信して `tokenUsage5h` を更新。`usePolling(refreshPeriods, 60000)` は削除済み

未実現のまま:
- `quota_update` / `models_update` / `channel_list_change` / `config_change` 等の global event
- これらに対応する backend broadcast 実装（`quota` / `models` は agent_status_change 受信時に re-fetch する設計であり、元々定期ポーリングは存在しなかった）

### Req: ポーリング依存の解消（v0.72.0 で部分実現）

現状の多くの情報取得がポーリングに依存しており、UI の描画が滑らかでない。SSE による push 型配信に置き換えることで、ポーリングを廃止する。

- gateway/agent status・互換性情報・ログ等はポーリングではなく SSE で取得する（channel-scoped または global の適切なスコープで配信）
- session event の更新もポーリングではなく SSE で受信する
- SSE 移行後はすべての定期ポーリングを削除し、ポーリングに依存する画面更新が存在しない状態にする

v0.72.0 で解消した部分:
- `DashboardPage` の `GET /api/status` 5s ポーリング — 初回 snapshot fetch + `/api/global-events` 受信に置き換え済み
- `StatusPage` の `GET /api/status` 5s ポーリング — 同様

v0.73.0 で解消した部分:
- `DashboardPage` の `GET /api/logs` 3s ポーリング — `log_appended` global SSE + `logsVisible` 変化時の one-shot snapshot fetch に置き換え済み

v0.74.0 で解消した部分:
- `SessionEventsPage` の `GET /api/sessions/{sessionId}/events` 2s ポーリング — `/api/sessions/:id/events/stream` session-scoped SSE エンドポイント新設・`sessionEventStore.setOnAppend` wire・`SessionEventsPage` の EventSource 購読に置き換え済み

v0.75.0 で解消した部分:
- `StatusPage` の `GET /api/token-usage` ポーリング — `token_usage_update` global SSE event 新設・`sessionEventStore.setOnAppend` の `assistant.usage` 分岐で 5h ウィンドウ集計を `broadcastGlobal` 送信・`StatusPage` の SSE onmessage で受信して `tokenUsage5h` を更新。`usePolling(refreshPeriods, 60000)` も削除済み

未実現のまま:
- `StatusPage` の `quota_update` / `models_update` global SSE event — `GET /api/quota` / `GET /api/models` は元々定期ポーリングでなく初回 snapshot fetch のみだが、変化時の push 配信が未実現

### Req: channel operator / worker のツール割り当て整理（v0.69.0 で部分実現）

channel-operator と worker に渡すツールを明示的に定義する。

v0.69.0 で実現した部分（`tools: null` 廃止と明示割り当て）:

- **channel-operator** に渡すツール:
  - 全ビルトインツール（SDK の builtin tool list API で取得）
  - `copilotclaw_wait`
  - `copilotclaw_list_messages`
  - `copilotclaw_send_message`
- **worker** に渡すツール:
  - 全ビルトインツール（SDK の builtin tool list API で取得）
  - `copilotclaw_list_messages`
  - `copilotclaw_send_message`
  - `copilotclaw_wait` は worker に渡さない
- 一部のエージェントで `copilotclaw_*` ツールが割り当てられない現象がある。各エージェントへのツール割り当てを明示的に定義することで解消する（実装方法は proposal に委ねる）

v0.70.0 で追加実現（別候補）:

- `copilotclaw_intent`（追加）— channel-operator と worker の両方への付与。v0.70.0 で tool 定義・gateway handler・copilotclawTools 追加を実現済み
