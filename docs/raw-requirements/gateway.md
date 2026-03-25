# Gateway (raw requirement)

vscode がそうであるように、copilotclaw も単一のプロセス (gateway) が中央集権的に支配するような仕組みにしたい。

まずは簡易的な仕組みとして:

- 中央集権的なプロセス（gateway）として、ポートを固定して、そこにサーバーを起動する
  - これで多重起動が防がれる
- このサーバーは、以下を持つ
  - dashboard（ページ。user message と reply をペアでリストする）
  - user message を post するエンドポイント（user message はキューイングされる）
  - user message を find one するエンドポイント（FIFO, なければ即時ないことが返る）
  - reply を post するエンドポイント（user message の id と reply メッセージをポスト）
  - healthz
- サーバーはひとまずインメモリでデータを持てば OK
- gateway をコマンドで起動しようとすると、health check をして、既に起動されていれば何もしない。ポートが埋まっているが healthy でない場合は何度か試してタイムアウトで起動失敗。ポートが空いている場合はサーバー起動する
