# 提案: Channel パターン

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
agent ← copilotclaw_wait ← (POST /api/channels/{{channelId}}/messages/pending)
agent → [LLM 処理] → copilotclaw_send_message で途中報告（即時 return）
                         ↓
    POST /api/channels/{{channelId}}/messages → dashboard に表示
agent → copilotclaw_send_message で最終回答 → copilotclaw_wait で次の入力を待機
```

### Messages API の sender フィールド必須化（v0.62.1 で実現済み）

`POST /api/channels/:channelId/messages` で `sender` フィールドが省略された場合、現状は `"agent"` にフォールバックする。全ての正規の呼び出し元は `sender` を明示しているため、省略時のフォールバックに依存しているコードは存在しない。`sender` が省略された場合は 400 エラーを返すように修正する。

変更箇所: `packages/gateway/src/server.ts` の POST messages ハンドラで、`body["sender"]` が `"user"` / `"agent"` / `"cron"` / `"system"` のいずれでもない場合に `400 { error: "missing or invalid 'sender' field" }` を返す。

### チャンネルのアーカイブ（v0.37.0 で実現済み）

不要になったチャンネルを dashboard の通常表示から除外する機能。

**データモデル:**
- channels テーブルに `archivedAt` カラム（TEXT, nullable）を追加する
- `archivedAt` が NULL でないチャンネルはアーカイブ済みとする
- メッセージや pending queue はそのまま保持する（データ削除ではない）

**API:**
- `PATCH /api/channels/{{channelId}}` で `{ "archived": true }` / `{ "archived": false }` を受け付ける
- `GET /api/channels` はデフォルトでアーカイブ済みを除外し、`?includeArchived=true` で全件返す

**Dashboard UI:**
- チャンネルタブ一覧はデフォルトで非アーカイブのチャンネルのみ表示する
- アーカイブ済みチャンネルも含めて表示するトグルまたはモードを設ける
- 各チャンネルタブにアーカイブ操作の UI を設ける

**セッションとの関係:**
- チャンネルをアーカイブしても、紐づく抽象セッションや物理セッション履歴は影響を受けない
- アーカイブされたチャンネルに紐づくセッションは suspended 状態のまま維持される

### Cron 機能（v0.41.0 で実現）

config に定義した定期タスクを、チャンネルへのメッセージ送信として実現する。

**config 設計:**
```json
{
  "cron": [
    {
      "id": "daily-report",
      "channelId": "{{channelId}}",
      "intervalMs": 86400000,
      "message": "日次レポートを作成して報告してください。"
    }
  ]
}
```

- `id`: cron ジョブの識別子（重複排除に使用）
- `channelId`: メッセージを送信するチャンネル
- `intervalMs`: 実行間隔（ミリ秒）
- `message`: チャンネルに送信するメッセージ内容
- `disabled`: ジョブの無効化フラグ（デフォルト: `false`）。`true` に設定するとスケジューラに登録されない。旧 `enabled` フィールド（デフォルト `true`）からの変更（v0.55.0 で実現済み）。変更理由: デフォルトが `true` のフラグはバグの温床になるため、否定形でデフォルト `false` にする
- 動的な config 再読み込みを `cron reload` コマンドで提供する（v0.55.0 で実現済み）

**メッセージモデル:**
- `Message.sender` は `"user" | "agent" | "cron"` の 3 値（v0.41.0 時点）。v0.62.1 で `"system"` が追加され 4 値 `"user" | "agent" | "cron" | "system"` となった。Messages API 節参照
- SQLite の CHECK 制約は v0.41.0 時点では `CHECK(sender IN ('user', 'agent', 'cron'))` だったが、v0.62.1 で `CHECK(sender IN ('user', 'agent', 'cron', 'system'))` に更新された
- cron sender のメッセージも pending queue に追加する（user と同様）

**重複排除:**
- cron メッセージの `message` フィールドに cron job ID をプレフィクスとして含める（例: `[cron:daily-report] 日次レポートを作成して報告してください。`）
- cron メッセージ送信前に、同一 cron job ID のメッセージが pending queue に残っていないか確認する（sender が `"cron"` かつ message が同じ cron job ID プレフィクスで始まるものを検索）
- 残っていれば新しいメッセージは送信しない（stuck 時のメッセージ蓄積を防止）

**セッション起動:**
- gateway の `pending_notify` 送信条件を `sender === "user"` から `sender === "user" || sender === "cron"` に拡張
- agent 側の `pendingHandler` は変更不要（pending_notify を受けて startSession するだけ）

**copilotclaw_wait の対応:**
- drain した pending メッセージに cron sender のものがある場合、レスポンスで sender が cron であることを伝える
- agent が cron タスクとユーザー入力を区別できるようにする

**gateway の cron スケジューラ:**
- daemon.ts で cron ジョブを config から読み込み、`setInterval` でスケジューリングする
- 各 interval で: 重複チェック → メッセージ送信 → pending_notify

**プレミアムリクエスト消費の最小化:**
- `session.send()` を直接呼ばない。チャンネルメッセージとして送信し、`copilotclaw_wait` の tool result として返す
- 物理セッションが生きていれば追加のプレミアムリクエストは不要
- 物理セッションが死んでいる場合のみ、セッション起動で 1 回消費される

### chat operator プロンプトの修正（v0.41.0 で実現）

chat operator のシステムプロンプト（gateway の `agent-config.ts`）に以下を追加する。

**cron タスク対応:**
- cron からタスクが届くことがある旨を記載
- cron タスクは worker subagent に委譲して処理すること

**subagent 利用ルール:**
- subagent 呼び出しでは常に background mode を使うこと
- worker 以外のエージェントを使わないこと

### チャンネルごとのモデル設定（v0.55.0-v0.57.0 で実現済み）

チャンネル単位でモデルを設定する。グローバルの `model` 設定とは独立に、チャンネルごとにモデルを上書きできる。

**config 設計（v0.57.0 で追加）:**
```json
{
  "channels": {
    "{{channelId}}": {
      "model": "gpt-4.1"
    }
  }
}
```

- `channels` はオプショナルフィールド（新規追加のため config schema version 変更不要）
- キーはチャンネル ID、値はチャンネル固有の設定
- config.json が source of truth。gateway 起動時に config の channels 設定を DB に同期する
- API (`PATCH /api/channels/{{channelId}}`) でモデルを変更すると、config.json にも書き戻す
- モデルを null に戻すと、config.json から該当エントリを削除する（空の channels セクションも削除）

**モデル切り替えの動作（未実現）:**
- モデル切り替え（apply ボタン）はあくまで設定値を変えるだけ。turn run を強制停止しない
- turn run が終わるまでは今動いているモデルのまま
- 次回、新しい turn run が始まる時に、現在の設定値のモデルを設定する
- 現状はモデル変更時にセッションが捨てられている

**データモデル:**
- channels テーブルに `model` カラム（TEXT, nullable）を追加する
- `model` が NULL の場合はグローバル設定（`config.model`）に従う（デフォルト）
- `model` が設定されている場合、そのチャンネルの物理セッション起動時にグローバル設定より優先される

**API:**
- `PATCH /api/channels/{{channelId}}` で `{ "model": "gpt-4.1" }` / `{ "model": null }` を受け付ける
- `GET /api/channels` のレスポンスに `model` フィールドを含める

**モデル解決の優先順位:**
- チャンネルの `model` 設定 → グローバルの `config.model` → `resolveModel()` のデフォルト選択
- 設定値と現在の物理セッションのモデルは一致するとは限らない。物理セッション起動時に解決されたモデルが使われ、起動後にチャンネルのモデル設定を変更しても実行中の物理セッションには影響しない

**gateway の `startSessionForChannel` への影響:**
- 物理セッション起動時に、チャンネルの `model` 設定を参照し、`resolveModel()` に渡す `configModel` 引数を上書きする
- チャンネルの `model` が NULL なら従来どおりグローバル設定を使う

### Cron 設定のリロード（v0.55.0 で実現済み）

cron 設定を gateway の再起動なしに動的にリロードする。

**CLI コマンド:**
- `copilotclaw cron reload`: config ファイルから cron 設定を再読み込みし、スケジューラを更新する
- `copilotclaw cron list`: 現在のスケジューラに登録されている cron ジョブの一覧を表示する

**API:**
- `POST /api/cron/reload`: cron 設定をリロードする。gateway 内部で config を再読み込みし、スケジューラを再構築する
- `GET /api/cron`: 現在のスケジューラに登録されている cron ジョブの一覧を返す

**リロード時のタイマー保持:**
- リロード前後で設定に差分がないジョブ（id, channelId, intervalMs, message, disabled の全フィールドが同一）のタイマーはリセットしない
- 新規追加されたジョブのみ新規タイマーを開始し、削除されたジョブのタイマーをクリアし、変更されたジョブのタイマーを再起動する
- 差分比較は cron job の `id` をキーとして行う

**`enabled` → `disabled` フラグ変更との関係:**
- config migration でフィールド名を移行する。`enabled: false` → `disabled: true`、`enabled: true` or 未指定 → `disabled` フィールド省略
- config schema version をインクリメントする

### アーカイブされたチャンネルの cron 無効化（v0.55.0 で実現済み）

アーカイブされたチャンネルに紐づく cron ジョブは、設定値の `disabled` フラグに関係なく無効として扱う。

**スケジューラの動作:**
- cron スケジューラがジョブを評価する際に、対象チャンネルのアーカイブ状態を確認する
- アーカイブ済みチャンネルのジョブはスケジューラに登録しない
- cron reload 時にも同様に、アーカイブ済みチャンネルのジョブをスキップする
- チャンネルのアーカイブ解除後に cron reload すると、ジョブが再登録される

### チャンネル設定モーダル（v0.56.0 で実現済み）

chat 画面のタブの channel ID クリックでチャンネル設定モーダルを開く。

**トリガー:**
- チャンネルタブ内の channel ID テキスト部分をクリックするとモーダルが開く
- タブ全体のクリック（チャンネル切り替え）とは区別する

**モーダルの表示内容と操作:**

- **モデル設定セクション:**
  - 現在の物理セッションのモデルを表示する（読み取り専用。物理セッションが存在しない場合は「なし」）
  - チャンネルのモデル設定値を表示する（「明示設定: {{modelName}}」または「デフォルト」）
  - モデルを選択できるドロップダウン（利用可能モデル一覧 + 「デフォルト」選択肢）
  - モデル変更は `PATCH /api/channels/{{channelId}}` で即時反映

- **物理セッション管理セクション:**
  - 「物理セッションをアーカイブ」ボタン: 現在の物理セッションを停止する
  - 停止後、次回メッセージ時に新しい物理セッションが起動される
  - 過去の物理セッションは抽象セッションの履歴に残る

- **Cron 設定セクション:**
  - 現在のチャンネルに紐づく cron ジョブの一覧を表示する
  - 各ジョブの編集（intervalMs, message, disabled）が可能
  - 新規ジョブの追加が可能
  - ジョブの削除が可能
  - cron 設定の変更時に自動で cron 設定全体をリロードする（`POST /api/cron/reload` を呼ぶ）
  - cron 設定の変更は config ファイルに書き戻す

**API 依存:**
- `GET /api/channels`: チャンネル情報（model 含む）
- `PATCH /api/channels/{{channelId}}`: モデル設定の変更
- `GET /api/status`: 物理セッション情報（現在のモデル）
- `GET /api/models`: 利用可能モデル一覧
- `POST /api/cron/reload`: cron 設定のリロード
- `GET /api/cron`: cron ジョブ一覧
- 物理セッション停止用の新規エンドポイントまたは既存の仕組み（`stop_physical_session` IPC）を利用

### メッセージ消費とセッションステータス管理のバグ修正（v0.64.0 で大部分実現済み。startPhysicalSession ack と IPC reconnect flush 順序は未実現）

メッセージ消費フローとセッションステータス管理に複数のバグが存在する。個別パッチではなく、構造的な設計整理で根本解決する。

**実際に観測されている症状:**
- processing になったまま、メッセージが消費されずにデッドロックすることがある
- 抽象セッションに物理セッションが正しく結びつかなくなることがある

**現状の構造問題:**

- セッションステータスの変更が 14 箇所（daemon.ts / server.ts / session-orchestrator.ts）に分散しており、状態遷移の妥当性が検証されない
- メッセージ到着時のセッション起動が 30秒ポーリング（`checkAllChannelsPending`）に依存しており、POST handler から直接起動できない
- `notifyAgent` が fire-and-forget で配達保証がなく、通知が消えてもフォールバックがない
- pending メッセージの drain パスが 2 系統（copilotclaw_wait tool RPC / drain_pending IPC）あり、swallowed-message 検出との連携が不整合
- daemon.ts のクロージャー内に `pendingReplyExpected` / `lastIdleHasBackgroundTasks` / `reminderStates` 等のセッション単位状態が散在し、ライフサイクル管理がセッション本体と分離している

**対応方針: SessionController の導入**

セッションライフサイクルとメッセージ配達の責務を `SessionController`（新規クラス）に集約する。

```
責務の再配置:
  session-controller.ts（新設）: セッション状態遷移、メッセージ配達、セッション単位の付随状態を一元管理
  session-orchestrator.ts: 永続化層に特化（SQLite への保存・復元のみ。ビジネスロジックを持たない）
  daemon.ts: 配線のみ（コンポーネント作成、IPC ハンドラ登録で SessionController に委譲。状態 Map を持たない）
  server.ts: HTTP ルーティングのみ（メッセージ POST は SessionController.deliverMessage に委譲）
  agent-manager.ts: IPC トランスポートのみ（送受信と配達結果の報告。ビジネスロジックを持たない）
