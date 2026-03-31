# 提案: 機能要件・非機能要件・技術スタック

## 機能要件

### Feat: コーディング支援ツール群

エージェントが利用できるツールとして、少なくとも以下を備える:

- ファイルの読み書き
- シェルコマンドの実行
- コードベースの検索（ファイル名・内容）
- Git 操作

### Feat: コンテキスト管理

- 作業ディレクトリのコードベースをコンテキストとしてエージェントに提供する
- 会話履歴を適切に管理し、長い対話でもコンテキストを維持する

### Feat: テレメトリ収集と可視化

- GitHub Copilot の OTEL テレメトリを収集し、Grafana ダッシュボードで可視化する（実装済み）
- トークン使用量をモデル別に追跡可能とする（実装済み）

## 非機能要件

### NFR: 自動テスト

すべての実装に自動テストを必須とする。テストは以下の三層で構成する。

| レイヤー | スコープ | 特性 |
| :--- | :--- | :--- |
| Unit | 単一モジュールの純粋ロジック | 外部依存なし、高速 |
| Integration | DB 等の外部リソースとの結合 | 現時点では該当なし（インメモリのため） |
| E2E | サーバー起動 + API / UI の検証 | 専用ポートで分離、Copilot は mock |

### テスト技術スタック

| ツール | 用途 |
| :--- | :--- |
| Vitest | テストランナー（unit / integration / E2E API） |
| Playwright | フロントエンド E2E |

### テストカバレッジのギャップ

Dashboard のクライアントサイド JS 動作（SSE イベントハンドラ、processing indicator の表示/非表示、ログパネルの動的更新等）は、現在のサーバーサイド HTML レンダリングのユニットテストではカバーされていない。Playwright 導入時に優先的にカバーすべきテストケース:

- Processing indicator: agent メッセージ到着時に即時非表示になること
- SSE 接続: メッセージ到着時にチャットが更新されること
- ステータスバー: agent 互換性ラベルがリアルタイム更新されること
- ログパネル: 開閉と自動更新が動作すること

### テスト分離の方針

- E2E テストは専用ポート（ランダムポート `port: 0`）でサーバーを起動する
- GitHub Copilot SDK への依存はすべて mock する（認証要件および BAN リスク回避）
- テストダブル（mock / stub）はテスト実装の一部としてその場で完結させる。テストダブルの不在を理由にテストを skip にしてはならない
- `skip` が許されるのは、テスト対象の機能自体がまだ存在しない場合のみ


### NFR: ログのファイル出力と構造化ログ

gateway および agent のログをファイルに永続化し、プロセス停止時の原因調査を可能にする。

- gateway と agent の両プロセスのログをファイルに出力する（実装済み）
  - gateway: `{{stateDir}}/data/gateway.log` に構造化ログを出力（LogBuffer 経由）
  - agent: `{{stateDir}}/data/agent.log` に構造化ログを出力（StructuredLogger 経由）。加えて gateway が agent プロセス起動時に stderr をログファイルにリダイレクト（クラッシュ時の安全ネット）
- ログは構造化ログ（structured logging）を採用する（実装済み）
  - JSON Lines 形式: `{"ts":"...","level":"info","component":"gateway","msg":"...","data":{...}}`
  - 将来の OpenTelemetry ログブリッジへの移行を容易にする
- 将来的に OpenTelemetry を導入し、既存の Observability スタック（Loki / Tempo / Prometheus → Grafana）と統合する → 下記「OpenTelemetry の本格導入」セクション参照

### NFR: OpenTelemetry の本格導入

gateway および agent の全ログ・メトリクスを OpenTelemetry シグナルとして出力し、任意の Collector にエクスポート可能にする。

**ログ:**
- 現在の `StructuredLogger`（agent）/ `LogBuffer`（gateway）による JSON Lines 出力を維持しつつ、OTel ログシグナルとしても出力する
- `console.error` 等の非構造化ログが残っている箇所を特定し、全て構造化ログ（`StructuredLogger` 等）経由に移行する
- OTel ログには severity level、component 名、タイムスタンプ、構造化データを含める

**メトリクス:**
- トークン消費量（input/output、累積）
- セッション数（active/suspended）
- リクエスト処理時間
- セッション失敗回数/バックオフ発生回数

**設定（`config.json` の拡張）:**
- `otel.endpoints` フィールド（文字列配列）を追加し、OTLP エンドポイント URL リストを指定可能にする
- 各エンドポイントに対して gRPC or HTTP/protobuf でエクスポートする
- エンドポイントが空の場合は OTel エクスポートを無効化する（既存出力のみ）
- 設定ファイルのスキーマバージョンをインクリメントし、マイグレーションを追加する

