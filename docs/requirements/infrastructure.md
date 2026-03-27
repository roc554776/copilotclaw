# 要求定義: インフラストラクチャ

### Req: 正しい monorepo パッケージ構成

root パッケージは `private: true` とし、CLI エントリポイント用のサブパッケージを設ける。

- root パッケージを `npm install -g` するのではなく、CLI サブパッケージを pack/install する
- サブパッケージ同士の依存は `workspace:*` で宣言し、npm が依存を正しく解決できるようにする
- update コマンドは CLI サブパッケージに対して `npm pack` → `npm install -g tgz` を実行する

### Req: Dashboard フロントエンド技術の移行

Dashboard のフロントエンドを vite + React に移行する。

- 現在の server-side HTML テンプレート + inline JS 方式は、機能の複雑化に伴い保守性とテスタビリティが低下している
- vite + React への移行により、型安全な JSX、コンポーネントテスト（React Testing Library）、hooks による状態管理を実現する

### Req: Copilot 物理セッションの状態可視化

API およびダッシュボードで、agent session（論理）と Copilot SDK session（物理）の両方の状態をリアルタイムに確認できるようにする。

- agent session → 物理 session → subagent 物理 session（0〜複数）の3層構造を可視化する
- サマリー: プレミアムリクエスト残量/上限、利用可能モデルとプレミアムリクエスト乗数、各物理セッションの session ID / model / コンテキストトークン使用率 / 開始時刻 / 現在の状態
- 詳細: サマリーに加えて現在のコンテキスト内容（システムプロンプト + 会話履歴）
- ダッシュボードのモーダルでサマリーを表示し、個別セッションをクリックで詳細表示

### Req: Profile による複数インスタンス分離

同一マシン上で複数の独立した copilotclaw インスタンスを実行できるようにする。

- `COPILOTCLAW_PROFILE` 環境変数で profile を指定する（未指定時はデフォルトの無印 profile）
- profile ごとに workspace、設定ファイル、gateway インスタンス、agent process インスタンス、IPC ソケットパスを分離する

### Req: 設定ファイルによる動作制御

設定ファイル（`config.json`）で copilotclaw の動作を制御できるようにする。

- 環境変数と設定ファイルの両方で値を与えられる。環境変数が優先される（原則）
- 設定項目: upstream（update 用 URL）、port（gateway ポート）、model（デフォルトモデル）、zeroPremium（ゼロプレミアムリクエストモード）、debugMockCopilotUnsafeTools（開発用モックツールモード）
- CLI コマンド（`config get` / `config set`）で設定値の取得・変更ができる

### Req: ログのファイル出力と構造化ログ

gateway および agent のログをファイルに出力し、プロセス停止時の調査を可能にする。

- gateway と agent の両プロセスのログをファイルに永続化する
- ログは構造化ログ（structured logging）を採用する
- 将来的に OpenTelemetry へ移行することを前提とする <!-- TODO: 未実装 -->

### Req: エラー無限ループの抑制

エラーが継続する場合に無限ループを引き起こさない設計上の工夫を、特別な理由がない限り常に施す。

- リトライを行う箇所では、連続失敗時にバックオフまたはリトライ上限を設ける
- 例外的にバックオフを設けない場合は、その理由を明示する

### Req: 設定ファイルのスキーマバージョンとマイグレーション

設定ファイル（`config.json`）にスキーマバージョンを持たせ、バージョン更新時に互換性が壊れないようにする。

- 設定ファイルにスキーマバージョン（整数）を追加する
- スキーマバージョンが古い設定ファイルを読み込んだとき、段階的なマイグレーションを自動で行う
  - v1→v2, v2→v3, ... のようなマイグレーション関数を順番に適用し、最新バージョンに到達させる
- スキーマバージョンとアプリバージョンは独立（一致する必要はない）

### Req: CLI 設計原則

copilotclaw の CLI は non-interactive とする。カラーコード、raw mode は使用しない。

- 理由: agent が CLI を操作することを前提とした設計。interactive UI や色付き出力は agent にとって雑音
