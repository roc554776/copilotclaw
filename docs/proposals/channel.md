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
- `Message.sender` は `"user" | "agent" | "cron"` の 3 値
- SQLite の CHECK 制約を `CHECK(sender IN ('user', 'agent', 'cron'))` に更新
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
- `client.send()` を直接呼ばない。チャンネルメッセージとして送信し、`copilotclaw_wait` の tool result として返す
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

### チャンネルごとのモデル設定（v0.55.0 で実現済み）

チャンネル単位でモデルを設定する。グローバルの `model` 設定とは独立に、チャンネルごとにモデルを上書きできる。

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

