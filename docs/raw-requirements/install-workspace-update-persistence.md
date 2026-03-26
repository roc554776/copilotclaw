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

<!-- 2026-03-26 -->
- profile を複数持てるようにしたい
  - profile は openclaw の profile と同様の概念
  - profile ごとに workspace が分離される
- profile ごとに gateway のインスタンスは分ける
  - 理由: profile 同士の衝突を避け、設計をシンプルにするため
- profile ごとに agent process のインスタンスは分ける
  - 理由: 設計をシンプルにするため
- 参考: openclaw は `OPENCLAW_PROFILE` 環境変数で workspace を分離する方式

## 設定ファイル機能

<!-- 2026-03-26 -->
- 設定ファイルを持てるようにしたい
  - profile ごとに設定ファイルは異なる
  - openclaw の設定ファイルと類似の概念
- いま環境変数で与えている `COPILOTCLAW_UPSTREAM` は、設定ファイルで与えられるようにしたい
  - オプショナルな設定項目
  - 環境変数で与える方法も残す。その場合、環境変数の値が優先される
  - 設定全般に原則的にこのルール（環境変数 > 設定ファイル）を適用する
  - 特別な理由があれば、例外を設けることも検討できる
- gateway の HTTP サーバーの port 番号を設定ファイルで指定可能にしたい
  - オプショナルな設定項目
- setup で、デフォルトの port が使われていたら、空いているポートを探して、それを設定ファイルに書き込むようにしたい
  - 候補の port の list のうち、空いている port を探すロジックを実装する
  - port 選択ロジックは `.claude/skills/select-development-port/SKILL.md` を参考にする
- 仕様検討の参考に openclaw の codebase を参照すべき
  - openclaw はあくまで参考であって、完全に同じにする必要はない
  - openclaw のよい点を取り入れる

## Channel アーキテクチャの再設計

- gateway が内蔵する chat の仕組みは、channel の一種として設計されるべき
- 将来的に channel として Discord やテレグラム等もサポートする予定
- 内蔵 chat の履歴やチャネル情報を永続化するとき、それがどのレイヤーに属するのかを明確にする必要がある
- 現在の gateway は内蔵 chat 機能が密結合している状態なので、分離して channel の一種として設計しなおす必要がある
