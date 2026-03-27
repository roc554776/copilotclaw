# 提案: Profile 機能の完成

## State ディレクトリの profile 分離

OpenClaw に合わせて、profile ごとに state ディレクトリ自体を分離する。

**現在の方式:**
```
~/.copilotclaw/                    # デフォルト profile の全データ
~/.copilotclaw/workspace-prod/     # prod profile の workspace
~/.copilotclaw/config-prod.json    # prod profile の config
```

**目標の方式（OpenClaw 準拠）:**
```
~/.copilotclaw/                    # デフォルト profile
  ├── config.json
  ├── data/store.json
  ├── SOUL.md, AGENTS.md, ...
  └── memory/

~/.copilotclaw-prod/               # prod profile（ディレクトリ自体が別）
  ├── config.json
  ├── data/store.json
  ├── SOUL.md, AGENTS.md, ...
  └── memory/
```

**OpenClaw の比較:**

| 項目 | OpenClaw | CopilotClaw（目標） |
|---|---|---|
| デフォルト | `~/.openclaw/` | `~/.copilotclaw/` |
| 名前付き profile | `~/.openclaw-{{profile}}/` | `~/.copilotclaw-{{profile}}/` |
| Config | state dir 内の `openclaw.json` | state dir 内の `config.json` |

**実装変更:**

`workspace.ts` の `getWorkspaceRoot()`:
```typescript
// Before
if (p !== undefined) return join(BASE_DIR, `workspace-${p}`);
return BASE_DIR;

// After
if (p !== undefined) return join(homedir(), `.copilotclaw-${p}`);
return join(homedir(), ".copilotclaw");
```

`config.ts` の `getConfigFilePath()`:
```typescript
// Before
if (p !== undefined) return join(BASE_DIR, `config-${p}.json`);
return join(BASE_DIR, "config.json");

// After
return join(getWorkspaceRoot(p), "config.json");
```

**update ディレクトリ:**
`~/.copilotclaw/source/` は profile 非依存で変更なし（全 profile で共有）。

## CLI --profile オプション

全コマンドに `--profile` オプションを追加する。現在は `COPILOTCLAW_PROFILE` 環境変数のみで profile を指定する方式だが、CLI オプションがないため使い勝手が悪い。

**実装方針:**

CLI エントリポイント（`packages/cli/bin/copilotclaw.mjs`）で `--profile {{name}}` 引数をパースし、`process.env.COPILOTCLAW_PROFILE` に設定する。これにより、下流の全コマンド（gateway/agent サブプロセス含む）が環境変数経由で profile を受け取る。各コマンド個別の対応は不要。

```javascript
// copilotclaw.mjs — コマンドパース前に --profile を処理
const profileIdx = args.indexOf("--profile");
if (profileIdx !== -1 && args[profileIdx + 1]) {
  process.env.COPILOTCLAW_PROFILE = args[profileIdx + 1];
  args.splice(profileIdx, 2); // --profile と値を引数リストから除去
}
```

**USAGE 更新:**
```
Global options:
  --profile <name>       Use a named profile (overrides COPILOTCLAW_PROFILE)
```

**対象コマンド（全コマンド）:**
- setup, start, stop, restart, update, config get/set, doctor, agent stop

**優先順位:**
- `--profile` CLI オプション > `COPILOTCLAW_PROFILE` 環境変数

## 現状の問題（profile パラメータ伝搬）

Profile 機能は `COPILOTCLAW_PROFILE` 環境変数と `getProfileName()` 関数で設計されているが、実際のコマンド実装では profile パラメータの伝搬が広範に欠落している。結果として、異なる profile で同時実行すると以下が発生する:

- 同じ workspace ディレクトリを共有（データ破壊）
- 同じポートで起動を試みる（起動失敗）
- 同じ config.json を読み書き（設定の混線）
- 同じ store.json を使用（channel/メッセージの混線）

## 修正方針

全ての workspace/config/port 関連関数呼び出しに `getProfileName()` を渡す。パターンは一貫している:

```typescript
// Before (profile を無視)
getWorkspaceRoot()
resolvePort()
loadConfig()

// After (profile 対応)
getWorkspaceRoot(getProfileName())
resolvePort(getProfileName())
loadConfig(getProfileName())
```

## 影響範囲

### setup.ts（7箇所）

setup コマンドは profile 対応の最重要ポイント。`copilotclaw setup` が profile ごとの workspace と config を正しく生成する必要がある。

- `getWorkspaceRoot()` → `getWorkspaceRoot(getProfileName())`
- `getDataDir()` → `getDataDir(getProfileName())`
- `ensureWorkspace()` → `ensureWorkspace(getProfileName())`
- `ensureConfigFile()` → `ensureConfigFile(getProfileName())`
- `getConfigFilePath()` → `getConfigFilePath(getProfileName())`
- `loadConfig()` → `loadConfig(getProfileName())`
- `saveConfig()` → `saveConfig(..., getProfileName())`
- `getProfileName` の import 追加