```

**SessionController の主要メソッド:**

- `deliverMessage(channelId, sender, message)` — メッセージ到着の単一エントリポイント。pending 追加 → セッション確保 → agent 通知を一貫して実行する。30秒ポーリングではなく、メッセージ到着が直接セッション起動のトリガーになる
- `onPhysicalSessionStarted(sessionId, ...)` — 物理セッション起動完了時の遷移
- `onPhysicalSessionEnded(sessionId, reason, ...)` — 物理セッション終了時の遷移
- `onAgentDrainedMessages(sessionId)` — agent がメッセージを消費した時の処理（swallowed-message 追跡を含む）
- `stopSession(sessionId)` / `idleSession(sessionId)` — API からの明示的操作
- `reconcile(runningSessions)` — agent 再接続時の整合性回復

**状態遷移の明示化:**

現在の `updateSessionStatus(sessionId, status)` を廃止し、遷移メソッドに置き換える。各メソッドは遷移元の妥当性を検証し、不正な遷移はログに記録して拒否する。

```
有効な遷移:
  new       → starting       （メッセージ到着時）
  idle      → starting       （メッセージ到着時に revive）
  starting  → waiting        （物理セッション起動完了）
  waiting   → notified       （メッセージ到着）
  waiting   → processing     （ツール実行開始、copilotclaw_wait 以外）
  notified  → processing     （agent がメッセージを取得して処理開始）
  processing → waiting       （copilotclaw_wait 呼び出し）

  ANY       → idle           （turn run 正常終了）
  ANY       → suspended      （エラー / 明示的停止 / max age）

  suspended → starting       （明示的再起動のみ。自動 revive しない）
