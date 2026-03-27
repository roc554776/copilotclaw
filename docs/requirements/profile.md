# 要求定義: Profile 機能の完成

### Req: State ディレクトリの profile 分離


OpenClaw に合わせて、profile ごとに state ディレクトリ自体を分離する。

- 現在の方式: `~/.copilotclaw/workspace-{{profile}}`, `~/.copilotclaw/config-{{profile}}.json`
- 目標の方式（OpenClaw 準拠）: `~/.copilotclaw-{{profile}}/` に全データを格納
  - デフォルト profile（無印）: `~/.copilotclaw/`
  - 名前付き profile: `~/.copilotclaw-{{profile}}/`
- config: `~/.copilotclaw-{{profile}}/config.json`（state ディレクトリ内に固定名で配置）
- workspace root = state ディレクトリ自体
- data: `~/.copilotclaw-{{profile}}/data/`
- 影響範囲: `workspace.ts` の `getWorkspaceRoot()` と `config.ts` の `getConfigFilePath()` の変更が中心

### Req: CLI --profile オプション

全コマンドに `--profile` オプションを追加し、環境変数なしで profile を指定できるようにする。

- 対象コマンド: setup, start, stop, restart, update, config get/set, doctor, agent stop
- `--profile {{name}}` を指定した場合、`COPILOTCLAW_PROFILE` 環境変数と同等の効果を持つ
- CLI オプションと環境変数の両方が指定された場合は CLI オプションが優先
- OpenClaw では `--profile` CLI フラグで同様の機能を提供している

### Req: Profile による完全な分離

`COPILOTCLAW_PROFILE` 環境変数で指定された profile ごとに、全コンポーネントが完全に分離して動作すること。

現状、profile 対応が以下のコンポーネントで欠落しており、異なる profile を同時に実行すると衝突する:

**gateway 側（packages/gateway/src/）:**
- `setup.ts` — workspace/config 生成が profile を無視（デフォルトパスに生成される）
- `daemon.ts` — store パスとポート解決が profile を無視（同じ store.json と port を使う）
- `doctor.ts` — 全ての診断チェックが profile を無視
- `index.ts` — ポート解決と status レスポンスの workspace が profile を無視
- `stop.ts` — ポート解決が profile を無視（別 profile の gateway を停止する）
- `restart.ts` — ポート解決が profile を無視
- `config-cli.ts` — config 読み書きが profile を無視（別 profile の config を変更する）
- `server.ts` — config 読み込みと workspace パスが profile を無視

**具体的な修正内容:**
- `getWorkspaceRoot()`, `getDataDir()`, `getStoreFilePath()`, `ensureWorkspace()`, `getConfigFilePath()`, `loadConfig()`, `saveConfig()`, `ensureConfigFile()`, `resolvePort()` の全呼び出しに `getProfileName()` を渡す
- `getProfileName` の import が欠落しているファイル: setup.ts, daemon.ts, doctor.ts, config-cli.ts

**agent 側:**
- `ipc-paths.ts` — profile 対応済み（問題なし）
- `index.ts` — gateway からの config に依存。gateway 側が修正されれば連動して正しく動作する
