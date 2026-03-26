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
<!-- 2026-03-26 -->
- update の動作: upstream から fetch → pull → pnpm install → pnpm build → npm install -g .（再インストール）
- file:// upstream の場合は SHA 比較をスキップして常にビルド + 再インストールする
  - 理由: 開発中は file:// で自分のリポジトリを upstream に指定するが、npm install -g で SHA が一致してしまい更新がスキップされる
- デフォルトの upstream は https://github.com/roc554776/copilotclaw.git

## バージョン管理ポリシー

- バージョン管理のポリシーを決めてドキュメント化する
- 特に gateway と agent のバージョン管理は更新ルールをしっかり入れておかないと管理不足になる
<!-- 2026-03-26 -->
- 各パッケージ（root, gateway, agent）のバージョンは一律に揃える
- gateway と agent の compatibility が壊れる場合には、`MIN_AGENT_VERSION` を引き上げる
  - compatibility が壊れていない場合には最低要求バージョンを引き上げてはいけない（無駄なコストになる）

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
<!-- 2026-03-26 -->
- openclaw のような config set / get コマンドがほしい
  - CLI から設定ファイルを直接編集せずに設定値を変更・確認できるようにしたい
  - 参考: openclaw は `openclaw config set <key> <value>` / `openclaw config get <key>` を提供している
<!-- 2026-03-26 -->
- Config 設定追加: デフォルトで使用するモデル
  - 設定がない場合には、プレミアムリクエストが最も少ないモデルを動的に選択する
- Config 設定追加: ゼロプレミアムリクエストモード
  - 用途: プレミアムリクエストを消費せずに利用したいユーザー向け
  - オプショナルで、デフォルト false
  - ゼロプレミアムリクエストモードが有効な場合、かつ、デフォルトモデルが指定されており、かつ、そのモデルがプレミアムリクエストを消費するモデルである場合には、プレミアムリクエストを消費しないモデルに自動的に切り替える
  - ゼロプレミアムリクエストモードが有効かつ、プレミアムリクエストを消費しないモデルが存在しない場合には、ユーザーにエラーを通知する
    - doctor でもチェックする
- Config 設定追加: debug mock copilot unsafe tools for copilot enabled
  - 目的: 開発中は、開発者のホストマシン上で動かすことになるので、危険なツールは使わせないようにしたい
    - 例えば、ファイルシステムにアクセスするツールやシェル実行ツールは、開発中はモックに置き換えるなど
    - web fetch 等はまあ問題ないと思う
  - 設定ファイルで設定できる。オプショナルで、デフォルトは false
  - これが true のときには、一部のツールはモックに置き換わる
  - 置き換わるという表現をしているが、実際には、allow するツールを明示的に指定する
    - 一部の安全なビルトインツール
    - 通常の `copilotclaw_*` ツール
    - `copilotclaw_debug_mock_*` という、危険なビルトインツールをモックに置き換えたツール
  - `copilotclaw_*` ツールは基本的にはモックに置き換えない
- 仕様検討の参考に openclaw の codebase を参照すべき
  - openclaw はあくまで参考であって、完全に同じにする必要はない
  - openclaw のよい点を取り入れる

## Doctor コマンド

<!-- 2026-03-26 -->
- openclaw のような doctor コマンドを追加したい
  - 環境の診断・修復を行うコマンド
  - ただし interactive ではない（後述の CLI 設計方針を参照）
  - 参考: openclaw は `openclaw doctor --fix` で config のマイグレーション等を行う

## CLI 設計方針

<!-- 2026-03-26 -->
- copilotclaw は基本的に interactive コマンドを採用しない
  - 理由: human には分かりやすいが、agent には難しいため
  - human は agent にやり方を聞くので、interactive で分かりやすい必要性がほぼない
- CLI 出力は全て no color。raw mode も使わない
  - 理由: agent には雑音になってしまうため

## Channel アーキテクチャの再設計

- gateway が内蔵する chat の仕組みは、channel の一種として設計されるべき
- 将来的に channel として Discord やテレグラム等もサポートする予定
- 内蔵 chat の履歴やチャネル情報を永続化するとき、それがどのレイヤーに属するのかを明確にする必要がある
- 現在の gateway は内蔵 chat 機能が密結合している状態なので、分離して channel の一種として設計しなおす必要がある
