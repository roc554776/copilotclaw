# Agent Version Compatibility and Stop Command (raw requirement)

## Agent バージョン互換性チェック

- gateway は、必要とする agent の最低バージョンを定義する
- gateway は agent のバージョンを確認して、必要なバージョンを充たしていない場合はエラーを返す
- バージョン取得できないほど古い agent の場合もエラーとする
- agent は自分のバージョンを持ち、バージョンを問われたら返す

## Agent 手動停止コマンド

- agent を手動で停止させるコマンドがほしい
- gateway には stop コマンドがあるが agent にはない
