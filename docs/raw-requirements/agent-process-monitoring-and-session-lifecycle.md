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
