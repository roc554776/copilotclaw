# Agent Process Monitoring and Session Lifecycle (raw requirement)

## Gateway による Agent Process の常時監視

- gateway は agent process の状態を常に監視する
- agent process が起動していないときは起動する
- 起動している場合には health check を行う
  - status が healthy か
  - 必要なバージョンが起動しているか
- agent process は起動しているが問題があり、health check がリトライアウトしたら、エラーログを出力して agent process がエラー状態であることをユーザーが認識できるようにする

## Agent Session のライフサイクル管理

- agent process は、必要になったときに agent session を起動する

### 実行中タイムアウト（stale session）

- agent session が待機中ではなく実行中のまま一定時間（デフォルト 10 分）経ったら、強制的に agent session を終了させる
- エラーログを出力する
- ユーザーへの通知（dashboard）
- channel に紐づいている agent session なら channel に message を送り、ユーザーが知覚できるようにする

### セッション寿命制限

- agent session が wait になったとき、agent session が作られてから一定期間（デフォルト 2 days）が経っていたら、その agent session を停止する
- この場合はエラーではないので、通知は不要
- 理由: 古い agent session を利用し続けると、プロバイダーに切断される可能性があり、危険であるため
- 将来的には、単純な停止ではなく replace（状態保存して停止、擬似的に同じ状態のものを起動して入れ替え）できるようにする
  - disconnect して resume すればいいので、将来といわずすぐにでも導入できるかもしれない

<!-- 2026-03-26 -->
### Session Replace の設計原則（上記の replace 方針を修正）

- 危険性: session replace が無制限に再実行されると、プレミアムリクエストが無駄に消費される
- session replace の方式原則:
  - 何かしらの理由で session replace が必要になったら、状態を保存して session を終了させる。基本的には即時再起動はしない
  - 次にその agent session が必要とされるような状況が発生したら、保存しておいた状態をもとに session を再起動する
- channel に紐づく agent session が processing のままタイムアウトしたケースでは:
  - 状態を保存して終了だけさせる
  - エラー通知はこれまで通りに行う
  - 次に agent が未読な user message が channel に入ってきたときに、保存しておいた状態をもとに session を再起動する

<!-- 2026-03-26 -->
### Agent Process 停止時のセッション保存

- agent process は停止する前に、全てのアクティブなセッションの状態を保存してほしい
  - 停止要因が何であれ（`copilotclaw agent stop`、SIGTERM 等）、セッションは破棄ではなく保存されるべき
  - 保存された状態は、次回 agent process 起動後に resume できるようにする
