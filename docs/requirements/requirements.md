# 要求定義（Requirements）

<!-- NOTE: このファイルが大きくなったら、トピックごとに別ファイルへ分割すること -->

本ドキュメントは、顧客の生の要望（raw requirements）を整理し、プロジェクトとして達成すべき要求を明確化したものである。

## 背景

- GitHub Copilot のサブスクリプションを持つ開発者は、LLM の能力を Copilot 経由で利用できる
- OpenClaw のような Agent 体験（対話的にタスクを遂行する CLI エージェント）が広く認知されつつある
- 現状、Copilot のサブスクリプションだけでは自前の Agent 体験を構築する手段が限られている

## 要求

### Req: Agent 体験の提供

GitHub Copilot SDK を用いて、OpenClaw に相当する Agent 体験を提供する。

- OpenClaw は参考プロダクトであり、クローンを作ることが目的ではない
- OpenClaw が実現している「対話的にコーディングタスクを遂行する CLI エージェント」の体験カテゴリを、Copilot SDK 上で実現することが目的である

### Req: Copilot サブスクリプションの活用

GitHub Copilot のサブスクリプションを持つユーザーが、追加の LLM 契約なしに Agent 体験を利用できるようにする。

- Copilot SDK が提供する LLM アクセスを活用し、別途 API キーや課金が不要であること

### Req: 独自の価値提供

単なる OpenClaw の模倣ではなく、Copilot SDK のエコシステム（Copilot Extensions、OTEL テレメトリ等）を活かした独自の価値を追求する。

### Req: 中央集権的な Gateway プロセス

VSCode のように、単一の常駐プロセス（gateway）がシステム全体を統制する構造とする。

- gateway は固定ポートで HTTP サーバーを起動し、多重起動を防止する
- user message のキューイングと agent の reply の管理を担う
- dashboard ページで user message と reply のペアをチャット形式で表示し、ユーザーがメッセージを入力できるインターフェースを提供する
- 起動コマンドは冪等であること: 既に起動済みなら何もしない、ポートが塞がっているが healthy でなければリトライ後タイムアウト
- CLI で gateway を起動すると、サーバープロセスはバックグラウンドにデタッチされ、CLI 自体は即座に終了すること

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

### Req: Agent シングルトンと Gateway-Agent 分離

Agent は単一プロセスで複数チャンネルのセッションを管理し、gateway とは独立したプロセスとして稼働する。

- Agent は 1 プロセスで複数チャンネルを管理する。チャンネルごとに独立した Copilot SDK セッションを作成する
- Agent プロセスは IPC socket（Unix domain socket）でシングルトン動作する
- Agent は IPC 経由で外部から health check / 全チャンネルの status 一括取得 / 個別 channel status 取得 / 停止ができる
- Gateway と agent は独立プロセスとして動作する（gateway stop 時に agent を停止しない）。理由: agent session は高コスト（プレミアムリクエスト消費）であり、gateway restart 時も agent session をそのまま再利用するため
- 起動は常に gateway → agent。agent が gateway を起動することはない
- Gateway start 時に agent process を ensure する（プロセスの生存確認 + バージョンチェック、なければ spawn）
- User message POST 時に agent session を ensure する（agent process 側の責務: gateway をポーリングして pending を見つけたら session を起動）
- Agent プロセスの責務:
  - gateway を定期ポーリングして各チャンネルの pending user message を確認し、必要なら agent session を起動
  - チャンネルセッションが processing のまま既定の時間（デフォルト 10 分）を超過した場合は停止させる
  - スタック検出: 同一チャンネルの最古 user message が変わらないまま 1 回リトライ後も残る場合は、当該チャンネルの user message を全て flush する
- ゾンビプロセスを残さないこと

### Req: 抽象 Agent Session と物理 Copilot Session の分離

Agent session（抽象レイヤー）と Copilot SDK session（物理レイヤー）のライフサイクルを分離する。

