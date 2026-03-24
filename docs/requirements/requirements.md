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
- user input のキューイングと agent の reply の管理を担う
- dashboard ページで user input と reply のペアをチャット形式で表示し、ユーザーがメッセージを入力できるインターフェースを提供する
- 起動コマンドは冪等であること: 既に起動済みなら何もしない、ポートが塞がっているが healthy でなければリトライ後タイムアウト
- CLI で gateway を起動すると、サーバープロセスはバックグラウンドにデタッチされ、CLI 自体は即座に終了すること

### Req: Multi-Channel（Gateway 経由の Agent-User 対話）

Agent と human が gateway を介して対話する仕組み（channel）を提供する。複数の channel を並行して運用できる。

- 各 channel は固有の channel ID を持ち、独立した input queue と会話履歴を持つ
- Agent は channel ID に紐付き、gateway の API を通じてその channel の user input を受け取り reply を返す
- Agent は session が idle になっても自動的に停止せず、常に次の user input を待ち続ける
- カスタムツール名は `copilotclaw_` プレフィクスで統一する
- 同一 channel に未処理の user input が複数ある場合、agent は一括で取得する
- Gateway 起動時にデフォルト channel を 1 つ作成する
- Dashboard は複数タブで複数 channel を扱えるインターフェースとする

### Req: Agent シングルトンと Gateway-Agent 分離

Agent は channel ごとに IPC socket でシングルトン動作し、gateway とは独立したプロセスとして稼働する。

- Agent は channel ID ごとに IPC socket（Unix domain socket）を持ち、同一 channel で多重起動しない
- Agent は IPC 経由で外部から health check / status 取得 / 停止ができる
  - status: 起動していない / 起動直後 / user input 待ち / user input 処理中
  - prop: 起動時刻、再起動時刻
- Gateway と agent は独立プロセスとして動作する（gateway 再起動時に agent を道連れにしない）
- Gateway は agent を必要に応じて ensure（起動確認・起動）する
- Gateway は agent が user input 処理中のまま既定の時間（デフォルト 10 分）を超過した場合、IPC 経由で再起動を促す
- ゾンビプロセスを残さないこと

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
