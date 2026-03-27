# 永続化戦略 (raw requirement)

<!-- 2026-03-27 -->

## 永続化方式の見直し

- テキスト（JSON / JSON Lines）ベースの永続化方式だと、最終的にクエリやパフォーマンスが悪くなる可能性がある
- チャンネルに紐づくメッセージ履歴等も含めて、全体的に永続化の方式を考えた方がいい
- Option D（ハイブリッド）でいく:
  - 小さい静的データ（config, bindings, prompts）は JSON のまま
  - 成長するデータ（messages, session events）は SQLite に移行
- ログについては OpenTelemetry を使うという要望が既にあるので、SQLite ではなく OTel ブリッジへの移行とする
