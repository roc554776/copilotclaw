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

