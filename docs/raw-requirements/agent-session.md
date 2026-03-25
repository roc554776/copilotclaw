# Agent Session (raw requirement)

- いまは channel に copilot の session (agent session) が直接対応する方式だが、この関係性を切り離し、agent session は単体で管理する
  - agent session という概念を明確に導入する
  - agent process は agent session を管理する責務を負う
  - channel には agent session が必要に応じて紐づく
  - 将来的に channel に紐づかない agent session も考えられる
- agent session を保つための基本方針
  - `copilotclaw_*` tool で input を待たせておく
  - タイムアウトしそうになったら、一旦 input なしで返し、即時 `copilotclaw_*` tool を実行するように強く指示する
  - これを繰り返すことで、セッションを生かし続ける
