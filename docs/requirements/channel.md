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

### Req: チャンネルのアーカイブ（v0.37.0 で実現済み）

チャンネルをアーカイブし、dashboard 上の通常表示から除外できるようにする。

- アーカイブされたチャンネルは dashboard のチャンネルタブ一覧に表示されない
- アーカイブされたチャンネルも含めて全て表示するモードを提供する
- アーカイブはデータ削除ではない。メッセージ履歴は保持される

### Req: Cron 機能（v0.41.0 で実現済み）

config に設定した定期タスクを、チャンネル経由で agent に実行させる。

- config で cron ジョブを複数定義できる。各ジョブには識別子、実行間隔、タスク内容、紐づくチャンネルを指定する
- cron は定期的にチャンネルにメッセージを送る仕組みとして実現する（`client.send()` を直接呼ばない — プレミアムリクエスト消費を最小化するため）
- sender は `"user"` でも `"agent"` でもなく、cron 専用の sender（例: `"cron"`）を使う
- cron sender からのメッセージで物理セッションが生きていなければ、セッションを起動する（現在は `"user"` のみだが cron も対象に追加）
- `copilotclaw_wait` ツールは cron sender のメッセージを区別して伝える
- 同一 cron ジョブのメッセージが未処理のまま残っている場合、重複してメッセージを追加しない
- まずは channel に直接紐づく agent のケースのみ実現する（将来はチャンネルに紐付かない cron も対応）
- 各 cron ジョブはジョブごとに enabled/disabled を切り替えられる（v0.42.0 で実現済み）
- 動的な読み込みは現時点では不要（gateway 再起動で反映）

### Req: chat operator プロンプトへの cron 対応と subagent 利用ルールの追加（v0.41.0 で実現済み）

chat operator のシステムプロンプトに以下を追加する。

- cron からタスクが来ることがあること、その場合は worker subagent に委譲すること
- subagent 呼び出しでは常に background mode を使い、worker 以外のエージェントを使わないこと
