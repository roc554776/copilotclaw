# 要求定義: Custom Agents・システムプロンプト補強・Subagent 通知

関連ファイル:
- `docs/requirements/channel-status-and-events.md` — ツール割り当て整理・copilotclaw_intent tool・sender 識別に関する要求（2026-04-14 追加）


### Req: Custom Agent によるシステムプロンプトの安定化

Copilot SDK の Custom Agent 機能を用いて、copilotclaw のシステムプロンプトを agent の固有プロンプトとして設定する。

- システムプロンプトが compaction 等で消失すると、`copilotclaw_wait` の呼び出し義務を失い copilotclaw 全体がデッドロックするため、最重要の要求である
- channel 対話用 agent と subagent 用 agent の 2 種を定義する
- channel 対話用 agent (channel-operator):
  - user と直接やりとりする唯一の agent であり、subagent として呼び出されてはならない
  - `copilotclaw_wait` を呼ばずに停止することがデッドロックにつながる旨をシステムプロンプトで最大限に強調する
  - 全ビルトインツール（SDK の builtin tool list API で取得）+ `copilotclaw_wait` / `copilotclaw_send_message` / `copilotclaw_list_messages` / `copilotclaw_intent` を使用可能にする
- subagent 用 agent (worker):
  - subagent として呼び出される事実上唯一の agent である
  - 全ビルトインツール（SDK の builtin tool list API で取得）+ `copilotclaw_send_message` / `copilotclaw_list_messages` / `copilotclaw_intent` を使用可能にする（`copilotclaw_wait` は含めない）
- 明示的なツール割り当てにより、`tools: null` の暗黙割り当てを廃止する（詳細は `docs/requirements/channel-status-and-events.md` の「Req: channel operator / worker のツール割り当て整理」を参照）

### Req: onPostToolUse hook によるシステムプロンプト補強

`onPostToolUse` hook の `additionalContext` を利用して、`copilotclaw_wait` の呼び出し義務を定期的にリマインドする。

- channel に紐づく agent session のみで発火する（subagent では発火してはならない）
- `<system>` タグで囲った指示を `additionalContext` に挿入する
- 発火頻度: context token usage が 10% 増加するごとに 1 回（毎回だとコンテキストを浪費するため）
- compaction 完了後（`session.compaction_complete` イベント直後）は即座に 1 回発火する（compaction 後は動作が不安定になりやすいため）
- システムプロンプトに、`additionalContext` に `<system>` タグ付きの重要指示が差し込まれる可能性があることを記載する

### Req: Subagent 完了の親 Agent への通知（v0.43.0 で実現済み — gateway 側 agent_notify 統一方式）

subagent の完了・失敗を親 agent にリアルタイムに通知する。

- subagent の停止で `copilotclaw_wait` のブロックを即座に解除し、停止情報を返す
- subagent call はネストされることがある。直接呼び出した subagent の停止（成功・失敗両方）のみを通知する。ネストされた孫 subagent の停止は通知しない
- フィルタリングロジック（直接呼び出し判定等）は gateway process 側に置く。agent process は通知を受けて wait を解除するだけ
- wait 中のイベント処理をアドホックに行わない。統一的な通知の仕組みを使う
- 理由: agent process をミニマルに保ち、gateway の更新だけで最新機能を享受できるコンセプトを維持するため
- 実現前の状況: subagent completion は agent 側の queue に積まれたが wait のブロックを解除する仕組みがなかった。フィルタリングも agent 側にあった。v0.43.0 で gateway 側 agent_notify 統一方式により解消。

### Req: ネスト subagent 完了通知の抑制（部分実現済み — v0.43.0 の parentToolCallId フィルタで対応。outer wrapper 経路は未機能）

subagent が呼び出した subagent（孫 subagent）の完了を、main agent に伝えない。

- wait tool で待っている main agent には、直接呼び出した subagent の停止だけを伝える
- parent tool call の id で直接呼び出しかどうかを判定する

**実装の現状**: `packages/gateway/src/daemon.ts` の `data["parentToolCallId"]` フィルタは機能しているが、agent 側の session キャッチオール（`physical-session-manager.ts`）が `parentId` を outer wrapper に含めないため、gateway の `agent-manager.ts` で参照する `msg["parentId"]` は常に `undefined` になる。`data["parentToolCallId"]` 経由のフィルタのみが機能しており、outer wrapper 経由のフィルタ（`msg["parentId"]`）は実際には動作していない。孫 subagent の完了通知が引き続き main agent に届く場合がある（実際に「雑音になっている」という観察あり — 2026-04-14）。

本節が single source of truth であり、`docs/requirements/channel-status-and-events.md` は本節へのクロスリファレンスのみを含む。
