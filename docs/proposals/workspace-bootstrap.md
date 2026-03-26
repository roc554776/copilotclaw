# 提案: Workspace Bootstrap Files・Memory・Git 管理

## Workspace Bootstrap Files・Memory・Workspace Git 管理

<!-- TODO: 未実装 -->

OpenClaw の workspace 構造を参考に、CopilotClaw 固有の workspace ファイル群・記憶・Git 管理を設計する。

参考: `docs/references/openclaw-soul-memory-workspace.md`

### 設計原則: システムプロンプトとユーザーファイルの分離

**システムプロンプト**（custom agent の `prompt` フィールド）と **workspace ファイル**（SOUL.md, AGENTS.md 等）は明確に分離する:

- **システムプロンプト** = copilotclaw が制御する。`copilotclaw_receive_input` の義務等のシステム制約はここに書く。ユーザーが変更できてはならない
- **Workspace ファイル** = ユーザーが自由にカスタマイズする。agent の人格、作業指針、記憶等。agent がビルトインツールで読み書きする

`copilotclaw_receive_input` の義務は多層防御で記載する:
- **システムプロンプト**（`CHANNEL_OPERATOR_PROMPT`）に冒頭と末尾で記載 — ユーザーが変更不可の最も信頼性の高い層
- **AGENTS.md デフォルトテンプレート**にも冒頭と末尾で記載 — ユーザーが削除してもシステムプロンプト側がフォールバックとなるため安全

### Workspace Bootstrap Files

`copilotclaw setup` 時に `{{workspaceRoot}}/` に以下のデフォルトテンプレートを生成する:

| ファイル | 用途 | OpenClaw 相当 |
|---|---|---|
| `SOUL.md` | agent の人格・トーン・価値観 | SOUL.md |
| `AGENTS.md` | workspace 操作マニュアル（セッション開始手順、memory の使い方、安全ルール）。冒頭と末尾に `copilotclaw_receive_input` 義務を記載 | AGENTS.md |
| `USER.md` | ユーザー情報 | USER.md |
| `TOOLS.md` | ローカルツールのメモ | TOOLS.md |

agent はセッション開始時にこれらを自発的に読む。system prompt（`CHANNEL_OPERATOR_PROMPT`）に「AGENTS.md を最初に読め」という指示を含める。

**ロードの仕組み:**
- OpenClaw は CLI 内部でファイルをロードする → CopilotClaw では agent が session 開始後にビルトインツール（ファイル読み取り）で自発的に読む
- system prompt に「セッション開始時にまず AGENTS.md を読め」と記載するだけで実現可能

### Memory（永続記憶）

workspace 内に memory ファイルを Markdown 形式で保存する。

**配置先:** `{{workspaceRoot}}/memory/`

**構造（OpenClaw 準拠）:**
- `{{workspaceRoot}}/MEMORY.md` — 長期記憶（agent が curate する "distilled essence"）
- `{{workspaceRoot}}/memory/YYYY-MM-DD.md` — 日次ログ（raw notes）

**仕組み:**
- agent がビルトインツール（ファイル読み書き）で memory を読み書きする
- AGENTS.md に memory の使い方を記載し、agent が自発的に memory を活用するよう導く
- 追加のカスタムツールは不要（Copilot SDK のビルトインツールのみで実現）

### Workspace Git 管理

workspace ディレクトリを Git リポジトリとして管理する。

**初期化:** `copilotclaw setup` 時に `git init` を実行（git がなければスキップ）

**操作方針:**
- 自動コミットは行わない（OpenClaw と同様）
- agent はビルトインツール（shell 実行）で git 操作が可能
- AGENTS.md に Git の使い方を記載し、agent が自発的に管理するよう導く
- OpenClaw の AGENTS.md には「Proactive work: Commit and push your own changes」とあり、agent の自主的なコミットは許容される

