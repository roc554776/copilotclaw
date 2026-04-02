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
- Channel ツール統廃合（`copilotclaw_send_message` / `copilotclaw_wait` / `copilotclaw_list_messages`）
- `assistant.message` イベントの channel タイムライン自動反映（`copilotclaw_send_message` のフォールバック）— gateway 側 `onSessionEvent` で処理（v0.62.0）
- 抽象 Agent Session と物理 Copilot Session の分離（suspended 状態、channel binding 維持、reviveSession による自動復帰、`agent-bindings.json` 永続化）
- 物理 Session 停止後の記憶保持（copilotSessionId を suspended entry に保持、resumeSession で復元）
- Custom Agent 構成（channel-operator + worker の 2 agent 体制、`infer` フラグによる subagent 推論制御）
- Subagent 完了通知（`copilotclaw_wait` での通知 + `onPostToolUse` hook での通知）
- `onPostToolUse` hook によるシステムプロンプト補強（`copilotclaw_wait` 呼び出し義務の定期リマインド、compaction 直後リマインド、`<system>` タグ方式）
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

- copilotclaw_wait のエラー不可侵性（いかなる例外でもエラーを返さず、keepalive と同一のレスポンスを返す。エラーはシステムログのみ）

- State Directory と Workspace の概念的・物理的分離（`{{stateDir}}/workspace/` サブディレクトリ。既存環境の自動マイグレーション。SessionConfig.workingDirectory を workspace に設定）
- 抽象セッションへのトークン消費履歴の紐づけ（物理 session をまたいだ累積追跡、bindings ファイルへの永続化、dashboard での累積トークン表示）

- Workspace Ensure（git init + bootstrap files + initial commit の一括保証。setup 時 + 物理 session 開始前に実行）
- Doctor workspace チェック（必須ファイル・git 初期化の検証、--fix による自動修正）
- Workspace 情報のシステムインストラクション記載（CHANNEL_OPERATOR_PROMPT に workspace 構造・git 管理方針を追加。SOUL.md 等との レイヤー区別を明確化）

- SystemStatus 別ページ表示（`/status` パス。モーダルからリンク遷移）
- 物理 Session イベント stream 表示（`/sessions/{{sessionId}}/events` パス。disk 保存、ストレージ上限、フラット/ネスト切替。位置ベースのスクロール追従、差分更新による内部スクロール保持）
- オリジナルシステムプロンプトの取得・表示（`registerTransformCallbacks` によるキャプチャ、API `/api/system-prompts/original`、dashboard 表示）
- Effective system prompt の表示（API `/api/system-prompts/effective/{{sessionId}}`、SystemStatus で表示、original system prompt との区別）
- Session イベント store（disk ベース JSON Lines、セッション別ファイル、ストレージ上限）

- 永続化戦略のハイブリッド移行（Store: JSON → SQLite、SessionEventStore: JSONL → SQLite。better-sqlite3 + WAL モード。legacy JSON からの自動マイグレーション）

- 停止した物理セッションの Dashboard 継続表示（physicalSessionHistory への退避、展開表示、イベントリンク維持、`/sessions` 一覧ページ）

- Dashboard フロントエンドの vite + React 移行（server-side HTML テンプレート + inline JS → Vite + React SPA。型安全な JSX、React Testing Library によるコンポーネントテスト、SSE/fetch の hooks による状態管理。旧レンダリングはフォールバックとして残存）

- セッションビューア UI 改善（`/sessions` を抽象セッション主体の階層表示に変更、`?focus` パラメタによるフォーカス、イベントページからの「Back to Sessions」ナビゲーション、parentId ネスト表示の廃止、`/status` の sessions リンク表記修正）

- OpenTelemetry 導入（@opentelemetry/api + sdk-logs + sdk-metrics。StructuredLogger への OTel ログブリッジ統合、config.json `otel.endpoints` 設定、config migration v2→v3、copilotclaw.sessions.active/suspended ゲージ + copilotclaw.tokens.input/output カウンター、console.error の構造化ログ移行）

- Gateway-Agent 間通信の IPC 統一（agent → gateway の全 HTTP 通信を IPC stream に移行。`COPILOTCLAW_GATEWAY_URL` / `gatewayBaseUrl` / agent 内 HTTP fetch を除去。IPC stream プロトコルによる双方向メッセージング。MIN_AGENT_VERSION を 0.36.0 に引き上げ）

