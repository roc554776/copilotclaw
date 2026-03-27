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
