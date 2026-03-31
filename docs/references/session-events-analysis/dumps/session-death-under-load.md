# 負荷テスト中のセッション死亡観察

## 対象セッション

- チャンネル: `8be360d1-475e-4f19-8ec7-ef4283e47c80`
- 物理セッション: `c7b798ec-b985-460e-84c8-f6cb61dde1f6`
- 総イベント数: 463

## 経緯

- セッション開始時: コンテキスト 12,231 / 128,000 トークン
- おじ構文タスク完了後: 29,015 トークン (22.7%)。正常に `copilotclaw_wait` でブロック
- ハーネスエンジニアリングタスク投入: Yahoo 検索 + 5件の web_fetch + サマリー作成
- タスク処理中: 41,142 トークン (32.1%) まで増加
- turnId 51 で LLM が最終応答をテキスト出力し、`copilotclaw_wait` を呼ばずに停止
- `session.idle` 発火 → セッション死亡

## イベントの最終部分

```
[458] 15:31:55 session.usage_info  tokens=41,142/128,000
[459] 15:32:59 assistant.usage     in=39,593 out=2,649
[460] 15:32:59 assistant.message   content=「ハーネスエンジニアリングとは何か」のまとめ
[461] 15:32:59 assistant.turn_end  turnId=51
[462] 15:32:59 session.idle        *** IDLE ***
```

## 死因

LLM が最終応答を `assistant.message` のテキストとして直接出力し、`copilotclaw_send_message` ツールも `copilotclaw_wait` ツールも呼ばなかった。

## 考察

- コンテキストが大きくなるにつれて（41,142 トークン = 32.1%）、システムプロンプトの「`copilotclaw_wait` を必ず呼べ」という指示が相対的に埋もれる
- このセッションでは turnId 0 → 51 まで正常に動作していたが、大量の web_fetch 結果がコンテキストに入った後のターンで指示追従に失敗した
- `onPostToolUse` hook による定期リマインドが設計されているが、コンテキスト増大に対して十分でなかった可能性がある
- セッション持続時間は約6分（30秒超）なので `RAPID_FAILURE_THRESHOLD_MS` に該当せず、バックオフは入らない
- `assistant.message` の auto-reflect によりユーザーには応答が届いているが、セッションが死んだため以降の対話は新セッション（プレミアムリクエスト追加消費）が必要