- 抽象 agent session は channel との紐づけを恒久的に保持する。物理 session の停止は抽象 session の消滅を意味しない
- 物理 session が意図せず停止した場合、抽象 agent session は「物理 session なし」の状態に遷移する（sessions Map から削除しない、channel binding も解除しない）
- 次のトリガー（user message 到着等）で物理 session を新規作成または resume し、既存の抽象 agent session に紐づける
- agent process を再起動しても、channel と抽象 agent session の紐づけが維持される（永続化が必要）

### Req: 物理 Session 停止後の記憶保持

物理 session が停止した後に再開する際、直前のコンテキスト（会話履歴や作業状態）をある程度保持する。

- 方法: `client.resumeSession()` で再開する（copilotSessionId を suspended 状態の抽象 session に保持）
- 目的: 物理 session の停止・再開が agent の利用者にとって透過的になること
- channel binding の永続化（agent restart 後の維持）は未実装 <!-- TODO: 未実装 -->

### Req: 自動テストの義務化

すべての実装には自動テストが伴わなければならない。テストのない実装のみの PR はマージしない。

- unit / integration / E2E の各レイヤーを整備する
- unit: 外部依存なし。純粋なロジックのテスト
- integration: DB など外部リソースへの依存を含むテスト
- E2E: 実際にサーバーを起動してエンドポイントや UI を検証するテスト
- GitHub Copilot は E2E であっても mock を使う（認証要件と BAN リスクのため）
- テストダブル（mock / stub）はテスト実装としてその場で完結させること。テストダブルの不在を理由にテストを skip にしてはならない
- フロントエンドの E2E には Playwright を使用する
- E2E 環境は本番環境と完全に分離する（専用ポート、専用ビルドディレクトリ等）

### Req: 正しい monorepo パッケージ構成

root パッケージは `private: true` とし、CLI エントリポイント用のサブパッケージを設ける。

- root パッケージを `npm install -g` するのではなく、CLI サブパッケージを pack/install する
- サブパッケージ同士の依存は `workspace:*` で宣言し、npm が依存を正しく解決できるようにする
- update コマンドは CLI サブパッケージに対して `npm pack` → `npm install -g tgz` を実行する

### Req: Dashboard フロントエンド技術の移行

Dashboard のフロントエンドを vite + React に移行する。

- 現在の server-side HTML テンプレート + inline JS 方式は、機能の複雑化に伴い保守性とテスタビリティが低下している
- vite + React への移行により、型安全な JSX、コンポーネントテスト（React Testing Library）、hooks による状態管理を実現する

### Req: Copilot 物理セッションの状態可視化

API およびダッシュボードで、agent session（論理）と Copilot SDK session（物理）の両方の状態をリアルタイムに確認できるようにする。

- agent session → 物理 session → subagent 物理 session（0〜複数）の3層構造を可視化する
- サマリー: プレミアムリクエスト残量/上限、利用可能モデルとプレミアムリクエスト乗数、各物理セッションの session ID / model / コンテキストトークン使用率 / 開始時刻 / 現在の状態
- 詳細: サマリーに加えて現在のコンテキスト内容（システムプロンプト + 会話履歴）
- ダッシュボードのモーダルでサマリーを表示し、個別セッションをクリックで詳細表示

### Req: Profile による複数インスタンス分離

同一マシン上で複数の独立した copilotclaw インスタンスを実行できるようにする。

- `COPILOTCLAW_PROFILE` 環境変数で profile を指定する（未指定時はデフォルトの無印 profile）
- profile ごとに workspace、設定ファイル、gateway インスタンス、agent process インスタンス、IPC ソケットパスを分離する

### Req: 設定ファイルによる動作制御

設定ファイル（`config.json`）で copilotclaw の動作を制御できるようにする。

