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
- 将来的に OpenTelemetry を導入し、既存の Observability スタック（Loki / Tempo / Prometheus → Grafana）と統合する <!-- TODO: 未実装 -->

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

