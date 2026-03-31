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
- 各 cron ジョブはジョブごとに disabled フラグで無効化できる（v0.42.0 で実現済み。フラグ名の `enabled` → `disabled` 変更は v0.55.0 で実現済み）
- 動的な読み込み（cron reload コマンド）が必要（以前は不要としていたが、新しい要望で上書き）

### Req: chat operator プロンプトへの cron 対応と subagent 利用ルールの追加（v0.41.0 で実現済み）

chat operator のシステムプロンプトに以下を追加する。

- cron からタスクが来ることがあること、その場合は worker subagent に委譲すること
- subagent 呼び出しでは常に background mode を使い、worker 以外のエージェントを使わないこと

### Req: チャンネルごとのモデル設定（v0.55.0 で実現済み）

チャンネルごとにモデルを設定できるようにする。

- チャンネルに対してモデルを明示的に設定できる
- モデルを明示的に設定していない状態（デフォルト）にもできる
- 設定値と、現在の物理セッションで使用中のモデルは一致するとは限らない（物理セッション起動時にモデルが解決されるため）

### Req: Cron 設定のリロードコマンド（v0.55.0 で実現済み）

cron の設定を動的にリロードするコマンドを提供する。

- `cron reload`: cron 設定全体をリロードする。設定差分がないジョブのタイマーはリセットしない
- `cron list`: 現在の cron ジョブの一覧を表示する

### Req: Cron の disabled フラグ（v0.55.0 で実現済み）

cron の設定フィールドを `enabled`（デフォルト `true`）から `disabled`（デフォルト `false`）に変更する。

- デフォルトが `true` のフラグはバグの温床になるため、否定形でデフォルト `false` にする

### Req: アーカイブされたチャンネルの cron 無効化（v0.55.0 で実現済み）

アーカイブされたチャンネルの cron は設定値に関係なく disabled として扱う。

### Req: チャンネル設定モーダル（v0.56.0 で実現済み）

chat 画面のタブの channel ID をクリックすると、モーダルでチャンネル設定メニューが開く。

- チャンネルの現在の物理セッションのモデルを表示する
- チャンネルのモデル設定値（明示設定 / デフォルト）を表示する
- チャンネルのモデルを設定できる（明示設定の解除も可能）
- 物理セッションの強制アーカイブ（現在の物理セッションを停止し、次回メッセージ時に新物理セッションを起動する。過去の物理セッションは履歴として抽象セッションに紐づく）
- cron の設定を変更、追加、削除できる
- cron の設定を変更したら、自動で cron 設定全体をリロードする

### Req: end turn run ボタンの警戒色（v0.58.0 で実現済み）

end turn run ボタンを archive physical session と同じく警戒色にする。

- 理由: プレミアムリクエストを消費して開始した run を捨てることになるため
