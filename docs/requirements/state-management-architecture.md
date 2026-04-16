# 要求定義: 系全体の状態管理アーキテクチャ

本ファイルは `docs/raw-requirements/message-status-bugs.md` に記録された利用者要望（特に 2026-04-14 ブロック）を構造化した要求定義である。

## Req: ステータス周りのバグの不在

ステータス管理に起因するバグが繰り返し発生している。以下の種類の不具合が観測されている。

- 抽象セッションが `processing` のまま固まり、メッセージが消費されずデッドロックする
- 抽象セッションに物理セッションが正しく結びつかなくなる
- `copilotclaw_wait` で待機中のはずのセッションが意図せず idle に遷移する（wait/idle race）
- 物理セッション起動後に "starting" 状態で永久にスタックする（ack なし）
- gateway 再起動時に orchestrator の stale 状態が残る

これらのバグを再発させない構造的な設計が必要である。個別のパッチではなく、根本的な状態管理モデルの整備で解決する。

参照: `docs/requirements/channel.md` の「Req: メッセージ消費とセッションステータス管理のバグ修正」に個別バグの詳細リストがある。

## Req: 系全体の状態管理の整合性

AbstractSession（gateway）と PhysicalSession（agent）の 2 subsystem は v0.81.0 で reducer 化済み。残り 8 subsystem + event bus infrastructure は v0.82.0 で実現する。

対象: Channel（gateway）、PendingQueue（gateway）、SSE Broadcaster（gateway）、CopilotClient（agent）、SendQueue（IPC）、RPC（IPC）、ConfigPush（IPC）、Event Bus Infrastructure

## Req: 系全体の状態管理の整合性（旧）

問題は特定の subsystem（セッション管理など）に限定されない。gateway 側・agent 側・IPC/cross-cutting のすべての subsystem にまたがる状態管理上の整合性の欠如がある。

- gateway 側: session orchestrator、channel ↔ session binding、保留メッセージキュー、channel ごとの backoff 状態、SSE subscribers の購読状態、SQLite 永続化層との同期、HTTP in-flight
- agent 側: `PhysicalSessionEntry` の world state と process state の混在、`CopilotClient` singleton のライフサイクル、reinject 状態、`AbortController` 群と sessionPromise 群、in-flight tool call の追跡、動的 model 切り替え状態
- IPC / cross-cutting: pending RPC と reconnection 状態、event 順序保証、profile・認証情報・設定の動的反映

系全体を通じて、状態の変化の起点・経路・結果が一貫した構造の上で追跡できる設計である。

## Req: 概念の明確な定義と区別（未実現）

以下の概念はコード・ドキュメント・状態表示の全てで明確に区別され、一貫して扱われている。

- **抽象セッション（abstract session）**: channel との紐づけを恒久的に持つ論理的なセッション。物理セッションのライフサイクルに依存しない
- **物理セッション（physical session）**: Copilot SDK の実際のセッション（`physicalSessionId`）。起動・停止・resume のライフサイクルを持つ
- **channel**: agent と human の対話経路の抽象。現状は first-class な状態を持たず、session 経由で状態を逆引きしている。channel 自体が固有の状態を持つ必要がある
- **turn run**: 一連の turn の連続（1 プレミアムリクエスト分）。`session.idle` が来るまでの期間
- **world state（世界状態）**: 永続化可能で、プロセス境界を越えて意味を持つ状態。AbortController・Promise・live SDK ref などの実行ハンドルは含まない
- **process state（プロセス状態）**: プロセスが生きている間だけ意味を持つ実行ハンドル群。world state には実行ハンドルが含まれない（process state と分離されている）

## Req: イベント駆動の状態管理（未実現）

状態の変化をイベントが駆動し、その変化に応じて次の処理が command として発行され、作用が起きるという一方向の流れを持つ。

- 系に入ってくる入力（user message 到着、物理セッション終了、keepalive timeout 等）は有限の event 型として列挙されている
- event によって world state が変化し、その変化に応じて command が発行され、command の作用がまた event として戻る（feedback loop）という流れが明示的に設計されている
- callback の中で暗黙的に状態を書き換えるパターン（現状）は廃止される
- subsystem 間は event でやりとりし、直接 field を触らない設計である

参照: `docs/raw-requirements/message-status-bugs.md` の 2026-04-14 ブロック「イベントによってワールドステートが変化し、その変化に応じて、次の処理が command として発行され、作用が起きるという流れを整理できるとよいです。」

## Req: テストで保証されること（未実現）

状態管理の正しさがテストによって検証できる設計である。

- 個々の subsystem の状態遷移ロジックが単体テストで網羅できる構造である
- 状態遷移の副作用（command）が assert できる設計である
- race condition のシナリオがテストで表現できる構造になっている（現状は `session-orchestrator.test.ts:699` のような後付け race シミュレートに依存）
- subsystem 間の event のやりとりがテストで表現できる設計である
- process 境界を跨ぐ event（gateway ↔ agent IPC）がテストで表現できる構造になっている

## 既存要求との関係

本ファイルの要求は以下の既存要求と密接に関連する。矛盾が生じた場合の解消は `docs/proposals/state-management-architecture.md` の proposal レイヤーで行う。

- `docs/requirements/channel.md`: 「メッセージ消費とセッションステータス管理のバグ修正」— 本要求が包含する
- `docs/requirements/agent.md`: 「抽象 Agent Session と物理 Copilot Session の分離」— 本要求の world state / process state 分離と整合する
- `docs/requirements/agent.md`: 「物理 Session 停止後の記憶保持」「物理セッションの意図しない停止への対応」— 新設計の state model で実現する

本要求の実装方針については `docs/proposals/state-management-architecture.md` を参照。
