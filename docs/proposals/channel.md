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
      "message": "日次レポートを作成して報告してください。",
      "enabled": true
    }
  ]
}
```

- `id`: cron ジョブの識別子（重複排除に使用）
- `channelId`: メッセージを送信するチャンネル
- `intervalMs`: 実行間隔（ミリ秒）
- `message`: チャンネルに送信するメッセージ内容
- `enabled`: ジョブの有効/無効（デフォルト: `true`）。`false` に設定するとスケジューラに登録されない（未実現）

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