### daemon.ts（3箇所）

gateway デーモンの起動時に profile-specific な store と port を使う。

- `ensureWorkspace()` → `ensureWorkspace(getProfileName())`
- `getStoreFilePath()` → `getStoreFilePath(getProfileName())`
- `resolvePort()` → `resolvePort(getProfileName())`
- `getProfileName` の import 追加

### doctor.ts（9箇所）

診断コマンドが正しい profile の状態を検査する。

- workspace/config/port/socket の全チェックに `getProfileName()` を渡す
- `getProfileName` の import 追加

### index.ts（2箇所）

gateway start コマンドのポート解決と status レスポンス。

- `resolvePort()` → `resolvePort(getProfileName())`
- `getWorkspaceRoot()` → `getWorkspaceRoot(getProfileName())`

### stop.ts / restart.ts（各1箇所）

正しい profile の gateway を停止/再起動する。

- `resolvePort()` → `resolvePort(getProfileName())`

### config-cli.ts（4箇所）

config get/set が正しい profile の設定を操作する。

- `loadConfig()`, `ensureConfigFile()`, `loadFileConfig()`, `saveConfig()` に `getProfileName()` を渡す
- `getProfileName` の import 追加

### server.ts（2箇所）

API レスポンスが正しい profile の情報を返す。

- `loadConfig()` → `loadConfig(getProfileName())`
- `getWorkspaceRoot()` → `getWorkspaceRoot(getProfileName())`

## 対応不要

- **update.ts** — upstream source directory は profile 非依存（全 profile で共有）。対応不要
- **agent ipc-paths.ts** — 既に profile 対応済み
- **CLI copilotclaw.mjs** — 環境変数を子プロセスに継承。対応不要

## テスト方針

- 各コマンドで `COPILOTCLAW_PROFILE=test` を設定して実行し、profile-specific なパスが使われることを検証
- 2 つの profile を同時起動して衝突しないことを検証

## Profile ごとの認証情報設定

### SDK 調査結果

Copilot SDK (`CopilotClient`) の認証メカニズム:

| 方式 | 設定箇所 | 動作 |
|:---|:---|:---|
| `useLoggedInUser: true` (デフォルト) | CopilotClient 構築時 | gh CLI / OAuth ストアの認証情報を使用 |
| `githubToken` | CopilotClient 構築時 | 指定したトークンで認証。CLI プロセスに `COPILOT_SDK_AUTH_TOKEN` 環境変数として渡される |
| 環境変数 (`GH_TOKEN` 等) | プロセス環境 | SDK が自動検出。優先順: `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` |
| `cliUrl` | CopilotClient 構築時 | 外部 CLI サーバーに接続（認証はサーバー側が管理）。`githubToken`/`useLoggedInUser` と排他 |

重要な制約:
- 各 `CopilotClient` インスタンスは独自の CLI サーバープロセスを spawn する（共有しない）
- `githubToken` は構築時に固定され、変更不可
- 異なる認証情報を使うには、異なる `CopilotClient` インスタンスを生成する

サポートされるトークン形式:
- `gho_` — OAuth user access tokens
- `ghu_` — GitHub App user access tokens
- `github_pat_` — Fine-grained personal access tokens
- `ghp_` — Classic personal access tokens（deprecated、非サポート）

### OAuth 見送りの経緯

OAuth Device Flow を使うには GitHub に OAuth App を登録して client_id を取得する必要がある。Device Flow は public client 向け設計であり client_id は配布物に含める方式だが、現時点では時期尚早として見送り。

将来の対応方針: ユーザーが自分で OAuth App を登録し client_id を config に設定する方式とする。closed なアプリなので多少の UX の悪さは許容されるが、具体的実行可能な手順をドキュメントでユーザーに示す必要がある。

### 対応する認証タイプ

**gh auth** — `gh auth login` で取得済みの認証情報を使う

- SDK は `useLoggedInUser: true` のフォールバックとして gh CLI の認証情報を自動検出する（認証優先度の最下位）
- profile ごとに異なる GitHub アカウントの gh auth を使うには、`gh auth login` で取得したトークンを `GH_TOKEN` 環境変数経由で渡す
- `gh auth token` コマンドでトークンを取得できる → config で `tokenCommand` として指定可能
- config に `user` を設定した場合は `gh auth token --user {{user}}` を使い、特定アカウントのトークンを取得する

**PAT** — Fine-grained Personal Access Token を使う

- GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens で生成
- `github_pat_` プレフィクスのトークンを `githubToken` オプションで渡す
- Copilot に必要なスコープ/パーミッションの調査が必要