**既存出力との共存:**
- ファイル出力（gateway.log / agent.log）は維持する
- stderr リダイレクト（agent プロセス）は維持する
- OTel は追加の出力チャネルであり、既存出力を置き換えない

**依存関係:**
- `@opentelemetry/sdk-node` または `@opentelemetry/api` + 個別パッケージ
- `@opentelemetry/exporter-logs-otlp-grpc` / `@opentelemetry/exporter-logs-otlp-http`
- `@opentelemetry/exporter-metrics-otlp-grpc` / `@opentelemetry/exporter-metrics-otlp-http`

### NFR: 設定ファイルのスキーマバージョンとマイグレーション

設定ファイル（`config.json`）にスキーマバージョンを導入し、段階的マイグレーションにより後方互換性を維持する。

**スキーマバージョン:**

`config.json` にトップレベルの `configVersion` フィールド（整数）を追加する。省略時は v0（現在の暗黙のスキーマ）として扱う。

```json
{
  "configVersion": 1,
  "port": 19741,
  "auth": { "type": "gh-auth", "user": "my-account" }
}
```

**段階的マイグレーション:**

マイグレーション関数を `configVersion` ごとに定義し、古いバージョンから最新バージョンまで順番に適用する。

```
loadConfig()
  → configVersion を読み取り（未定義なら 0）
  → configVersion < LATEST_CONFIG_VERSION なら:
    → migrate_v0_to_v1(config) → migrate_v1_to_v2(config) → ... → 最新
    → マイグレーション後のファイルを書き戻し（configVersion を更新）
  → マイグレーション済み config を返す
```

各マイグレーション関数は入力 config を受け取り、変換後の config を返す純粋関数として実装する。副作用（ファイル書き込み等）はマイグレーションチェーンの完了後に一度だけ行う。

**マイグレーション関数の例:**

```typescript
// v0 → v1: configVersion フィールドの追加（既存フィールドの変換なし）
function migrate_v0_to_v1(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, configVersion: 1 };
}
```

**スキーマバージョンとアプリバージョンの関係:**

- スキーマバージョンは整数で独立管理する（アプリバージョンとは一致しない）
- スキーマバージョンはスキーマの構造が変わったときだけインクリメントする（新しいオプショナルフィールドの追加ではインクリメント不要）
- 必須フィールドの追加、フィールドの改名、フィールドの型変更、フィールドの削除など、既存の config.json を壊す変更が入るときにインクリメントする

**影響範囲:**

| ファイル | 変更内容 |
|:---|:---|
| `packages/gateway/src/config.ts` | `configVersion` フィールド追加、マイグレーション関数群、`loadConfig` でのマイグレーション適用 |
| `packages/gateway/src/doctor.ts` | configVersion チェック追加 |

### NFR: 永続化戦略のハイブリッド移行

成長するデータを JSON/JSONL から SQLite（better-sqlite3）に移行し、静的データは JSON のまま維持するハイブリッド方式。

**現状の問題:**
- store.json: メッセージ追加のたびに全データを JSON シリアライズして全書き換え（書き込み増幅）
- session events (JSONL): クエリ時に全ファイル読み込み → パース（O(N) フルスキャン）
- structured logs: 上限なし（disk 圧迫リスク）

**方針:**

| データ | 現行 | 移行先 | 理由 |
|:---|:---|:---|:---|
| config.json | JSON snapshot | JSON のまま | 小さい静的データ。変更頻度低い |
| agent-bindings.json | JSON snapshot | JSON のまま | 小さい。数十セッション程度 |
| system prompt snapshots | JSON files | JSON のまま | 小さい。モデル数分 |
| チャンネルメッセージ + pending queue | JSON snapshot (store.json) | **SQLite** | 毎メッセージ全書き換え → INSERT で解決 |
| セッションイベント | JSON Lines (per session) | **SQLite** | 全ファイル読み込み → インデックスクエリで解決 |
| 構造化ログ | JSON Lines | **対象外（OTel 移行予定）** | OpenTelemetry ブリッジへの移行が既に要件として存在 |

**SQLite 選定理由:**
- OpenClaw が `better-sqlite3` で memory store を実装済み（実績あり）
- ローカルツールに最適（外部プロセス不要、単一ファイル）
- インデックスによる O(log N) クエリ、トランザクションによる原子的書き込み

