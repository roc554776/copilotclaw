# 提案: Gateway パターン

## アーキテクチャ方針: Gateway パターン

### 方針: 単一プロセスによる中央集権制御

VSCode がそうであるように、copilotclaw も単一の常駐プロセス（gateway）がシステム全体を統制する。gateway は固定ポート（19741）で HTTP サーバーを起動し、多重起動を防止する。

### Gateway の責務

- user message のキューイング（FIFO）
- agent からの reply の受け付けと user message との紐付け
- gateway start/restart 時に agent process を ensure する（プロセスの生存確認 + バージョンチェック、なければ spawn）。CLI コマンドが return する前に ensure を完了させ、失敗したらエラーを返す
- agent process の常時監視（起動していなければ起動、health check でバージョン確認、リトライアウト時はエラーログ）
- gateway stop 時に agent process は停止しない（agent session は高コストなので gateway restart 後もそのまま再利用するため）
- `/api/status` で agent が非互換なら `agentCompatibility: "incompatible"` を返す
- dashboard ページによるチャット UI（メッセージ入力 + user message / reply の時系列表示）
- dashboard でのシステムステータス表示（gateway status、agent version、agent session 状態、互換性ステータス）
- dashboard のリアルタイム更新（SSE によるプッシュ型通信）
- dashboard ステータスバーの詳細モーダル（クリックで gateway/agent の詳細表示）
- dashboard でのログ表示（gateway / agent のログを確認可能、`/api/logs` エンドポイント + Logs パネル）
- healthz エンドポイントによる生存確認

注意: user message POST 時に agent process を ensure するのではない。agent session の ensure は agent process 側の責務（agent が gateway をポーリングして pending を見つけたら session を起動する）。

### SystemStatus の別ページ表示

SystemStatus を独立ページとして提供する。現在のモーダルと同じ情報を表示するが、URL で直接アクセスでき、ブラウザのタブとして常時開いておけるようにする。

- パス: `/status` 等（検討）
- モーダルからリンクで遷移可能

### 物理 Session イベント stream 表示

物理 session ごとの SDK セッションイベントをリアルタイム stream 表示するページ。

**ページ仕様:**
- パス: `/sessions/{{sessionId}}/events` 等（検討）
- イベントを時系列で stream 表示する
- スクロール追従（React SPA で実現済み — `useAutoScroll` hook）:
  - 強制スクロールしない
  - スクロール位置がコンテナ最下部にある場合のみ、新規イベント追加時に自動追従する
  - 判定: `scrollHeight - scrollTop - clientHeight` が閾値以下かどうかで最下部判定する
  - Auto-scroll のチェックボックス toggle は廃止する
- 内部スクロール保持（React SPA で実現済み — 差分更新方式）:
  - 定期リフレッシュでイベント一覧の DOM を丸ごと置き換えると、各イベントのデータ表示領域（`max-height` + `overflow-y: auto`）の手動スクロール位置が失われる
  - 対策: 既存イベントの DOM は保持し、新規イベントのみ末尾に追記する差分更新方式を採用する
  - ネスト表示への切替時は全体の再描画が必要になるため、そのタイミングではリセットを許容する
- SystemStatus（モーダル・別ページ）から物理 session ごとのリンクで遷移可能
- ~~表示モード切替: フラット表示（デフォルト）と、parent id による親子関係ネスト表示~~ → parentId がほぼ付与されないため廃止済み（v0.32.0）

**ナビゲーション（v0.32.0 で実現済み）:**
- 「Back to System Status」に加え、セッション一覧（`/sessions`）への戻りリンクを設置する
- 戻りリンクには、当該物理セッションが属する抽象セッションの ID を URL パラメタとして付与する（例: `/sessions?focus={{abstractSessionId}}`）
- これにより、イベントページから戻ったときにどの抽象セッションのコンテキストにいたかが視覚的に分かる

**イベント収集・保存:**
- agent が SDK の session event を subscribe し、gateway に送信して保存する
- disk に保存する（on memory ではない）
- retention 期間は無制限。ストレージ上限を設ける（上限到達時は古いイベントを削除）

### セッション一覧ページの構造改善（v0.32.0 で実現済み）

`/sessions` ページを物理セッションの単純一覧から、抽象セッション主体の階層表示に変更する。

**表示構造:**
- `/api/status` から取得した抽象セッション一覧を主軸にする
- 各抽象セッションの下に、紐づく物理セッションを子要素として表示する
  - 現在アクティブな `physicalSession`（あれば）
  - 停止済みの `physicalSessionHistory` エントリ
- event store に記録がある物理セッション（抽象セッションに紐づかないもの）は、独立セクションとして表示する

**URL パラメタによるフォーカス:**
- `/sessions?focus={{abstractSessionId}}` で、特定の抽象セッションをハイライトまたは自動展開する
- イベントページからの戻りリンクで使用する

**データソース:**
- 抽象セッション情報: `/api/status` の `agent.sessions`
- 物理セッションイベント情報: `/api/session-events/sessions` + 各セッションのイベント取得

### オリジナルのシステムプロンプトの取得・保存・表示（v0.34.0 で修正済み）

Copilot SDK がモデルに送る「オリジナルの」（CopilotClaw が改変する前の）システムプロンプトを取得・保存し、API と dashboard で参照可能にする。

**現状の問題と原因:**
- `registerTransformCallbacks` を `createSession` の後に呼んでいるため、CLI の wire payload に `action: "transform"` が含まれず、CLI が `systemMessage.transform` RPC を発行しない。コールバックが一度も発火していない
- `"*"` キーはワイルドカードではなく、SDK は `Map.get(sectionId)` で正確なセクション ID をルックアップする

**正しい取得方法（要修正）:**
- `createSession` の config に `systemMessage: { mode: "customize", sections: { ... } }` を含め、既知のセクション ID ごとに transform callback を設定する
  - 既知のセクション ID（`docs/references/copilot-sdk-llm-context-and-message-retrieval.md` 参照）: `identity`, `tone`, `tool_efficiency`, `environment_context`, `code_change_rules`, `guidelines`, `safety`, `tool_instructions`, `custom_instructions`, `last_instructions`
  - 各 callback は内容を改変せずそのまま返しつつ、gateway に転送して保存する
  - SDK の `extractTransformCallbacks` がこれを検出し、wire payload に `action: "transform"` を含め、CLI が RPC でコールバックを呼ぶ
- `registerTransformCallbacks` を `createSession` の後に個別に呼ぶ方式は廃止する
- 最新のものが取得されるたびに上書き保存する

**保存データ:**
- モデル名
- システムプロンプト本文
- 取得日時

**表示:**
- API エンドポイントで参照可能にする
- dashboard で「オリジナルの system prompt」であることが明確に分かる形で表示する

### 物理セッションのシステムプロンプト表示

物理セッションで実際に使用されるシステムプロンプト（将来的にはオリジナルから改変される可能性がある）を API と dashboard で参照可能にする。

- SystemStatus に表示する
- 現時点ではオリジナルと同一だが、将来の改変に備えてオリジナルとは別に表示する
- 「セッションのシステムプロンプト」と「オリジナルのシステムプロンプト」の区別を UI 上で明確にする

