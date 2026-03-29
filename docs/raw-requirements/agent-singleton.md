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

## agent プロセスの責務（既存）

- agent プロセスの責務
    - gateway をポーリングして pending user message を確認し、必要なら agent session を起動（session ensure は agent 側の責務）
    - チャンネルセッションが user message 処理中のまま既定の時間（デフォルト 10 分）が経過した場合は停止させる
      - 再起動・停止を無制限に繰り返さないようにする
      - 当該チャンネルの user message の最も古いメッセージが同じまま残り続けているなら、1 回リトライしたら、当該チャンネルの user message は全て処理済み扱いで flush する