**フェーズ案:**
- **Phase A**: messages + pending queue → SQLite（書き込み増幅解消、効果最大）
- **Phase B**: session events → SQLite（イベントクエリ高速化、type/timestamp フィルタ）

### NFR: SQLite スキーマの段階的マイグレーション

SQLite のスキーマ変更を、バージョン番号で管理する段階的マイグレーション方式にする。config.json の `configVersion` と同じパターン。

**現状の問題:**
- `initSchema()` に CREATE TABLE と migration を混在させている
- migration の適用済み判定がアドホック（CHECK 文字列の有無、カラムの存在チェック等）
- migration が増えるとどれが新規スキーマでどれが既存 DB の修正か判別困難

**方針:**
- `store_schema_version` テーブルを導入し、現在のスキーマバージョンを記録する
- `initSchema()` は最初のテーブル作成（version 0）のみ担当
- migration は `STORE_MIGRATIONS` レジストリに登録し、version N → N+1 を順次適用する
- config.ts の `migrateConfig` と同じ構造
- down migration は不要（up のみ）

### NFR: セキュリティ
<!-- TODO: 未実装 — ツール実行時のパーミッション制御 -->

- ツール実行時のパーミッション制御（ユーザーの承認なしに破壊的操作を行わない）
- 機密情報（API キー、認証情報等）の漏洩防止

### NFR: ポータビリティ

- macOS / Linux 環境で動作すること
- Docker Compose による Observability スタックのセットアップが容易であること（実装済み）

## 技術スタック（提案）

| レイヤー | 技術 | 選定理由 |
| :--- | :--- | :--- |
| Agent ランタイム | GitHub Copilot SDK | 要求に基づく必須選定 |
| Gateway サーバー | Node.js 標準 `node:http` | 外部依存なし・軽量 |
| テストランナー | Vitest | TypeScript ネイティブ・ESM 対応・高速 |
| Dashboard フロントエンド | vite + React | 型安全な JSX・コンポーネントテスト・hooks による状態管理 <!-- TODO: 未実装 — 現在は server-side HTML テンプレート + inline JS --> |
| フロントエンド E2E | Playwright | ブラウザ自動化の標準 |
| テレメトリ収集 | OpenTelemetry Collector | 構築済み・Copilot OTEL と親和性が高い |
| メトリクス | Prometheus | 構築済み |
| ログ | Loki | 構築済み |
| トレース | Tempo | 構築済み |
| 可視化 | Grafana | 構築済み |

### NFR: chat 入力の UX 改善（v0.59.0 で実現済み）

chat UI の入力欄の操作性を改善する。

**送信キーの変更:**
- Enter キー単体での送信を廃止する
- 送信は Alt+Enter（Windows/Linux）または Cmd+Enter（macOS）のみ

**入力欄の高さ自動調整:**
- textarea の高さを入力内容の行数に応じて自動拡張する
- 上限は画面高さに対する割合（例: 40vh）で制限する

**下書き保存:**
- 入力中のテキストを下書きとして保存する。変更がある度に保存する
- キー連打で画面が重くなったり通信が重くなったりしないようにする

**下書き保存の設計（Mechanism）:**
- チャンネルごとに gateway に保存する
- API: `PUT /api/channels/{{channelId}}/draft` で保存、`GET /api/channels/{{channelId}}/draft` で取得
- debounce: 変更イベントを一定期間（例: 1 秒）集約し、最終結果のみ送信する
- チャンネル切り替え時に下書きを復元する

### NFR: System Status UI 改善（v0.60.0 で実現済み）

System Status モーダルと `/status` ページの表示を改善し、内容を統一する。

**Original System Prompts のアコーディオン:**
- Effective Prompt と同様に view/hide で折り畳む方式にする
- デフォルトで折り畳まれている
- 内部的にスクロールできる仕様はそのまま

**System Status モーダルの Open in new tab:**
- 「Open in new tab →」リンクを `target="_blank"` にして通常クリックで新しいタブに開く

**セッションのアコーディオン:**
- abstract session は id のみ表示し、詳細は view/hide で折り畳む
- デフォルトで折り畳まれている

**セクション順序:**
- モーダルと `/status` ページで同じ順序にする
- Sessions を最後に配置する

**内容統一:**
- モーダルと `/status` ページで同様の内容を表示する
- 現状の差分:
  - モーダルにない: Config, Original System Prompts, Token Consumption
  - `/status` にない: 独立した Models セクション
- 両方を足し合わせた内容を両方に表示する

