# Install, Workspace, Update, Persistence (raw requirement)

## Install 機能

- copilotclaw を install する仕組みがほしい
- npm レジストリへの公開は行わない（絶対にしない）
- GitHub リポジトリからの取得が基本
- ローカルに clone したものをソースとして npm グローバルインストールする方式は可

## Workspace 機能

- copilotclaw の作業ディレクトリ兼設定ストレージとしての workspace がほしい
- 参考: openclaw は `~/.openclaw/workspace/` にブートストラップファイル群を配置する方式

## Update 機能

- copilotclaw を update する仕組みがほしい
- GitHub リポジトリからの git pull ベースの更新が基本
- ローカル開発を考慮して、file URL をアップストリームとして設定して update もできるようにしたい
- 参考: openclaw は `openclaw update` でセルフアップデート（git/npm 両対応）

## バージョン管理ポリシー

- バージョン管理のポリシーを決めてドキュメント化する
- 特に gateway と agent のバージョン管理は更新ルールをしっかり入れておかないと管理不足になる

## 永続化

- チャネル情報や chat の履歴を永続化してほしい
- 現在はインメモリで、gateway 再起動で全て失われる

## Profile 機能

- 将来的にほしい（現時点では優先度低）
- 参考: openclaw は `OPENCLAW_PROFILE` 環境変数で workspace を分離する方式

## Channel アーキテクチャの再設計

- gateway が内蔵する chat の仕組みは、channel の一種として設計されるべき
- 将来的に channel として Discord やテレグラム等もサポートする予定
- 内蔵 chat の履歴やチャネル情報を永続化するとき、それがどのレイヤーに属するのかを明確にする必要がある
- 現在の gateway は内蔵 chat 機能が密結合している状態なので、分離して channel の一種として設計しなおす必要がある