**v0.36.0 で修正・確認:**
- `/sessions` へのリンク表記を全ページで `All physical sessions →` から `All sessions →` に修正（StatusPage、DashboardPage、dashboard モーダル、フォールバック HTML）
- `/sessions` の抽象セッション主体の階層表示を再調査し、バックエンド・フロントエンド共に正しく動作することを確認（以前の `stopAll()` バグ修正により解決済み）
- IPC server の sessionManager null 参照バグを修正（`listenIpc` 呼び出し時に `null` でクローズオーバされ、後から作成した sessionManager が IPC に反映されなかった。ミュータブル ref + `setSessionManager()` で解決）
- Sessions セクションを空でも常に表示するように修正（セッション 0 件時に枠ごと消える問題を修正。"No active sessions." の空状態表示を追加）
- IPC stream の新規 agent spawn 後の再接続（`reconnectStream()` で古い agent への接続を切断し、新 agent に再接続）
- 物理セッション履歴の resume 時重複を修正（同じ SDK session ID の場合は更新、異なる場合のみ追加）
- 累積トークンの resume 時二重加算を修正（同じ物理セッションの場合は差分のみ加算）
- max-age replace 時に `copilotSessionId` をクリアし、次回 revival で新しい物理セッションを作成（1:N の正しい実現）
- agent の全ログを構造化 JSON に統一（`console.error` の非構造化出力を排除、`log`/`logError` コンストラクタオプション導入）
- MIN_AGENT_VERSION を 0.36.0 に引き上げ

- チャンネルのアーカイブ（channels テーブルに `archivedAt` 追加、`PATCH /api/channels/:id` による archive/unarchive、`GET /api/channels?includeArchived=true`、dashboard での表示切替トグル）

- デバッグ用ログレベル（config `debug.logLevel` で debug ログ有効化、hooks 呼び出し詳細の debug ログ出力、config migration v3→v4）

- Gateway-Agent 責務の再配置: プロンプト・custom agent 構成を gateway 側 `agent-config.ts` に移動し IPC 経由で送信（v0.40.0）

- Cron 機能（config 定義の定期タスクをチャンネルメッセージとして送信、cron sender、重複排除、セッション起動対応）（v0.41.0）

- chat operator プロンプト修正（cron タスクの worker 委譲、subagent は常に background mode + worker のみ）（v0.41.0）

- 物理セッション currentState の正確な追跡（`onStatusChange("waiting")` で `currentState` を `tool:copilotclaw_wait` に設定。SDK `tool.execution_complete` による idle リセットを上書き）（v0.44.0）
- postToolUse ログにセッション ID を含める（`postToolUse: [sessionId] tool=toolName` 形式。複数セッション並走時の診断を可能にする）（v0.44.0）

- Dashboard のモバイル対応（タブ横スクロール、レスポンシブレイアウト、モーダル幅調整）（v0.45.0）
- メッセージのリアルタイム更新の信頼性向上（SSE auto-reconnect、visibilitychange でのメッセージ再取得）（v0.45.0）
- チャット履歴の無限スクロール化（初回 50 件、cursor ベースページネーション、スクロール位置復元）（v0.45.0）

- チャット画面のスクロール追従の動的切り替え（`programmaticScrollRef` ガードで動的判定を正常化）（v0.46.0）
- イベントビューの自動更新と無限スクロール化（Refresh ボタン削除、cursor ベースページネーション、初回最新 N 件 + 上下無限スクロール）（v0.46.0）

- トークン消費指数と消費量の閲覧 UI（/status の Token Consumption セクション。直近 5h・期間別・モデル別の表示。computeIndex = SUM{MAX(multiplier,0.1)*totalTokens}）（v0.48.0）
- suspend された物理セッションの effective system prompt 確認（physicalSessionHistory 内の各エントリに View → リンク追加）（v0.48.0）