- 環境変数と設定ファイルの両方で値を与えられる。環境変数が優先される（原則）
- 設定項目: upstream（update 用 URL）、port（gateway ポート）、model（デフォルトモデル）、zeroPremium（ゼロプレミアムリクエストモード）、debugMockCopilotUnsafeTools（開発用モックツールモード）
- CLI コマンド（`config get` / `config set`）で設定値の取得・変更ができる

### Req: CLI 設計原則

copilotclaw の CLI は non-interactive とする。カラーコード、raw mode は使用しない。

- 理由: agent が CLI を操作することを前提とした設計。interactive UI や色付き出力は agent にとって雑音

### Req: Agent Session の作業ディレクトリ

agent session の `workingDirectory` を当該 profile の workspace ディレクトリに設定する。

- Copilot のビルトインツールが操作するファイルシステムのルートが profile workspace に固定される

### Req: Custom Agent によるシステムプロンプトの安定化

Copilot SDK の Custom Agent 機能を用いて、copilotclaw のシステムプロンプトを agent の固有プロンプトとして設定する。

- システムプロンプトが compaction 等で消失すると、`copilotclaw_receive_input` の呼び出し義務を失い copilotclaw 全体がデッドロックするため、最重要の要求である
- channel 対話用 agent と subagent 用 agent の 2 種を定義する
- channel 対話用 agent:
  - user と直接やりとりする唯一の agent であり、subagent として呼び出されてはならない
  - `copilotclaw_receive_input` を呼ばずに停止することがデッドロックにつながる旨をシステムプロンプトで最大限に強調する
  - 全ビルトインツール + `copilotclaw_receive_input` / `copilotclaw_send_message` / `copilotclaw_list_messages` を使用可能にする
- subagent 用 agent:
  - subagent として呼び出される事実上唯一の agent である
  - 全ビルトインツール + `copilotclaw_send_message` / `copilotclaw_list_messages` を使用可能にする（`copilotclaw_receive_input` は含めない）

### Req: onPostToolUse hook によるシステムプロンプト補強

`onPostToolUse` hook の `additionalContext` を利用して、`copilotclaw_receive_input` の呼び出し義務を定期的にリマインドする。

- channel に紐づく agent session のみで発火する（subagent では発火してはならない）
- `<system>` タグで囲った指示を `additionalContext` に挿入する
- 発火頻度: context token usage が 10% 増加するごとに 1 回（毎回だとコンテキストを浪費するため）
- compaction 完了後（`session.compaction_complete` イベント直後）は即座に 1 回発火する（compaction 後は動作が不安定になりやすいため）
- システムプロンプトに、`additionalContext` に `<system>` タグ付きの重要指示が差し込まれる可能性があることを記載する

### Req: Subagent 完了の親 Agent への通知

subagent の完了・失敗を親 agent にリアルタイムに通知する。

- `subagent.completed` / `subagent.failed` イベントを利用する
- 親 agent が `copilotclaw_receive_input` で待機中の場合: tool の戻り値に subagent 停止情報を含めて返す
- 親 agent が他の処理中の場合: `onPostToolUse` hook の `additionalContext` で通知する

## スコープ外（現時点）

- GUI / Web UI の提供（CLI が主体）
- OpenClaw との機能パリティの保証
- GitHub Copilot 以外の LLM プロバイダのサポート

## 前提条件

- ユーザーは GitHub Copilot のサブスクリプションを保有していること
- GitHub Copilot SDK が提供する API・機能が利用可能であること

## 現状

- Observability スタック（OTEL テレメトリ収集・可視化）は構築済みで、動作検証が完了している
- GitHub Copilot Hooks によるイベントログ記録の仕組みが導入済み
- Copilot SDK を用いた Agent の hello world 実装が完了（session idle loop による停止制御を含む）
- Gateway サーバーの実装が完了（インメモリ Store、API エンドポイント、チャット UI dashboard、冪等起動）
- 自動テスト基盤の整備が完了（Vitest、mock session による agent テスト含む）
- Channel 機能の初版が完了（gateway 経由の agent-user 対話）
