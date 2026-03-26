# 提案: CLI・Install・Workspace

## アーキテクチャ方針: CLI 設計原則

### 方針: Non-interactive CLI

copilotclaw の CLI は全て非対話的（non-interactive）とする。対話的プロンプト（y/n 確認、選択メニュー等）は使用しない。

- 理由: human には分かりやすい対話的 UI も、agent にとっては扱いが難しい。copilotclaw の主要ユーザーである agent が CLI を操作することを前提に設計する
- human は agent にやり方を聞くので、対話的 UI で分かりやすくする必要性がほぼない

### 方針: Plain Text 出力

CLI 出力は全て plain text とする。カラーコード（ANSI escape sequences）は使用しない。raw mode も使用しない。

- 理由: agent にとってカラーコードや特殊制御文字は雑音になる
- 構造化データが必要な場合は JSON で出力する

## アーキテクチャ方針: Install / Workspace / Update

### Install

copilotclaw を install する仕組みを提供する。npm レジストリへの公開は行わない。

- GitHub リポジトリからの `git clone` + `pnpm install && pnpm build` が基本
- `copilotclaw setup` コマンドで初期化（config + workspace 作成）
- エントリポイントスクリプトで Node バージョンチェック

### パッケージ構成

monorepo として正しいパッケージ構成に移行する。

- root `package.json` は `private: true` — 公開・install の対象ではない
- CLI エントリポイント用サブパッケージ `packages/cli/` を新設:
  - `bin` フィールド（`copilotclaw` コマンド）
  - `files` フィールド（`dist/` のみ）
  - `dependencies` に `"@copilotclaw/gateway": "workspace:*"`, `"@copilotclaw/agent": "workspace:*"` を宣言
- `packages/gateway/` と `packages/agent/` は `dependencies` に外部依存（`@github/copilot-sdk` 等）を宣言
- `npm pack` / `npm install -g tgz` は `packages/cli/` に対して実行
- npm が依存ツリーを正しく解決し、`@github/copilot-sdk` 等がインストール先に配置される

```
copilotclaw (root, private: true)
├── packages/cli/         ← npm pack / install -g の対象
│   ├── package.json      ← bin, files, dependencies (workspace:*)
│   └── dist/
├── packages/gateway/     ← @copilotclaw/gateway
│   ├── package.json      ← dependencies (外部依存)
│   └── dist/
└── packages/agent/       ← @copilotclaw/agent
    ├── package.json      ← dependencies (@github/copilot-sdk 等)
    └── dist/
```

### Workspace

copilotclaw の作業ディレクトリ兼設定ストレージ。

- デフォルト: `~/.copilotclaw/workspace/`
- config, sessions, credentials 等を `~/.copilotclaw/` 以下に配置
- workspace 内にプロジェクト固有のブートストラップファイルを配置可能

### Update

copilotclaw のセルフアップデート機能。

- `copilotclaw update` コマンド
- デフォルト upstream: `https://github.com/roc554776/copilotclaw.git`（config の `upstream` で変更可能）
- 作業ディレクトリ: `~/.copilotclaw/source/`（profile 非依存 — ソースは全 profile で共有）
- 動作フロー:
  - `~/.copilotclaw/source/` が存在しなければ `git init`
  - `git fetch <upstream> --depth 1` → `git checkout FETCH_HEAD`
  - SHA 変更なし → `already up to date`
  - `pnpm install --frozen-lockfile` → `pnpm run build`
  - `npm pack` → tgz 生成
  - `npm install -g <tgz>` → グローバルインストール更新
  - tgz を削除
- file URL アップストリーム対応（ローカル開発時に別ディレクトリのリポジトリを upstream に指定して update 可能）
- gateway 起動時のバージョンチェック通知

### Doctor

環境の診断・修復を行うコマンド。openclaw の `openclaw doctor` を参考にするが、copilotclaw の CLI 設計原則に従い非対話的とする。

- `copilotclaw doctor` コマンド
- 診断項目（想定）:
  - workspace ディレクトリの存在と整合性
  - config.json の形式妥当性
  - gateway プロセスの生存確認
  - agent プロセスの生存確認とバージョン互換性
  - IPC ソケットの状態（stale socket の検出）
- 出力: 各診断項目の結果を plain text で表示（pass / warn / fail）
- `--fix` オプション: 修復可能な問題（stale socket の削除、workspace ディレクトリの再作成等）を自動修復

### 永続化

channel 情報とメッセージ履歴を永続化する。

- 永続化対象: Channel（ID、作成日時）、Message（sender、本文、タイムスタンプ）、pending queue 状態
- 永続化レイヤーは channel 実装に依存しない（gateway コアレイヤーに属する）
- 初期実装は JSON ファイルベースで十分（将来的に SQLite 等への移行も視野）
- gateway 再起動後も channel と履歴が復元されること

### バージョン管理ポリシー

gateway と agent のバージョン管理ルールを定める。

- 全パッケージ（root, gateway, agent）のバージョンは一律に揃える
- gateway は `MIN_AGENT_VERSION` で agent の最低互換バージョンを定義する（実装済み）
- `MIN_AGENT_VERSION` の引き上げルール:
  - gateway-agent 間の compatibility が壊れる変更（IPC プロトコル変更等）が入った場合にのみ引き上げる
  - compatibility が壊れていない場合には引き上げてはならない（古い agent が不必要に拒否され、無駄なコストになる）
- バージョン更新時の互換性ルール:
  - IPC プロトコル変更 → minor バージョンアップ + `MIN_AGENT_VERSION` 更新
  - API エンドポイント変更 → minor バージョンアップ
  - 破壊的変更 → major バージョンアップ
- gateway と agent のバージョンは `package.json` の `version` フィールドで管理
- リリースチャンネル（stable / beta / dev）の導入は将来検討

