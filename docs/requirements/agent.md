# 要求定義: Agent

### Req: Agent シングルトンと Gateway-Agent 分離

Agent は単一プロセスで複数チャンネルのセッションを管理し、gateway とは独立したプロセスとして稼働する。

- Agent は 1 プロセスで複数チャンネルを管理する。チャンネルごとに独立した Copilot SDK セッションを作成する
- Agent プロセスは IPC socket（Unix domain socket）でシングルトン動作する
- Agent は IPC 経由で外部から health check / 全チャンネルの status 一括取得 / 個別 channel status 取得 / 停止ができる
- Gateway と agent は独立プロセスとして動作する（gateway stop 時に agent を停止しない）。理由: agent session は高コスト（プレミアムリクエスト消費）であり、gateway restart 時も agent session をそのまま再利用するため
- gateway が停止している間も、agent process は物理セッションを適切に延命し続けなければならない。gateway の停止が物理セッションの破壊につながる設計は許されない
- 起動は常に gateway → agent。agent が gateway を起動することはない
- Gateway start 時に agent process を ensure する（プロセスの生存確認 + バージョンチェック、なければ spawn）
- User message POST 時に agent session を ensure する（agent process 側の責務: gateway をポーリングして pending を見つけたら session を起動）
- Agent プロセスの責務:
  - gateway を定期ポーリングして各チャンネルの pending user message を確認し、必要なら agent session を起動
  - チャンネルセッションが processing のまま既定の時間（デフォルト 10 分）を超過した場合は停止させる
  - スタック検出: 同一チャンネルの最古 user message が変わらないまま 1 回リトライ後も残る場合は、当該チャンネルの user message を全て flush する
- ゾンビプロセスを残さないこと

### Req: Gateway-Agent 間通信の IPC 統一

Gateway と agent process の間の通信を全て IPC に統一する。agent process は gateway の HTTP server の存在を知らない構成にする。

- agent process は gateway の HTTP API にアクセスしない。全通信は IPC stream 経由で行う
- gateway が agent の IPC socket に `{"method": "stream"}` で接続し、永続的な双方向チャネルを確立する
- 既存の短命 IPC 接続（status, stop, quota, models, session_messages）はそのまま動作する。stream 接続は追加
- IPC stream 上のメッセージは改行区切り JSON で `type` フィールドを持つ:
  - Fire-and-forget: `{"type": "...", ...}\n`
  - Request-response: `{"type": "...", "id": "uuid", ...}\n` → `{"type": "response", "id": "uuid", "data": ...}\n`
- gateway → agent push: `config`（stream 開始時に即送信）、`pending_notify`（新規 pending 発生時）
- agent → gateway push (fire-and-forget): `channel_message`, `session_event`, `system_prompt_original`, `system_prompt_session`
- agent → gateway request-response: `drain_pending`, `peek_pending`, `flush_pending`
- agent process から `COPILOTCLAW_GATEWAY_URL` 環境変数と `gatewayBaseUrl` 設定を除去する
- HTTP API は human / dashboard / 外部ツール向けのインターフェースとして維持する
- 理由: モジュール構成の健全性（agent が gateway の HTTP server の実装詳細に依存しない）
- IPC プロトコル変更に伴い、MIN_AGENT_VERSION を引き上げる（旧 agent は HTTP を前提としているため非互換）

### Req: 抽象 Agent Session と物理 Copilot Session の分離

Agent session（抽象レイヤー）と Copilot SDK session（物理レイヤー）のライフサイクルを分離する。

- 抽象 agent session は channel との紐づけを恒久的に保持する。物理 session の停止は抽象 session の消滅を意味しない
- 物理 session が意図せず停止した場合、抽象 agent session は「物理 session なし」の状態に遷移する（sessions Map から削除しない、channel binding も解除しない）
- 次のトリガー（user message 到着等）で物理 session を新規作成または resume し、既存の抽象 agent session に紐づける
- agent process を再起動しても、channel と抽象 agent session の紐づけが維持される（永続化が必要）

### Req: 物理 Session 停止後の記憶保持

物理 session が停止した後に再開する際、直前のコンテキスト（会話履歴や作業状態）をある程度保持する。

