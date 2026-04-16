# メッセージ消費とセッションステータス管理のバグ (raw requirement)

<!-- 2026-04-01 -->

なんか最近の v61~ の変更で、どうやらメッセージが詰まるようになったりするようになった気がします。たぶんバグです。
agent process を修正したときに、何かメッセージや status の処理でミスったりしてません？
メッセージの消費や status の管理はかなりアドホックで複雑な設計になっているような気がしますが、、、
徹底的にレビューしてもらった方がいいと思います。

以下の問題が発見された:

HIGH:
- POST handler がセッション起動しない（メッセージ最大30秒詰まり）
- onPhysicalSessionEnded で pending を無条件 flush（データ消失）
- lifecycle "wait" がゾンビセッション作る（回復手段なし）

MEDIUM:
- notifyAgent が死んだセッションに通知して無視される
- swallowed-message 検出が cron/system メッセージで誤発火
- copilotclaw_wait の double drain で swallowed-message 検出がバイパスされる
- startPhysicalSession が fire-and-forget で ack なし（"starting" で永久スタック）

LOW:
- cron notify が物理セッション起動前に送られる
- SSE broadcast にセッションステータス変更が含まれない
- gateway 再起動時に orchestrator の stale 状態が残る
- IPC reconnect 時の send queue flush 順序

<!-- 2026-04-01 -->

- onPhysicalSessionEnded で pending を無条件 flush については、意図的な可能性もある。flush してしまって、一旦状態をリセットした方がいいからかも？
- 実際に起きているバグは、以下のような感じ。status 管理とメッセージ管理が全体的に補修が必要なのは間違いなさそう。
  - processing になったまま、メッセージが消費されずにデッドロックすることがある
  - 抽象セッションに物理セッションが正しく結びつかなくなることがある

<!-- 2026-04-14 -->
- ステータスまわりの処理についてバグが多そうです。バグは困ります。
- 現在、いわゆるワールドステートと、プロセスの状態管理がごちゃごちゃになっているように見えます。
- イベントによってワールドステートが変化し、その変化に応じて、次の処理が command として発行され、作用が起きるという流れを整理できるとよいです。
- なんかセッションだけに問題があると思ってる？ソフトウェア全体の状態管理に問題がありそうだが。
- とにかくスコープを矮小化するな。

<!-- 2026-04-15 -->
- v0.80-0.81 で AbstractSession と PhysicalSession の 2 subsystem だけ reducer 化した。残り 8 subsystem + event bus infrastructure が全て未着手。全てやる。
