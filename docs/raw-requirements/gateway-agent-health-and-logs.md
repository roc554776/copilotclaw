# Gateway-Agent Health and Logs (raw requirement)

<!-- 2026-03-26 -->

## Agent 互換性ステータスの可視化

- gateway の `/api/status` で、agent が非互換なら、gateway から見た agent のメタ的なステータスは少なくとも ready ではないことを示す
- API と dashboard の両方からそれが確認できるようにする

## Dashboard でのログ表示

- dashboard で gateway や agent のログを確認できるようにする

## Gateway start/restart 時の agent ensure

- gateway を start/restart したときに agent process を ensure（healthy）する
- start/restart の CLI コマンドが return する前に ensure を完了させる
- 失敗したらエラーを返す
