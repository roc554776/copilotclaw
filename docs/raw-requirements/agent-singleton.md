# Agent Singleton (raw requirement)

- agent はチャンネルごとに 1 プロセスではなく、1 プロセスで複数チャンネルを管理する
  - copilot sdk でチャンネルごとにセッションを作る（1 セッションに複数チャンネルの user message を流し込むのではない）
  - vscode と同様に IPC socket を使ってシングルトンで動作させる
  - 外部から停止もさせられるようにする
  - ゾンビ化しないように注意する
- gateway と agent のアーキテクチャについて
  - gateway と agent は独立で動作させる
    - 理由: gateway だけを再起動させたい場合もあるが、その際に agent は再起動させたくないため
    - 理由: agent session は高コスト（プレミアムリクエスト消費）なので、gateway restart しても agent session はそのまま再利用できるようにするため
  - 起動は常に gateway → agent。agent が gateway を起動することはない
  - agent は IPC で外から health check / status 取得できるようにする
    - 複数チャンネル（セッション）のステータスを同時取得できる
    - 個別にも取得できる
    - prop: 起動時刻
    - channel session status: 起動していない / 起動直後 / user message 待ち / user message 処理中
  - gateway start 時に agent process を ensure する（プロセスの生存確認 + バージョンチェック、なければ spawn）
  - user message POST 時に agent session を ensure する（agent process 側の責務: gateway をポーリングして pending を見つけたら session を起動）
  - gateway stop 時に agent process は停止しない（独立プロセスの原則）
  - gateway の責務: user message の管理、agent プロセスの ensure（start 時のみ）、チャットシステムの提供
  <!-- 2026-03-28 -->
## Gateway-Agent 間通信の IPC 統一

- agent process は、gateway と http server ではなく、IPC でやりとりするようにする
  - http の部分は channel や human がシステムの status や設定を確認するためのインタフェースであって、gateway と agent process の通信には使わない
  - agent process は gateway の http server の存在を知るべきではない
  - 理由: モジュール構成を健全に保つため
- gateway が通信の主体
  - gateway が agent process の socket に接続する形にする
  - agent process から gateway への通信を、双方向にすることは問題ない

<!-- 2026-03-29 -->
## Gateway-Agent 責務の再配置

- システムプロンプトなど、各種の設定値は gateway 側 process の agent 用のモジュールにおいて、 IPC 経由で送るようにしてください。
- 完全に再起動不要にするのはまだ難しいですが、すぐに移動できる設定は徹底して移動させましょう。
- abstract session の管理は、 gateway process 側の agent モジュールに移動しちゃってください。 agent process は物理セッションだけを管理すれば ok。
- 理由: gateway process だけ最新版を起動しても、できるだけ最新機能が使えるようにするため。

<!-- 2026-03-29 -->
## gateway 停止時の agent process の独立性と情報の無損失

- gateway が停止している場合でも agent process は独立して維持され、 gateway に再接続された時に、一切情報を失わずに活動を再開できなければならない。
- また、gateway に再接続されないまま agent process が停止した場合においても、再起動後に情報が失われずに再開できなければならない。

## gateway 停止時の物理セッション延命

- gateway を stop している状態でも、 agent process は適切に物理セッションを延命し続ける必要がある。（gateway が停止したことにより agent process が（高価な）物理セッションを壊してしまうような設計は常に許されない）

<!-- 2026-04-02 -->
## SDK CLI 子プロセスのゾンビ化

- agent プロセス停止時に SDK CLI 子プロセス（@github/copilot/index.js）がゾンビとして残る問題。agent の stopAllPhysicalSessions は 5秒タイムアウトで打ち切り、SDK の disconnect() が完了する前に agent プロセスが終了する可能性がある。SDK CLI プロセスは orphan として残り、プレミアムリクエストを無駄に消費し続ける。gateway の agent 再起動時も IPC stop コマンドを送るだけでプロセスを直接 kill しない。実測で 89 個のゾンビ SDK CLI プロセスが残っていた。

<!-- 2026-04-02 -->
## CopilotClient とセッション管理の設計問題

- CopilotClient は agent process 全体で 1 つでいい。現状はセッションごとに新しいクライアントを作っている（CLI プロセスが増殖する根本原因）
- physical session id を自分で生成して SDK の createSession / resumeSession に渡す。これが唯一のセッション識別子。copilotSessionId という別名で管理する必要はない
- copilotSessionId という表現は捨てて、physical session id に統一する
- client.stop() 後でも physical session id があれば新しいクライアント（または再起動したクライアント）で resumeSession できる
- end-turn-run: session.disconnect() でセッション切断。クライアントは止めない。physical session id 保持。次回 resumeSession で再開
- archive session: session.disconnect() + physical session id を破棄（コンテキストを捨てる）

## agent プロセスの責務（既存）

- agent プロセスの責務
    - gateway をポーリングして pending user message を確認し、必要なら agent session を起動（session ensure は agent 側の責務）
    - チャンネルセッションが user message 処理中のまま既定の時間（デフォルト 10 分）が経過した場合は停止させる
      - 再起動・停止を無制限に繰り返さないようにする
      - 当該チャンネルの user message の最も古いメッセージが同じまま残り続けているなら、1 回リトライしたら、当該チャンネルの user message は全て処理済み扱いで flush する
