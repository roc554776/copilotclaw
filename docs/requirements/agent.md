# 要求定義: Agent

### Req: Agent シングルトンと Gateway-Agent 分離

Agent は単一プロセスで複数チャンネルのセッションを管理し、gateway とは独立したプロセスとして稼働する。

- Agent は 1 プロセスで複数チャンネルを管理する。チャンネルごとに独立した Copilot SDK セッションを作成する
- Agent プロセスは IPC socket（Unix domain socket）でシングルトン動作する
- Agent は IPC 経由で外部から health check / 全チャンネルの status 一括取得 / 個別 channel status 取得 / 停止ができる
- Gateway と agent は独立プロセスとして動作する（gateway stop 時に agent を停止しない）。理由: agent session は高コスト（プレミアムリクエスト消費）であり、gateway restart 時も agent session をそのまま再利用するため
- 起動は常に gateway → agent。agent が gateway を起動することはない
- Gateway start 時に agent process を ensure する（プロセスの生存確認 + バージョンチェック、なければ spawn）
- User message POST 時に agent session を ensure する（agent process 側の責務: gateway をポーリングして pending を見つけたら session を起動）
- Agent プロセスの責務:
  - gateway を定期ポーリングして各チャンネルの pending user message を確認し、必要なら agent session を起動
  - チャンネルセッションが processing のまま既定の時間（デフォルト 10 分）を超過した場合は停止させる
  - スタック検出: 同一チャンネルの最古 user message が変わらないまま 1 回リトライ後も残る場合は、当該チャンネルの user message を全て flush する
- ゾンビプロセスを残さないこと

### Req: 抽象 Agent Session と物理 Copilot Session の分離

Agent session（抽象レイヤー）と Copilot SDK session（物理レイヤー）のライフサイクルを分離する。

- 抽象 agent session は channel との紐づけを恒久的に保持する。物理 session の停止は抽象 session の消滅を意味しない
- 物理 session が意図せず停止した場合、抽象 agent session は「物理 session なし」の状態に遷移する（sessions Map から削除しない、channel binding も解除しない）
- 次のトリガー（user message 到着等）で物理 session を新規作成または resume し、既存の抽象 agent session に紐づける
- agent process を再起動しても、channel と抽象 agent session の紐づけが維持される（永続化が必要）

### Req: 物理 Session 停止後の記憶保持

物理 session が停止した後に再開する際、直前のコンテキスト（会話履歴や作業状態）をある程度保持する。

- 方法: `client.resumeSession()` で再開する（copilotSessionId を suspended 状態の抽象 session に保持）
- 目的: 物理 session の停止・再開が agent の利用者にとって透過的になること
- channel binding は agent restart 後も維持される（`agent-bindings.json` に永続化）

### Req: Agent Session の作業ディレクトリ

agent session の `workingDirectory` を当該 profile の workspace ディレクトリに設定する。

- Copilot のビルトインツールが操作するファイルシステムのルートが profile workspace に固定される
