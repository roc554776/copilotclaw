# 要求定義: Channel

### Req: Multi-Channel（Gateway 経由の Agent-User 対話）

Agent と human が gateway を介して対話する仕組み（channel）を提供する。複数の channel を並行して運用できる。

- 各 channel は固有の channel ID を持ち、独立した input queue と会話履歴を持つ
- Agent は channel ID に紐付き、gateway の API を通じてその channel の user message を受け取り reply を返す
- Agent は session が idle になっても自動的に停止せず、常に次の user message を待ち続ける
- カスタムツール名は `copilotclaw_` プレフィクスで統一する
- 同一 channel に未処理の user message が複数ある場合、agent は一括で取得する
- channel に紐づく agent session の `assistant.message` イベントのメッセージを、channel タイムラインに sender=agent のメッセージとして自動反映する。`copilotclaw_send_message` tool でのメッセージ送信が理想だが、agent が tool を呼ばずにテキスト応答した場合のフォールバックとして機能する
- Gateway 起動時にデフォルト channel を 1 つ作成する
- Dashboard は複数タブで複数 channel を扱えるインターフェースとする

### Req: チャンネルのアーカイブ（未実現）

チャンネルをアーカイブし、dashboard 上の通常表示から除外できるようにする。

- アーカイブされたチャンネルは dashboard のチャンネルタブ一覧に表示されない
- アーカイブされたチャンネルも含めて全て表示するモードを提供する
- アーカイブはデータ削除ではない。メッセージ履歴は保持される
