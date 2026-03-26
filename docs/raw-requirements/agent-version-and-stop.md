# Agent Version Compatibility and Stop Command (raw requirement)

## Agent バージョン互換性チェック

- gateway は、必要とする agent の最低バージョンを定義する
- gateway start 時に agent process を ensure する際にバージョンを確認する（user message POST 時ではない）
- 必要なバージョンを充たしていない場合はエラーを返す（`--force-agent-restart` オプション付きなら古い agent を停止して新しい agent を起動する）
- バージョン取得できないほど古い agent の場合もエラーとする
- agent は自分のバージョンを持ち、バージョンを問われたら返す

## Agent 手動停止コマンド

- agent を手動で停止させるコマンドがほしい
- gateway stop は agent を停止しない（独立プロセスの原則）
- agent には独自の stop コマンドが必要