- Gateway-Agent 責務の再配置（v0.49.0 で部分実現、v0.50.0 で追加移行）: SessionOrchestrator を gateway に新設し、チャンネルバインディング、suspended 永続化、復活、状態管理、バックオフ、stale 検出、max age、pending ポーリング、通知を gateway 側に移行。agent からは channelBindings, backoff, stale/maxAge, persistence, channel notification を削除。IPC に start_physical_session/stop_physical_session/physical_session_started/physical_session_ended/running_sessions を追加。SessionOrchestrator は SQLite 永続化。agent-bindings.json からの一括マイグレーション対応。v0.50.0: sessionId 不整合修正、gateway 再起動時の二重セッション防止（running_sessions reconciliation）、抽象セッション状態の二重管理削除、モデル選択ポリシーの gateway 移行、keepalive タイムアウト/リマインダーポリシーの config 化、workspace bootstrap の agent 削除、物理セッション状態追跡の gateway 移行（PhysicalSessionSummary/SubagentInfo を agent から削除し、gateway が session_event からリアルタイム構築。/api/status を orchestrator データに一元化）。MIN_AGENT_VERSION を 0.50.0 に引き上げ。

- gateway 停止時の情報無損失（v0.50.0）: agent 側に send queue を導入。gateway 未接続時はメモリ + ディスク（send-queue.jsonl）にバッファリング。gateway 再接続時に flush。agent 再起動後もディスクから復元。

- Gateway-Agent 責務の再配置 — gateway-configurable 範囲の拡大（v0.50.0-v0.53.0）: config 化 5 項目、SDK イベント全件 forward、SDK フック gateway RPC 汎用機構、物理セッションライフサイクル gateway 委譲、ツール定義の動的注入と処理の gateway 委譲。MIN_AGENT_VERSION を 0.53.0 に引き上げ。

- Gateway-Agent 責務の再配置 — agent のメッセージ種別解釈を削除（v0.53.0）: combineMessages から sender 種別判定を削除。フォーマットは gateway の onToolCall ハンドラが担当。

- Gateway-Agent 責務の再配置（v0.54.0）: agent から channelId 概念を除去（IPC は sessionId のみ）、命名を物理セッション明示に変更（PhysicalSessionManager 等）、ポリシー情報（zeroPremium, debugMockCopilotUnsafeTools）を agent から除去。MIN_AGENT_VERSION を 0.54.0 に引き上げ。

- Gateway-Agent 責務の再配置（v0.54.0）: swallowed-message 検出を gateway に移行、MAX_REINJECT を gateway config 化、reminderState を gateway に移行（session_event 監視で判定）、agent コメントの abstract session 言及修正、初期化シーケンス修正（stream_connected ハンドラを config 受信前に登録）、pooled CopilotClient の start 修正

- チャンネルごとのモデル設定（channels テーブルに model カラム追加、PATCH API 拡張、物理セッション起動時にチャンネル model 優先、config.json の `channels` セクションで永続化・API 変更時の書き戻し）（v0.55.0-v0.57.0）

- Cron の `enabled` → `disabled` フラグ変更（デフォルト `false` の否定形フラグに変更、config migration v4→v5）（v0.55.0）

- アーカイブされたチャンネルの cron 無効化（スケジューラ登録時・tick 時にアーカイブ状態確認、アーカイブ済みチャンネルのジョブをスキップ）（v0.55.0）

- Cron 設定のリロード（`copilotclaw cron reload` CLI、`POST /api/cron/reload` API、設定差分なしジョブのタイマー保持。`copilotclaw cron list` CLI、`GET /api/cron` API）（v0.55.0）

- チャンネル設定モーダル（chat 画面のタブ channel ID クリックで開く。モデル表示・設定、物理セッションアーカイブ、cron ジョブの変更/追加/削除 + 自動リロード）（v0.55.0-v0.56.0）

- 物理セッション停止 API（`POST /api/sessions/{{sessionId}}/stop`、チャンネル設定モーダルからの物理セッションアーカイブに使用）（v0.55.0）

- session.idle での subagent 停止と親 agent idle の区別 — v0.65.0 で agent 側セッションループを修正。backgroundTasks 付き session.idle ではセッションループを終了せず、真の idle またはエラーを待つ（30分タイムアウト付き安全弁）

- physical session の常時保持（idle 停止時に physicalSession をクリアせず currentState: "stopped" で保持。suspendSession は明示的 archive のみ）（v0.58.0）

