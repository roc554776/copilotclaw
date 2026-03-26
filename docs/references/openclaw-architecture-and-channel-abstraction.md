# OpenClaw Architecture: Module Structure and Channel Abstraction

Source: https://github.com/openclaw/openclaw
調査目的: copilotclaw のアーキテクチャ整理の参考として、OpenClaw のモジュール分割と channel 抽象化を理解する

## Module Structure

### Top-Level Modules (`src/`)

| モジュール | 責務 |
|:---|:---|
| `gateway/` | メインサーバー。channel ライフサイクル管理、メッセージ処理、ルーティング、認証、レート制限 |
| `channels/` | channel プラグインシステムのコア。型定義、レジストリ、プラグイン発見・登録 |
| `routing/` | agent ルーティングとセッションバインディング。binding ルールに基づくメッセージの振り分け |
| `agents/` | agent 管理と定義 |
| `acp/` | Agent control plane |
| `plugins/` | プラグインレジストリとランタイム管理 |
| `plugin-sdk/` | 外部プラグイン向けの公開 SDK |
| `config/` | 設定管理 |
| `infra/` | インフラユーティリティ（outbound 配信、TLS、デバイス認証等） |
| `extensions/` | ビルトイン・外部拡張のローディング |
| `commands/` | CLI コマンド実装 |
| `cli/` | CLI インターフェース |
| `memory/` | メモリ/ナレッジ管理 |
| `media/`, `media-understanding/` | メディア処理 |
| `security/`, `secrets/` | セキュリティ管理 |
| `logging/`, `terminal/`, `tui/` | ユーザー向けインターフェース |

### ワークスペース構成

- ルートパッケージ: メインの CLI / gateway
- `extensions/*`: 85+ の channel プラグイン（ビルトイン + 外部拡張）
- `packages/*`: 追加パッケージ
- `ui/`: UI コンポーネント

## Channel 抽象化

### ChannelPlugin インターフェース

すべての channel（ビルトイン、外部拡張とも）は `ChannelPlugin` 型を実装する。責務ごとに optional な adapter を持つ adapter パターン。

```typescript
type ChannelPlugin<ResolvedAccount = any> = {
  id: ChannelId;
  meta: ChannelMeta;                              // UI メタデータ（ラベル、ドキュメントパス等）
  capabilities: ChannelCapabilities;              // 機能フラグ

  // 設定・セットアップ
  config: ChannelConfigAdapter<ResolvedAccount>;   // 設定の検証・変換（必須）
  setup?: ChannelSetupAdapter;                     // セットアップウィザード
  pairing?: ChannelPairingAdapter;                 // ユーザーペアリング/許可リスト
  security?: ChannelSecurityAdapter<ResolvedAccount>; // DM ポリシー、セキュリティ

  // Gateway ライフサイクル
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;  // アカウントの start/stop、ログイン/ログアウト
  status?: ChannelStatusAdapter<ResolvedAccount>;    // ヘルスプローブ、アカウントスナップショット

  // メッセージング
  outbound?: ChannelOutboundAdapter;               // テキスト/メディア/ポール送信
  messaging?: ChannelMessagingAdapter;             // インバウンドメッセージ処理
  mentions?: ChannelMentionAdapter;                // メンション解析
  directory?: ChannelDirectoryAdapter;             // ユーザー/グループ検索
  threading?: ChannelThreadingAdapter;             // スレッド/会話ハンドリング

  // 高度な機能
  actions?: ChannelMessageActionAdapter;           // メッセージアクション（タイムアウト、キック等）
  heartbeat?: ChannelHeartbeatAdapter;             // 定期ヘルスチェック
  groups?: ChannelGroupAdapter;                    // グループ固有ポリシー
  bindings?: ChannelConfiguredBindingProvider;     // agent ルーティングバインディング
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[]; // agent 固有ツール
};
```

### 主要 adapter の役割

| Adapter | 責務 |
|:---|:---|
| `ChannelConfigAdapter` | raw config → resolved account オブジェクトへの変換、設定検証 |
| `ChannelGatewayAdapter` | アカウントライフサイクル管理（start, stop, login, logout） |
| `ChannelOutboundAdapter` | メッセージ送信（direct/gateway/hybrid モード、チャンキング制限） |
| `ChannelMessagingAdapter` | 外部チャネルからのインバウンドメッセージを OpenClaw 形式に正規化 |
| `ChannelStatusAdapter` | ヘルスプローブ、権限チェック、診断情報の提供 |
| `ChannelSecurityAdapter` | DM ポリシーの強制（owner-only, allow-from 等） |

