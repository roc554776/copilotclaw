# Logging and Observability (raw requirement)

<!-- 2026-03-27 -->

## ログのファイル出力

- gateway や agent のログをファイル等にも出力しておく
- 理由: gateway や agent が落ちたときに、何が起こったのかを調査できるようにするため

## 構造化ログ

- ログは必ず構造化ログを採用する

## OpenTelemetry

- （少なくとも将来的には）OpenTelemetry を導入する

<!-- 2026-03-28 -->
## OpenTelemetry の本格導入

- OpenTelemetry を導入する
- ログやメトリクスを OpenTelemetry を介して出力するようにする
- 構造化ログでないログを採用している部分は全て構造化ログにする
- config.json に、追加の出力先 URL リストを指定することで、任意の Collector に送れるようにする
- また、これまで通りの出力も残す（既存の Collector も引き続き使う）

<!-- 2026-03-29 -->
## デバッグ用ログレベルの導入

- hooks について、trace (or debug) レベルでログを出すようにする
- config ファイルで log level を指定できるようにして、trace (or debug) レベルのログを出せるようにする
- これはデバッグ用の設定値なので設定キーは `debug.*` などの名前空間を使う