```

**個別バグへの対応（設計整理により解消）:**

- POST handler のセッション未起動 → `deliverMessage` がセッション確保を一貫実行するため解消
- pending 無条件 flush → `deliverMessage` がセッション確保を即時実行するため、flush しても新メッセージは即座に新セッションで処理される。flush の意図（状態リセット）は維持
- lifecycle "wait" ゾンビ → 状態遷移の明示化により、ゾンビ状態を検出・回復可能に
- notifyAgent の無駄打ち → `deliverMessage` 内で通知結果を確認し、失敗時はセッション起動にフォールバック
- swallowed-message 誤発火 → `onAgentDrainedMessages` で sender を検査し、user メッセージ含有時のみフラグ設定
- double drain バイパス → drain パスを `onAgentDrainedMessages` に統一
- startPhysicalSession ack なし → SessionController がタイムアウト監視し、応答なければ idle 遷移
- cron notify タイミング → `deliverMessage` 経由に統一すれば、セッション起動と通知が一貫する
- SSE broadcast 欠落 → 状態遷移メソッド内で broadcast を実行
- gateway 再起動 stale → `reconcile` で一括整合し、完了まで `deliverMessage` のセッション起動を抑制
- IPC reconnect flush 順序 → `running_sessions` report 送信後に flush 実行

**30秒ポーリングの位置づけ:**

`checkAllChannelsPending` は一次メカニズムではなくセーフティネットに降格する。主経路は `deliverMessage → ensureSession → notify`。ポーリング間隔は 60〜120 秒に延長しても安全になる。

