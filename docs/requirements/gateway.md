# 要求定義: Gateway

### Req: 中央集権的な Gateway プロセス

VSCode のように、単一の常駐プロセス（gateway）がシステム全体を統制する構造とする。

- gateway は固定ポートで HTTP サーバーを起動し、多重起動を防止する
- user message のキューイングと agent の reply の管理を担う
- dashboard ページで user message と reply のペアをチャット形式で表示し、ユーザーがメッセージを入力できるインターフェースを提供する
- 起動コマンドは冪等であること: 既に起動済みなら何もしない、ポートが塞がっているが healthy でなければリトライ後タイムアウト
- CLI で gateway を起動すると、サーバープロセスはバックグラウンドにデタッチされ、CLI 自体は即座に終了すること

### Req: SystemStatus の別ページ表示

SystemStatus（現在はモーダル表示のみ）を、gateway の独立ページとしても表示できるようにする。

- gateway の別のパスで SystemStatus の全情報をページとして表示する
- 既存のモーダルからリンクでそのページに遷移できるようにする

### Req: 物理 Session イベントの stream 表示

物理 session ごとの SDK セッションイベントを stream 表示するページを gateway に追加する。

- gateway の別のパスで物理 session ごとのイベントを stream 表示する
- スクロール追従（React SPA で実現済み）:
  - 強制スクロールはしない
  - ユーザーが最下部にいる場合のみ新しいイベントに自動追従する
  - ユーザーが上方にスクロールしている場合は追従しない
  - チェックボックス等の手動 toggle ではなく、スクロール位置に基づいて自動的に判定する
- 内部スクロール保持（React SPA で実現済み）:
  - 各イベントのデータ表示領域が内部スクロールを持つ場合、定期リフレッシュによってスクロール位置がリセットされてはならない
- SystemStatus（モーダル・別ページ両方）からリンクで遷移できるようにする
- ~~表示モードの切り替えで、親子関係によるネスト表示に対応する（parent id による）~~ → parentId がほぼ付与されないため不要。廃止する
- イベントは SDK の session event を subscribe して取得し、gateway に送って保存する
  - ストレージ上限を設ける（retention 期間は無制限）
  - on memory ではなく disk に保存する

### Req: セッション一覧ページの構造（未実現 — 過去物理セッションの表示が不完全）

`/sessions` ページは抽象セッションを一覧の主体とし、物理セッションをその子として表示する。

- 抽象セッション一覧を主体とし、各抽象セッションの下に紐づく物理セッション（現在の physicalSession + physicalSessionHistory）を子として表示する
- suspend になっている過去の物理 session も含め、全て表示されること
- 理由: 「セッション」とは抽象セッションと物理セッションの双方を含み、単にセッションと言った場合は抽象セッションが優先される
- 現状の問題: 実現報告済みだが、suspend の過去物理セッションが正しく表示されていない

### Req: セッションイベントページのナビゲーション改善（v0.32.0 で実現済み）

`/sessions/{{sessionId}}/events` ページからの戻り先を改善する。

- 現在は「Back to System Status」のみだが、セッション一覧（`/sessions`）への戻りリンクも追加する
- 戻り先のセッション一覧では、該当する抽象セッションがフォーカスされた状態にする
  - `/sessions` は URL パラメタでフォーカスする抽象セッションを指定可能にする
  - `/sessions/{{sessionId}}/events` ページの戻りリンクは、該当抽象セッションのパラメタ付きで配置する

### Req: イベントの parentId ネスト表示の廃止（v0.32.0 で実現済み）

session event の parentId がほぼ付与されないため、parentId に基づくネスト表示機能は不要。廃止する。

### Req: オリジナルのシステムプロンプトの取得・表示（v0.34.0 で修正済み）

モデルごとの、Copilot SDK が提供するオリジナルのシステムプロンプトを API と dashboard で参照できるようにする。

- `createSession` の config で `systemMessage: { mode: "customize", sections: { ... } }` を指定し、各セクションに transform callback を設定してオリジナルの system prompt を取得して保存する
- 最新のものが取得されるたびに上書き保存する
- モデル名、システムプロンプト本文、取得日時を保存する
- API と dashboard で「オリジナルの」system prompt であることが明確に分かるようにする
- 現状の問題: `registerTransformCallbacks` を `createSession` の後に呼んでおり、CLI の wire payload に transform が通知されないためコールバックが発火しない

### Req: `/status` の sessions リンク表記（v0.36.0 で修正済み）

`/status` ページの sessions へのリンクの表記を `All sessions →` にする。

- `/sessions` ページが抽象セッション主体の階層表示であるため、「physical sessions」という表現は不適切

### Req: 物理セッションのシステムプロンプトの表示

物理セッションで実際に使用されるシステムプロンプト（将来的にはオリジナルから改変される可能性あり）を API と dashboard で参照できるようにする。

- SystemStatus で表示する
- 現時点ではオリジナルと同一だが、将来の改変に備えてオリジナルとは別に表示する