### Outbound 配信モード

```typescript
deliveryMode: "direct" | "gateway" | "hybrid"
```

- `direct`: channel が自身で直接送信（例: Discord bot API）
- `gateway`: gateway サーバー経由でルーティング
- `hybrid`: 混合アプローチ

チャネルごとのテキスト制限: Discord 2000文字、Telegram 4096文字 等

## Channel のやりとりを担うモジュール

### メッセージフロー（全体像）

```
外部 channel (例: Discord)
  → ChannelMessagingAdapter.inbound() で正規化
  → routing/resolve-route.ts で agent ルートを解決
    → binding ルールに基づきマッチ（peer → guild+roles → team → account → channel）
  → gateway が agent AI パイプラインに渡す
  → agent が処理、レスポンス生成
  → ChannelOutboundAdapter.sendText/sendMedia() で外部 channel に返信
```

### 責務の所在

- **gateway** (`src/gateway/`): channel ライフサイクルの中央管理者
  - `server-channels.ts` が全 channel アカウントの start/stop を統制
  - `channel-health-monitor.ts` が自動ヘルスチェック（指数バックオフ 5秒〜5分で再起動）
  - メッセージ処理、セッション管理、認証、レート制限

- **routing** (`src/routing/`): メッセージの振り分け
  - `resolve-route.ts` が binding ルールに基づき agent を決定
  - セッションキー生成（channel + agent + account + peer でスコープ）
  - DM スコープモード: "main" / "per-peer" / "per-account-channel-peer" / "per-channel-peer"

- **channel plugin** (`extensions/*/`): 外部サービスとの実際の通信
  - 各 channel プラグインが adapter を実装
  - インバウンドメッセージの受信と正規化
  - アウトバウンドメッセージの送信とフォーマッティング

重要: **gateway が全 channel を統制し、channel plugin は adapter を通じて具体的な通信を行う**。agent は channel の存在を直接知らず、gateway 経由で抽象化されたメッセージを受け取る。

## Channel プラグインの発見・登録

### レジストリシステム

```
ビルトイン channel（13チャネル）
  → src/channels/plugins/bundled.ts で static import
  → extensions/* ディレクトリから読み込み

外部プラグイン
  → プラグインレジストリ (src/plugins/runtime.js) でランタイム登録
  → openclaw.plugin.json マニフェストで宣言

共通
  → getChannelPlugin(id) で ID ベースの取得
  → listChannelPlugins() でソート済み一覧
  → 重複排除、キャッシュ、遅延ロード対応
```

### ビルトインチャネル（13）

Discord, Telegram, Slack, Signal, iMessage, LINE, IRC, Feishu, Mattermost, Nextcloud Talk, Synology Chat, BlueBubbles, Zalo

### アカウントスコーピング

- 全 channel アクションは `accountId` でスコープ
- 単一 channel が複数アカウントを持てる（例: Discord で複数 bot）
- セッションキーにアカウント含み、会話を分離

## 設計パターンの要約

| パターン | 説明 |
|:---|:---|
| Adapter パターン | channel の各責務を optional adapter で分離。未実装の adapter は gateway がスキップ |
| Configuration-Driven | channel は config から設定を読み込み、adapter が検証・変換 |
| Lazy Loading | channel プラグインはオンデマンドロード。重いランタイム機能は遅延 import |
| Account Scoping | 全アクションが accountId でスコープ。マルチアカウント対応 |
| Binding-Driven Routing | binding ルールで agent へのルーティングを宣言的に定義 |
| Health Monitoring | 自動ヘルスチェック + 指数バックオフによる再起動ポリシー |

## copilotclaw への示唆

- OpenClaw の `ChannelPlugin` adapter パターンは copilotclaw の `ChannelProvider` と類似の設計思想
- copilotclaw は現在 gateway が channel provider を直接管理しているが、OpenClaw はさらに routing / session binding / health monitoring を分離している
- OpenClaw の binding-driven routing（peer, guild, team 等の階層的マッチング）は、copilotclaw が multi-channel に進化する際の参考になる
- OpenClaw は channel 通信の責務を gateway（ライフサイクル管理）と channel plugin（実際の通信）に明確に分離している。copilotclaw も同様の構造
