# 要求定義: Profile 機能の完成

<!-- TODO: 未実装 — profile 対応が不完全。以下の全ファイルで profile パラメータの伝搬が欠落している -->

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
