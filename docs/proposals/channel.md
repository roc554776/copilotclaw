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

