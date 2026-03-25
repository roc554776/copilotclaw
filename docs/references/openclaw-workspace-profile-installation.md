# OpenClaw Investigation: Workspace, Profile, Installation, Update, Persistence

Source: https://github.com/openclaw/openclaw

## Workspace

Workspace は agent の作業ディレクトリ兼設定ストレージ。

### 場所

- デフォルト: `~/.openclaw/workspace/`
- プロファイル指定時: `~/.openclaw/workspace-{{profile}}/`（`OPENCLAW_PROFILE` 環境変数で決定）
- CLI `--workspace` フラグまたは config の `agents.defaults.workspace` で上書き可能

### 構造

workspace ディレクトリには以下のブートストラップ markdown ファイルが自動生成される:

| ファイル | 用途 |
|:---|:---|
| `AGENTS.md` | agent のパーソナリティ・指示 |
| `SOUL.md` | 振る舞い定義 |
| `TOOLS.md` | ツール設定 |
| `IDENTITY.md` | ペルソナ |
| `USER.md` | ユーザー情報 |
| `HEARTBEAT.md` | ハートビート設定 |
| `BOOTSTRAP.md` | セットアップ指示 |
| `MEMORY.md` | 永続メモリ |

### Multi-Agent

- config の `agents.list[].workspace` で agent ごとに独立した workspace を指定可能
- agent ごとに独立したブートストラップファイルとメモリを持てる

### 状態管理

- `~/.openclaw/.openclaw/workspace-state.json` にセットアップ進捗を記録
  - `bootstrapSeededAt`, `setupCompletedAt` タイムスタンプ

### 実装箇所（openclaw リポジトリ内）

- `src/agents/workspace.ts:12-22` — workspace パス解決
- `src/agents/workspace.ts:327-465` — `ensureAgentWorkspace()` による初期化

## Profile

Profile には 2 つの意味がある。

### Runtime Profile（ワークスペース分離）

- `OPENCLAW_PROFILE` 環境変数で指定
- 同一マシン上で複数の独立した openclaw インスタンスを実行するための仕組み
- workspace ディレクトリ名に反映: `workspace-{{profile}}`
- 例: `OPENCLAW_PROFILE=staging` → `~/.openclaw/workspace-staging/`

### Auth Profile（認証設定）

- config の `auth.profiles` セクションに `{ [profileId]: AuthProfileConfig }` として定義
- `AuthProfileConfig` の構造（`src/config/types.auth.ts`）:
  - `provider`: 使用するプロバイダ
  - `mode`: 認証方式 — `"api_key"` | `"oauth"` | `"token"`
  - `email?`: オプション
- 用途: プロバイダごとに複数の認証プロファイルを持ち、フェイルオーバーやローテーションに使用

## Installation

### インストール方法

| 方法 | コマンド |
|:---|:---|
| npm (推奨) | `npm install -g openclaw@latest` |
| pnpm | `pnpm add -g openclaw@latest` |
| ソースから | `git clone` → `pnpm install && pnpm build` |
| Docker | `docker-compose.yml` 使用 |
| Nix | `github.com/openclaw/nix-openclaw` |

### エントリポイント

- `openclaw.mjs` — ブートストラップスクリプト（Node バージョンチェック + `dist/entry.js` ロード）
- `package.json` の `bin` フィールドで `openclaw` コマンドとして公開
- Node 22.12+ 必須（24 推奨）

### リリースチャンネル

| チャンネル | npm dist-tag | バージョン形式 |
|:---|:---|:---|
| stable | `latest` | `vYYYY.M.D` |
| beta | `beta` | `vYYYY.M.D-beta.N` |
| dev | `dev` | `main` の HEAD |

### インストール先

npm グローバルインストール時: `/usr/local/lib/node_modules/openclaw/` 等（OS 依存）

npm パッケージに含まれるもの:
- `openclaw.mjs` — エントリポイント
- `dist/` — コンパイル済み TypeScript
- `docs/` — ドキュメント
- `skills/` — バンドル済みプラグイン

### データディレクトリ（`~/.openclaw/` 以下）

| パス | 用途 |
|:---|:---|
| `config.json` | 設定ファイル |
| `workspace/` | デフォルト workspace |
| `workspace-{{profile}}/` | プロファイル別 workspace |
| `sessions/` | セッションログ |
| `credentials/` | 認証情報（`openclaw login` で書き込み） |
| `.openclaw/workspace-state.json` | workspace セットアップ状態 |

### セットアップフロー

```
openclaw setup（基本）
  → config + workspace ディレクトリ作成
  → ブートストラップファイル書き込み

openclaw onboard（対話式ウィザード、推奨）
  → gateway 設定
  → workspace 設定
  → channel / skills / auth 設定
  → systemd/launchd daemon インストール（オプション）

openclaw gateway
  → WebSocket サーバー起動（デフォルト port 18789）
```

## Update

`openclaw update` コマンドでセルフアップデートを行う。

### コマンド体系

| コマンド | 用途 |
|:---|:---|
| `openclaw update` | アップデート実行（`--channel`, `--tag`, `--dry-run`, `--yes` 等のフラグ） |
| `openclaw update status` | 現在のチャンネルとアップデート可否を表示 |
| `openclaw update wizard` | 対話式のチャンネル選択 + 再起動確認 |
| `openclaw --update` | `openclaw update` のエイリアス |

### インストール種別による更新方式

#### git checkout の場合

- `dev` チャンネル: `git fetch` → worktree で preflight 検証（最大 10 コミット） → rebase → `pnpm install` → build → `openclaw doctor --fix`
- `stable` / `beta` チャンネル: タグを fetch → detached HEAD でチェックアウト → 同様の build/doctor フロー
- ワーキングツリーが dirty な場合は拒否