- 方法: `client.resumeSession()` で再開する（copilotSessionId を suspended 状態の抽象 session に保持）
- `resumeSession` が失敗した場合は `copilotSessionId` をクリアして `createSession` で新しい物理セッションを作成する（記憶は失われるが、セッション自体は復旧する）
- 目的: 物理 session の停止・再開が agent の利用者にとって透過的になること
- channel binding は agent restart 後も維持される（`agent-bindings.json` に永続化）

### Req: 物理セッションの意図しない停止への対応

物理セッションが意図せず停止した場合（LLM が `copilotclaw_wait` を呼ばずに idle exit した場合など）、抽象セッションは suspended 状態で維持し、次のユーザーメッセージで revive する。

- 物理セッションが停止しても、抽象セッションは消滅しない。チャンネルへの紐づけも維持される
- `copilotSessionId` は保持する（`resumeSession` で前回の会話記憶を復元するため）
- revive 時にまず `resumeSession` を試み、失敗した場合のみ `copilotSessionId` をクリアして `createSession` にフォールバックする

### Req: copilotclaw_wait（旧 copilotclaw_receive_input からの rename）

`copilotclaw_receive_input` を `copilotclaw_wait` に rename した。

- ツールの役割は入力の受け取りだけでなく、自分のやることがなくなった全ての状況で呼び出されるべきもの
- rename に伴い、channel-operator のシステムプロンプトを更新する:
  - 直近、一時的にでも自分のやることがなくなったときには必ず `copilotclaw_wait` を呼ぶ
  - `copilotclaw_wait` を使わずにターンを終了するとデッドロック（セッション停止）
  - 利用シーン: ユーザーの回答待ち、subagent 完了待ち、全作業完遂時、想定外の異常時

### Req: copilotclaw_wait は絶対にエラーを返さない

`copilotclaw_wait`（旧 `copilotclaw_receive_input`）ツールはいかなる状況でもエラーを返してはならない。

- エラーを返すと agent の物理 session が停止し、デッドロックに陥る危険がある
- どのような例外が発生しても、キャッチして、タイムアウト時と同じレスポンス（copilotclaw_wait の再呼び出し指示）を返す
- エラーの発生事実や理由を response に含めてはならない（agent がエラーを知覚するとデッドロックの危険がある）
- エラーはシステムログにのみ記録する

### Req: Gateway-Agent 責務の再配置（部分実現 — 設定値は v0.40.0 で移行済み、抽象セッション管理は未実現）

gateway process だけ最新版を起動しても最新機能が使えるように、設定値と抽象セッション管理を gateway 側に移動する。

- システムプロンプト（CHANNEL_OPERATOR_PROMPT 等）を gateway 側の agent 用モジュールで管理し、IPC 経由で agent に送る — **v0.40.0 で実現済み**
- 各種設定値（custom agent 構成、SYSTEM_REMINDER、タイミング設定）も同様に gateway → agent の IPC 経由に移行する — **v0.40.0 で実現済み**
- 抽象セッション管理（channel binding、suspended 状態管理、revive 判定）を gateway process 側に移動する — **未実現**
- agent process は物理セッション（Copilot SDK session）の作成・実行・停止のみを担当する — **未実現**
- 理由: gateway process だけ最新版を起動しても、できるだけ最新機能が使えるようにするため

### Req: Agent Session の作業ディレクトリ

agent session の `workingDirectory` を当該 profile の workspace ディレクトリに設定する。

- Copilot のビルトインツールが操作するファイルシステムのルートが profile workspace に固定される

### Req: 抽象セッションへのトークン消費履歴の紐づけ

各セッションの消費トークン数等の履歴を、抽象 agent session に紐づけて管理する。

- 物理 session が停止・再作成されても、抽象 session に紐づく累積のトークン消費量が追跡できる
- dashboard から停止済みの物理 session の履歴も参照できる
- 抽象セッションごとのトークン消費量が把握できる

### Req: 停止した物理セッションの Dashboard 継続表示

物理セッションが停止した後も、そのセッションの情報を dashboard で継続的に参照できるようにする。

- 現状は物理セッション停止時に `physicalSession` が `undefined` に設定され、dashboard から情報が消える
- 停止した物理セッションの情報（モデル、トークン使用量、開始時刻、イベントリンク等）を保持し表示し続ける
- 表示が煩雑になる場合は、停止済みセッションを折りたたみ表示または別ページに分離する