### Profile

同一マシン上で複数の独立した copilotclaw インスタンスを実行するための仕組み。openclaw の Runtime Profile を参考にする。

- profile は必須ではない。`COPILOTCLAW_PROFILE` 環境変数が未指定の場合はデフォルトの無印 profile として動作する（既存の動作と完全に互換）
- 環境変数 `COPILOTCLAW_PROFILE` で名前付き profile を指定する
- profile ごとに以下のリソースが分離される:
  - workspace: `~/.copilotclaw/workspace-{{profile}}/`（デフォルト: `~/.copilotclaw/workspace/`）
  - 設定ファイル: `~/.copilotclaw/config-{{profile}}.json`（デフォルト: `~/.copilotclaw/config.json`）
  - gateway インスタンス（profile 同士の衝突を避け、設計をシンプルにするため）
  - agent process インスタンス（設計をシンプルにするため）
  - IPC ソケットパス: `{{tmpdir}}/copilotclaw-agent-{{profile}}.sock`（デフォルト: `copilotclaw-agent.sock`）

### 設定ファイル

copilotclaw の動作を設定ファイルで制御する仕組み。openclaw の `config.json` を参考にする。

- 配置場所: `~/.copilotclaw/config.json`（名前付き profile 使用時: `~/.copilotclaw/config-{{profile}}.json`）
- 形式: JSON

#### 設定の優先順位ルール

設定全般に以下の原則を適用する:

- **環境変数 > 設定ファイル**: 同一の設定項目に環境変数と設定ファイルの両方で値が与えられた場合、環境変数の値が優先される
- 特別な理由がある場合は、個別の設定項目について例外を設けることも検討可能

#### 初期の設定項目

| 設定キー | 型 | 環境変数 | 説明 |
| :--- | :--- | :--- | :--- |
| `upstream` | `string?` | `COPILOTCLAW_UPSTREAM` | update 時のアップストリーム URL（GitHub リポジトリ or file URL） |
| `port` | `number?` | `COPILOTCLAW_PORT` | gateway の HTTP サーバーのポート番号（デフォルト: 19741） |
| `model` | `string?` | `COPILOTCLAW_MODEL` | デフォルトで使用するモデル。未指定時はプレミアムリクエスト消費が最小のモデルを動的選択 |
| `zeroPremium` | `boolean?` | `COPILOTCLAW_ZERO_PREMIUM` | ゼロプレミアムリクエストモード（デフォルト: false） |
| `debugMockCopilotUnsafeTools` | `boolean?` | `COPILOTCLAW_DEBUG_MOCK_COPILOT_UNSAFE_TOOLS` | 開発用モックツールモード（デフォルト: false） |

今後、設定項目は必要に応じて追加される。

#### デフォルトモデル選択

`model` が未指定の場合、利用可能なモデルの中からプレミアムリクエスト消費が最も少ないモデルを動的に選択する。

#### ゼロプレミアムリクエストモード

プレミアムリクエストを一切消費せずに利用したいユーザー向けのモード。

- `zeroPremium: true` の場合:
  - `model` が指定されていてもプレミアムリクエストを消費するモデルであれば、プレミアムリクエストを消費しないモデルに自動的に切り替える
  - プレミアムリクエストを消費しないモデルが存在しない場合は、ユーザーにエラーを通知する
  - doctor でもこの状態をチェックする

#### 開発用モックツールモード

開発中に危険なビルトインツール（ファイルシステムアクセス、シェル実行等）をモックに置き換えるモード。開発者のホストマシン上で copilotclaw を動かす際の安全策。

- `debugMockCopilotUnsafeTools: true` の場合、セッション作成時に allow するツールを明示的に制限する:
  - 一部の安全なビルトインツール（web fetch 等）
  - 通常の `copilotclaw_*` ツール（gateway との通信用 — モックに置き換えない）
  - `copilotclaw_debug_mock_*` ツール（危険なビルトインツールのモック版）
- `debugMockCopilotUnsafeTools: false`（デフォルト）の場合、ツール制限なし

#### Config CLI コマンド

CLI から設定ファイルを直接編集せずに設定値を変更・確認できるコマンドを提供する。openclaw の `config set` / `config get` を参考にする。

```
copilotclaw config get <key>
  → 指定キーの現在の値を表示（環境変数による上書きも考慮した解決済みの値）

copilotclaw config set <key> <value>
  → 設定ファイルの指定キーに値を書き込む
  → 環境変数が設定されている場合は、環境変数が優先される旨を警告表示
```

| サブコマンド | 用途 |
| :--- | :--- |
| `config get <key>` | 設定値の取得（解決済みの値を表示） |
| `config set <key> <value>` | 設定値の変更（config.json に書き込み） |

#### Setup 時のポート自動選択

`copilotclaw setup` 実行時に、デフォルトポート（19741）が既に使用されていた場合、空いているポートを自動的に探して設定ファイルに書き込む。

ポート選択ロジック:
- あらかじめ定義された候補ポートリストから選択する（ランダムポートではなく決定論的）
- 候補ポートは well-known ports、一般的な開発ポート（3000, 8080 等）、ラウンドナンバーとその派生を避けた番号とする
- 候補リストを順に試し、最初に空いているポートを採用する
- ポートの空き確認は `net.createServer().listen()` で実際にバインドを試みる方式とする
- 選択されたポートを `config.json` の `port` に書き込む

```
copilotclaw setup
  → デフォルトポート (19741) の空き確認
  → 空いている → そのまま使用（config に port は書き込まない = デフォルト値を使用）
  → 使用中 → 候補ポートリストから空きポートを探索
    → 空きポート発見 → config.json に port を書き込み
    → 全候補が使用中 → エラー（手動設定を促す）
```

