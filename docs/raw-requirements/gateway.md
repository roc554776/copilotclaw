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

<!-- 2026-03-26 -->
- start/restart コマンドで gateway のバージョンが表示されてほしい

<!-- 2026-03-31 -->
- POST /api/channels/:channelId/messages の sender フィールドが required になっていないバグ。全ての正規の呼び出し元（フロントエンド sendMessage、e2e テスト）は sender を明示しており、省略時のフォールバック動作に依存しているコードは存在しない。sender が省略された場合は 400 エラーを返すべき。
