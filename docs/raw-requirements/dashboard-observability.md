# Dashboard Observability (raw requirement)

<!-- 2026-03-27 -->

## SystemStatus の別ページ表示

- SystemStatus を、モーダルに加えて、gateway の別のパスで表示できるようにする
- モーダルから、リンクでそのページに遷移できるようにする

## 物理 Session イベントの stream 表示

- gateway の別のパスを作って、物理 session ごとの session イベントを stream で表示できるようにする
- stream で表示するが、強制スクロールはしない（最下部までスクロールしている場合には、追従する）
- System Status（モーダルも別パスも）から、リンクでそのページに遷移できるようにする
- 表示モードを切り替えて、親子関係でネスト表示できるようにする
  - parent id が与えられているので、親子関係が分かるはず
- event は SDK から、session event を subscribe して取得し、gateway に送って保存しておく
  - 一旦 retention 期間は無制限でいいが、ストレージ上限を設ける
  - on memory ではなく、disk に保存する

## オリジナルのシステムプロンプトの取得・表示

- モデルごとの、オリジナルのシステムプロンプトを、API や dashboard 等で取得できるようにする
- create session するときに registerTransformCallbacks を使って、オリジナルの system prompt を取得して保存しておく
  - ※ 本来は system prompt を改変するための callback を使って、改変せずにオリジナルを取得して保存するということ
  - 最新のものが取得されるたびに上書き保存する
- API や dashboard では、「オリジナルの」system prompt というのが明確に分かるようにする
- モデル、システムプロンプト、取得日時、などの情報を保存しておく

## 物理セッションのシステムプロンプトの表示

- 物理セッションのシステムプロンプトを、API や dashboard 等で取得できるようにする
- SystemStatus で表示する
- ※ 今は system prompt を変更していないので、オリジナルのシステムプロンプトと同じものが表示されるが、将来的には変更する可能性があるので、別々に表示するようにする
