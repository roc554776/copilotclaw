# 要求定義: Custom Agents・システムプロンプト補強・Subagent 通知

### Req: Custom Agent によるシステムプロンプトの安定化

Copilot SDK の Custom Agent 機能を用いて、copilotclaw のシステムプロンプトを agent の固有プロンプトとして設定する。

- システムプロンプトが compaction 等で消失すると、`copilotclaw_receive_input` の呼び出し義務を失い copilotclaw 全体がデッドロックするため、最重要の要求である
- channel 対話用 agent と subagent 用 agent の 2 種を定義する
- channel 対話用 agent:
  - user と直接やりとりする唯一の agent であり、subagent として呼び出されてはならない
  - `copilotclaw_receive_input` を呼ばずに停止することがデッドロックにつながる旨をシステムプロンプトで最大限に強調する
  - 全ビルトインツール + `copilotclaw_receive_input` / `copilotclaw_send_message` / `copilotclaw_list_messages` を使用可能にする
- subagent 用 agent:
  - subagent として呼び出される事実上唯一の agent である
  - 全ビルトインツール + `copilotclaw_send_message` / `copilotclaw_list_messages` を使用可能にする（`copilotclaw_receive_input` は含めない）

### Req: onPostToolUse hook によるシステムプロンプト補強

`onPostToolUse` hook の `additionalContext` を利用して、`copilotclaw_receive_input` の呼び出し義務を定期的にリマインドする。

- channel に紐づく agent session のみで発火する（subagent では発火してはならない）
- `<system>` タグで囲った指示を `additionalContext` に挿入する
- 発火頻度: context token usage が 10% 増加するごとに 1 回（毎回だとコンテキストを浪費するため）
- compaction 完了後（`session.compaction_complete` イベント直後）は即座に 1 回発火する（compaction 後は動作が不安定になりやすいため）
- システムプロンプトに、`additionalContext` に `<system>` タグ付きの重要指示が差し込まれる可能性があることを記載する

### Req: Subagent 完了の親 Agent への通知

subagent の完了・失敗を親 agent にリアルタイムに通知する。

- `subagent.completed` / `subagent.failed` イベントを利用する
- 親 agent が `copilotclaw_receive_input` で待機中の場合: tool の戻り値に subagent 停止情報を含めて返す
- 親 agent が他の処理中の場合: `onPostToolUse` hook の `additionalContext` で通知する