#### npm / pnpm / bun グローバルインストールの場合

- パッケージマネージャを自動検出
- グローバルインストールルートを解決
- チャンネル/タグに応じた install spec でグローバルインストール実行
- npm の場合、初回失敗時に `--omit=optional` でフォールバック
- インストール後に `openclaw doctor --non-interactive` で検証

### 自動アップデート

gateway のバックグラウンドプロセスとして動作する。

config:
```json
{
  "update": {
    "channel": "stable",
    "checkOnStart": true,
    "auto": {
      "enabled": false,
      "stableDelayHours": 6,
      "stableJitterHours": 12,
      "betaCheckIntervalHours": 1
    }
  }
}
```

#### stable チャンネルの段階的ロールアウト

- 新バージョン初検出時刻 T を記録
- 適用タイミング: T + `stableDelayHours` + random(`stableJitterHours`)
- インストール ID を使ったデバイスごとの決定論的ジッター（フリート全体の同時更新を防止）

#### beta チャンネル

- `betaCheckIntervalHours`（デフォルト 1 時間）ごとにチェック
- 利用可能になり次第即座に適用
- バージョンごとに 1 時間のクールダウン

### チェック間隔

| 条件 | 間隔 |
|:---|:---|
| 自動更新無効 | 24 時間 |
| 自動更新有効（beta） | 15 分〜1 時間 |
| 自動更新有効（stable） | 1 時間 |

### 更新状態の永続化

`update-check.json` で管理:
- `lastCheckedAt` — 最終チェック時刻
- `lastAvailableVersion` / `lastAvailableTag` — レジストリ上の最新バージョン
- `autoFirstSeenAt` / `autoFirstSeenVersion` — 新バージョン初検出時
- `autoLastAttemptAt` / `autoLastSuccessAt` — 自動更新試行/成功時刻

### 更新後の処理

- config のマイグレーション: `openclaw doctor --fix` で不明な config キーを除去
- プラグイン同期: `dev` → バンドル版に切替、`stable`/`beta` → npm 版に同期
- daemon 再起動（`--no-restart` で抑制可能）
- gateway ヘルスチェック + ポート確認

### 実装箇所（openclaw リポジトリ内）

- `src/infra/update-check.ts` — バージョン/ステータスチェック
- `src/infra/update-startup.ts` — 自動更新バックグラウンドスケジューラ
- `src/infra/update-runner.ts` — git/パッケージマネージャのオーケストレーション
- `src/infra/update-global.ts` — グローバル npm インストールユーティリティ
- `src/cli/update-cli/update-command.ts` — CLI コマンドハンドラ
- `src/plugins/update.ts` — プラグイン同期ロジック

## Persistence（永続化）

外部データベースサーバーへの依存はない。全てローカル/組み込み型。

### ファイルベース（コア）

| 対象 | 形式 | 場所 |
|:---|:---|:---|
| 設定 | JSON | `~/.openclaw/config.json` |
| 認証情報 | JSON | `~/.openclaw/credentials/` |
| セッション | JSONL | `~/.openclaw/agents/{{agentId}}/sessions/{{sessionId}}.jsonl` |
| セッション一覧 | JSON | `~/.openclaw/agents/{{agentId}}/sessions/sessions.json` |
| Workspace 状態 | JSON | `~/.openclaw/.openclaw/workspace-state.json` |
| アップデート状態 | JSON | `update-check.json` |
| Workspace ブートストラップ | Markdown | `~/.openclaw/workspace/*.md` |

### SQLite（メモリ/ナレッジ検索 — 組み込み）

デフォルトの memory backend として Node.js 組み込みの `DatabaseSync`（`node:sqlite`）を使用。

| テーブル | 用途 |
|:---|:---|
| `chunks_vec` | ベクトル埋め込み + FTS |
| `chunks_fts` | BM25 全文検索インデックス |
| `embedding_cache` | 埋め込みキャッシュ |
| `meta` | メタデータ KV ストア（JSON シリアライズ） |

- オプションで `sqlite-vec` 拡張（v0.1.7）によるベクトル検索をサポート
- DB ファイルは agent workspace ディレクトリ内に配置
- 同期アクセス（`DatabaseSync`）

### QMD Backend（代替 memory backend）

- 外部 `qmd` バイナリ（テキスト検索ユーティリティ）を子プロセスとして起動
- config で `memory.backend: "qmd"` を指定して切替
- 検索結果を QMD が管理する SQLite DB に格納

### LanceDB（拡張機能 — 長期記憶）

- パッケージ: `@openclaw/memory-lancedb` 拡張
- 依存: `@lancedb/lancedb` (^0.27.1)
- OpenAI による埋め込み生成 → LanceDB テーブル `memories` に格納
- 自動 recall/capture による長期記憶

### その他の組み込み DB

| 用途 | 場所 |
|:---|:---|
| Matrix 暗号化 | `~/.openclaw/matrix/crypto/store.db`, `matrix-sdk-crypto.sqlite3` |
| Signal | `signal.db` |
| DNS 状態 | `~/.openclaw/dns/openclaw.internal.db` |

### まとめ

- **コアプラットフォーム**: ファイルベースのみ（JSON, JSONL, Markdown）
- **メモリ/ナレッジ**: SQLite（組み込み、ネットワーク不要）
- **長期記憶**: LanceDB（拡張機能、オプション）
- **外部 DB サーバー**: なし（PostgreSQL, MongoDB, Redis 等への依存なし）
- **完全オフライン動作**: 初回セットアップ後はネットワーク不要で全機能が動作
