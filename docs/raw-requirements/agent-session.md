# Agent Session (raw requirement)

- いまは channel に copilot の session (agent session) が直接対応する方式だが、この関係性を切り離し、agent session は単体で管理する
  - agent session という概念を明確に導入する
  - agent process は agent session を管理する責務を負う
  - channel には agent session が必要に応じて紐づく
  - 将来的に channel に紐づかない agent session も考えられる
- agent session はコストが高い（プレミアムリクエスト消費）。以下の原則に従う:
  - 無駄に起動しない: channel が存在しても、agent にまだ読まれていない user message がなければ新規起動は不要
  - 起動した session はできるだけ長く使い続ける: 未読 user message がない状態が続いているという理由で既存の agent session を終了させてはいけない
- agent session を保つための基本方針
  - `copilotclaw_*` tool で input を待たせておく
  - タイムアウトしそうになったら、一旦 input なしで返し、即時 `copilotclaw_*` tool を実行するように強く指示する
  - これを繰り返すことで、セッションを生かし続ける

<!-- 2026-03-26 -->
## Agent Session の作業ディレクトリ

- agent session を起動するときの cwd（workingDirectory）は、当該 profile の workspace ディレクトリにすべき
  - SDK の `SessionConfig.workingDirectory` で指定できる
  - 現状は未指定で、agent process の cwd がそのまま使われている（意図しない動作）
  - profile ごとに workspace が分離される設計に合わせて、session の作業ディレクトリも profile workspace に揃える
