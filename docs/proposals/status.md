# 提案: 現状と今後

## 現状と今後

**実装済み:**
- Observability スタック一式（OTel Collector → Loki / Tempo / Prometheus → Grafana）
- Copilot Hooks によるイベントログ記録
- Grafana ダッシュボード（Copilot Token Usage）
- Copilot SDK を用いた Agent（session keepalive による停止制御を含む）
- pnpm monorepo 構造（tsconfig strictest 相当の設定）
- Gateway サーバー（インメモリ Store、API、チャット UI dashboard、冪等起動）
- Channel 機能（gateway 経由の agent-user 対話、`copilotclaw_` プレフィクスのカスタムツール）
- Channel ツール統廃合（`copilotclaw_send_message` / `copilotclaw_receive_input` / `copilotclaw_list_messages`）
- `assistant.message` イベントの channel タイムライン自動反映（`copilotclaw_send_message` のフォールバック）
- 抽象 Agent Session と物理 Copilot Session の分離（suspended 状態、channel binding 維持、reviveSession による自動復帰、`agent-bindings.json` 永続化）
- 物理 Session 停止後の記憶保持（copilotSessionId を suspended entry に保持、resumeSession で復元）
- Custom Agent 構成（channel-operator + worker の 2 agent 体制、`infer` フラグによる subagent 推論制御）
- Subagent 完了通知（`copilotclaw_receive_input` での通知 + `onPostToolUse` hook での通知）
- `onPostToolUse` hook によるシステムプロンプト補強（`copilotclaw_receive_input` 呼び出し義務の定期リマインド、compaction 直後リマインド、`<system>` タグ方式）
- `onPostToolUse` hook による新着 user message 通知
- `session.send()` 排除（session 開始時のみに限定）
- Gateway の Messages API（`GET/POST /api/channels/{{channelId}}/messages`）
- Agent バージョン互換性チェック（IPC `status` に `version` 追加、gateway 側で最低バージョン検証）
- Agent 手動停止コマンド（`packages/agent/src/stop.ts`）
- Dashboard ステータスバー（gateway status、agent version、session 状態の表示）
- 古い agent の強制停止・再起動オプション（`gateway start --force-agent-restart`）
- Agent session の意図しない停止時の channel 通知と "stopped" status
- Dashboard リアルタイム更新（SSE によるプッシュ型通信）
- Dashboard ステータス詳細モーダル（クリックで gateway/agent 詳細表示）
- Dashboard Processing インジケータ（processing 中にアニメーション付き表示）
- Workspace 機能（`~/.copilotclaw/` 以下の設定・データディレクトリ）
- 永続化（channel 情報 + メッセージ履歴の JSON ファイルベース永続化）
- Install 機能（setup コマンドで workspace 初期化）
- Update 機能（git pull ベースのセルフアップデート、file URL アップストリーム対応）
- バージョン管理ポリシーの策定とドキュメント化
- Channel アーキテクチャ再設計（ChannelProvider インターフェース導入、内蔵 chat を BuiltinChatChannel として分離）
- Gateway restart コマンド（`copilotclaw restart` で stop → start を 1 コマンド実行）
- `/api/status` に gateway version を追加
- Gateway による agent process 常時監視（30 秒ポーリングで生存確認 + バージョンチェック + 自動再起動）
- Agent session 実行中タイムアウト時の channel message 通知
- Agent session 寿命制限（デフォルト 2 日超過で replace）
- Agent session replace（deferred resume 方式: disconnect → 次の pending で resumeSession）
- `/api/status` に agentCompatibility（compatible / incompatible / unavailable）を追加
- Gateway start/restart CLI で agent ensure 完了を待ち、incompatible ならエラー終了
- Dashboard ログ表示（`/api/logs` + Logs パネル + LogBuffer）
- 自動テスト基盤（Vitest、mock session、mock fetch による agent テスト）
- Profile 機能（`COPILOTCLAW_PROFILE` による workspace・設定ファイル・gateway・agent・IPC ソケットの分離）
- 設定ファイル機能（`config.json` による動作設定、環境変数との優先順位ルール、`upstream` / `port` 設定項目）
- Setup 時のポート自動選択（デフォルトポート使用中の場合に候補リストから空きポートを探索・config に書き込み）
- Config CLI コマンド（`copilotclaw config get/set` による設定値の取得・変更）
- Doctor コマンド（環境診断・修復、非対話的、`--fix` オプション）
- デフォルトモデル選択設定（`model` / `zeroPremium` / `debugMockCopilotUnsafeTools` config + doctor チェック）
- Gateway `/api/status` に profile 名と config 設定を公開
- Copilot 物理セッション状態可視化（物理 session / subagent 追跡、`/api/quota` / `/api/models` エンドポイント、ダッシュボードモーダル表示）
- パッケージ構成の修正（root `private: true`、`packages/cli/` 新設、`workspace:*` 依存宣言、`npm pack` + `npm install -g tgz`）

- Profile 機能の完成（全コンポーネントで getProfileName() 伝搬修正）
- Workspace Bootstrap Files（SOUL.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md テンプレート生成 + setup 時の git init）
- System prompt に SOUL.md 優先読み取り指示を追加

- State ディレクトリの profile 分離（`~/.copilotclaw-{{profile}}/` 方式 — OpenClaw 準拠）

- CLI --profile オプション（全コマンドに `--profile {{name}}` オプションを追加）

- ログのファイル出力と構造化ログ（gateway.log / agent.log への JSON Lines 出力、agent stderr リダイレクト）
- セッション失敗時のバックオフ（30秒未満の即時失敗で60秒バックオフ、ポーリングループでスキップ）
- エラー詳細のユーザー通知（"stopped unexpectedly: {{reason}}" 形式でエラー理由を表示）

- Profile ごとの認証情報設定（gh auth + PAT 対応。config に auth 設定、tokenEnv/tokenFile/tokenCommand でシークレット間接参照、doctor チェック）

- 設定ファイルのスキーマバージョンとマイグレーション（configVersion フィールド、v0→v1 段階的マイグレーション、loadConfig 時の自動適用とファイル書き戻し、doctor チェック）

- 認証設定の名前空間移行（`auth.*` → `auth.github.*`、config migration v1→v2 で自動移行）

**今後の課題:**
- Profile 認証の OAuth 対応（ユーザーが OAuth App を登録し client_id を config に設定する方式）
- OpenTelemetry 導入（構造化ログ基盤は実装済み、OTel ログブリッジへの移行が残）
- Dashboard フロントエンドの vite + React 移行（server-side HTML テンプレート + inline JS → 型安全な JSX + コンポーネントテスト）
- Agent process 停止時の全セッション保存（disconnect → 次回起動時に resumeSession）
- コーディング支援ツール群（ファイル操作・シェル実行・検索・Git）の実装
- Observability スタックの独立リポジトリへの分離（`.example` パターンの導入を含む）
