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
- スクロール（未実現 — 現在の実装はチェックボックス toggle であり要件と異なる）:
  - 強制スクロールしない
  - ユーザーが最下部にいる場合のみ自動追従する（chat UI と同じ一般的なパターン）
  - チェックボックスによる手動 toggle ではなく、スクロール位置ベースで自動判定する
- 内部スクロール保持（未実現 — 現在の実装は innerHTML 丸ごと置き換えのため内部スクロールがリセットされる）:
  - 各イベントのデータ表示領域（`max-height` + `overflow-y: auto` の要素）で手動スクロールした位置が、定期リフレッシュで失われてはならない
  - 既存イベントの DOM は更新せず、新規イベントのみ末尾に追記する差分更新方式を採用する
- SystemStatus（モーダル・別ページ）から物理 session ごとのリンクで遷移可能
- 表示モード切替: フラット表示（デフォルト）と、parent id による親子関係ネスト表示

**イベント収集・保存:**
- agent が SDK の session event を subscribe し、gateway に送信して保存する
- disk に保存する（on memory ではない）
- retention 期間は無制限。ストレージ上限を設ける（上限到達時は古いイベントを削除）

### オリジナルのシステムプロンプトの取得・保存・表示

Copilot SDK がモデルに送る「オリジナルの」（CopilotClaw が改変する前の）システムプロンプトを取得・保存し、API と dashboard で参照可能にする。

**取得方法:**
- `createSession` 時に `registerTransformCallbacks` を使い、改変せずにオリジナルの system prompt を取得する
  - `registerTransformCallbacks` は本来 system prompt を改変するための callback だが、改変せずにそのまま返すことで、オリジナルの内容を取得・保存する
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