### 設計方針

**config.json に認証設定を追加:**

```json
{
  "port": 19741,
  "auth": {
    "type": "gh-auth",
    "user": "my-work-account"
  }
}
```

`user` を設定した場合は `gh auth token --user my-work-account` でトークンを取得する。`user` が未設定の場合は `gh auth token` をそのまま実行する（デフォルトアカウント）。`hostname` も同様にオプショナルで指定可能。

`tokenCommand` で完全にカスタマイズすることも可能:

```json
{
  "port": 19741,
  "auth": {
    "type": "gh-auth",
    "tokenCommand": "gh auth token --hostname github.com --user my-work-account"
  }
}
```

```json
{
  "port": 19741,
  "auth": {
    "type": "pat",
    "tokenEnv": "COPILOTCLAW_WORK_TOKEN"
  }
}
```

- `auth` フィールドはオプショナル。未設定時は `useLoggedInUser: true`（既存動作を維持）
- 認証タイプ:
  - `type: "gh-auth"` — gh CLI の認証情報を使う
  - `type: "pat"` — Fine-grained PAT を使う
  - `type: "oauth"` — 将来対応（OAuth App 登録 + Device Flow）
- シークレットの間接参照（config ファイルにトークン本体を書かない）:
  - `tokenEnv` — 環境変数名を指定。環境変数からトークンを読み取る
  - `tokenFile` — ファイルパスを指定。ファイルからトークンを読み取る
  - `tokenCommand` — コマンドを指定。stdout からトークンを読み取る（`gh auth token` 等）

**agent-session-manager.ts への反映:**

config の `auth` 設定に基づいて、`CopilotClient` のコンストラクタに `githubToken` を渡す。

```
config.auth が未設定
  → new CopilotClient() (デフォルト: useLoggedInUser: true)

config.auth.type === "gh-auth"
  → tokenCommand を実行してトークン取得
  → new CopilotClient({ githubToken: resolved })

config.auth.type === "pat"
  → tokenEnv / tokenFile からトークン取得
  → new CopilotClient({ githubToken: resolved })
```

### 利用動線

**gh auth を使う場合（user 指定）:**

```bash
# profile を作成
copilotclaw --profile work setup

# 別の GitHub アカウントで gh にログイン
gh auth login

# config に認証設定を追加（user を指定して特定アカウントのトークンを使う）
copilotclaw --profile work config set auth.type gh-auth
copilotclaw --profile work config set auth.user my-work-account

# work profile は gh auth token --user my-work-account で取得したトークンを使用
copilotclaw --profile work start
```

**gh auth を使う場合（デフォルトアカウント）:**

```bash
copilotclaw --profile work config set auth.type gh-auth
# user 未設定 → gh auth token のデフォルトアカウントを使用
```

**PAT を使う場合:**

```bash
# profile を作成
copilotclaw --profile work setup

# GitHub で Fine-grained PAT を生成し、環境変数に設定（.bashrc 等に追加）
export COPILOTCLAW_WORK_TOKEN="github_pat_xxxx..."

# config に認証設定を追加
copilotclaw --profile work config set auth.type pat
copilotclaw --profile work config set auth.tokenEnv COPILOTCLAW_WORK_TOKEN

# work profile は PAT で認証
copilotclaw --profile work start
```

**デフォルト（認証設定なし）:**

```bash
# デフォルト profile は Copilot CLI の既存認証をそのまま使う
copilotclaw start
```

**診断:**

```bash
copilotclaw --profile work doctor
# → auth: gh-auth (user: my-work-account) ✓
```

### 影響範囲

| ファイル | 変更内容 |
|:---|:---|
| `packages/gateway/src/config.ts` | `auth` 設定の型定義と読み込み |
| `packages/gateway/src/server.ts` | `/api/status` に `auth` 情報を公開（type のみ、トークンは公開しない） |
| `packages/agent/src/index.ts` | gateway config から `auth` を受け取り、トークンを解決して `AgentSessionManager` に渡す |
| `packages/agent/src/agent-session-manager.ts` | `CopilotClient` 構築時に `githubToken` を渡す |
| `packages/gateway/src/doctor.ts` | 認証設定の妥当性チェック（環境変数の存在、コマンドの実行可否、ファイルの存在等） |

### セキュリティ考慮

- config ファイルにトークン本体を書かない（`tokenEnv` / `tokenFile` / `tokenCommand` で間接参照）
- `/api/status` で認証情報の type は公開するが、トークン値は公開しない
- ログにトークン値を出力しない
- `tokenFile` 使用時はパーミッションチェック（0600 推奨）を doctor でチェック
- `tokenCommand` 使用時はコマンドインジェクション対策（シェル展開を使わず `execFileSync` で実行）