- turn run 概念の導入（idle で turn run 終了 → idleSession()。turn run 強制停止 API `POST /api/sessions/{{sessionId}}/end-turn-run`。次の turn run 開始時にモデル切り替え）（v0.58.0）

- セッション status の細分化（new/starting/waiting/notified/processing/idle/suspended の 7 状態。tool.execution_start で processing/waiting を自動設定。message 到着時に waiting → notified 遷移）（v0.58.0）

- end turn run ボタンの警戒色（archive physical session と同じ赤色。プレミアムリクエストを消費した run を捨てる操作のため）（v0.58.0）

- chat 入力の UX 改善（Alt/Cmd+Enter のみ送信、textarea 高さ自動調整 40vh 上限、下書き保存 debounce 1s + チャンネル切替復元）（v0.59.0）
- 下書き保存のゾンビ復活バグ修正（チャンネル切替時・unmount 時に pending の draft save を flush するように修正。テキストを空にして 1 秒以内にチャンネルを切り替えた場合、空の状態が保存されず古い下書きが復活する問題を修正）（v0.61.1）

- end turn run の物理セッション非 archive（SDK セッション停止 + copilotSessionId 保持 + resumeSession で再開。idleSession で physicalSession を visible に維持）（v0.60.0）

- System Status UI 改善（モーダルと /status の内容統一: Gateway→Agent→Config→Quota→Models→Original Prompts→Token Consumption→Sessions。セッション/Original Prompts のアコーディオン折り畳み。Open in new tab リンク修正）（v0.60.0）

- premium request クォータの正確な取得（GitHub API 使用量取得 + SDK fallback。モデル一覧も GitHub Models Catalog から取得し SDK 由来と区別して表示。gateway 側の github-api.ts で実装）（v0.61.0）

- Messages API の sender フィールド必須化（`POST /api/channels/:channelId/messages` で `sender` 省略時に 400 エラーを返す）（v0.62.1）

- トークン消費データへの乗数保存（`assistant.usage` イベント保存時に `modelMultiplierCache` から乗数を付加）（v0.63.0）
- トークン消費時系列 API（`GET /api/token-usage/timeseries`、期間・ポイント数・移動平均窓を指定、モデル別消費量・指数・移動平均を返却）（v0.63.0）
- トークン消費グラフ UI（`/token-usage` ページ、recharts による指数折れ線グラフ + モデル別積み上げ面グラフ、期間・MA 窓の切り替え）（v0.63.0）

- メッセージ消費とセッションステータス管理の設計整理 — SessionController 導入（v0.64.0）。POST handler のセッション即時起動、pending flush の安全化、lifecycle "wait" ゾンビ修正、notifyAgent 死セッション対応、swallowed-message 誤発火修正、double drain バイパス修正、cron notify タイミング、SSE broadcast 追加、gateway 再起動 stale 状態

- SDK CLI 子プロセスのゾンビ化修正（全 stop パスで client.stop()/forceStop() を呼ぶ。pooled client も含む）（v0.66.0）

**未実現:**
- キャッシュトークンの記録と消費量計算 — cacheReadTokens / cacheWriteTokens の保存、consumedTokens ベースのグラフ・指数計算
- トークン消費グラフ UI の改善 — 1分自動更新（toggle）、query パラメータ反映、MA 5h 追加、Token Usage by Model を線グラフ化（実値=実線、MA=破線、同モデル同色）
- メッセージ消費バグ修正の残件 — startPhysicalSession の ack タイムアウト監視、IPC reconnect 時の send queue flush 順序
- gateway 停止時の情報無損失 — flush 時の配達保証（send queue の flush 後に ACK を待たずディスクをクリアしている。flush 中に gateway がクラッシュするとメッセージが消失する。ACK プロトコルの導入が必要）

**今後の課題:**
- Profile 認証の OAuth 対応（ユーザーが OAuth App を登録し client_id を config に設定する方式）
- Agent process 停止時の全セッション保存（disconnect → 次回起動時に resumeSession）
- コーディング支援ツール群（ファイル操作・シェル実行・検索・Git）の実装
- Observability スタックの独立リポジトリへの分離（`.example` パターンの導入を含む）
