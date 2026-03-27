# 提案: Workspace Bootstrap Files・Memory・Git 管理

## Workspace Bootstrap Files・Memory・Workspace Git 管理


OpenClaw の workspace 構造を参考に、CopilotClaw 固有の workspace ファイル群・記憶・Git 管理を設計する。

参考: `docs/references/openclaw-soul-memory-workspace.md`

### OpenClaw のシステムプロンプト構造からの学び

OpenClaw のシステムプロンプト（`src/agents/system-prompt.ts`）は以下の2層構造を持つ:

**ハードコード部分（ユーザー変更不可）:** Identity, Tooling, Tool Call Style, Safety, Skills, Memory Recall, Workspace, Messaging 等の18セクション。これらは OpenClaw が完全に制御し、ユーザーは変更できない。

**Project Context（ユーザー編集可能部分の注入）:** workspace bootstrap files（AGENTS.md, SOUL.md, USER.md 等）を `# Project Context` セクションとしてシステムプロンプト末尾に注入する。OpenClaw はファイル内容をシステムプロンプトに直接埋め込む（agent がツールで読むのではない）。SOUL.md がある場合は「embody its persona and tone, unless higher-priority instructions override it」という指示が自動追加される。

**PromptMode によるレベル制御:** `"full"`（全セクション、メイン agent）、`"minimal"`（Tooling + Workspace + Runtime のみ、subagent）、`"none"`（Identity 1行のみ）の3段階。

**CopilotClaw との違い:**
- OpenClaw は CLI 内部でファイルを読みシステムプロンプトに埋め込む → CopilotClaw は Copilot SDK の `customAgents.prompt` にハードコード部分を設定し、workspace files は agent がビルトインツールで自発的に読む
- OpenClaw の PromptMode に相当するものは、CopilotClaw では `customAgents` の `infer` フラグと agent ごとの `prompt` で実現（channel-operator = full prompt, worker = 空 prompt）
- OpenClaw の Project Context 注入は自動 → CopilotClaw ではシステムプロンプトに「AGENTS.md を読め」と書き、agent が自発的にファイルを読む方式

### 設計原則: システムプロンプトとユーザーファイルの分離

**システムプロンプト**（custom agent の `prompt` フィールド）と **workspace ファイル**（SOUL.md, AGENTS.md 等）は明確に分離する:

- **システムプロンプト** = copilotclaw が制御する。`copilotclaw_receive_input` の義務等のシステム制約はここに書く。ユーザーが変更できてはならない
- **Workspace ファイル** = ユーザーが自由にカスタマイズする。agent の人格、作業指針、記憶等。agent がビルトインツールで読み書きする

SOUL.md 等の workspace ファイルを agent が読み込むと大量のコンテキストが注入され、`copilotclaw_receive_input` の義務が埋もれるリスクがある。多層防御で対策する:
- **システムプロンプト**（`CHANNEL_OPERATOR_PROMPT`）に冒頭と末尾で記載 — ユーザーが変更不可の最も信頼性の高い層
- **workspace ファイル読み込み後のリマインド** — agent が SOUL.md / AGENTS.md 等を読み込んだ直後に、onPostToolUse hook の `<system>` タグ方式でシステム的にリマインドする（既に実装済み: context usage 10% 増加ごと + compaction 後に発火）

### State Directory と Workspace の分離

state directory と workspace を概念的・物理的に明確に区別する。

**現状の問題:** `getWorkspaceRoot()` = `getStateDir()` で、SOUL.md 等のユーザーファイルが config.json や data/ と同じディレクトリに混在している。

**目標の構造:**
```
~/.copilotclaw/                       ← state directory
├── config.json                       ← システム管理データ
├── data/
│   ├── store.json
│   ├── agent-bindings.json
│   ├── gateway.log
│   └── agent.log
└── workspace/                        ← workspace（agent の作業ディレクトリ）
    ├── SOUL.md
    ├── AGENTS.md
    ├── USER.md
    ├── TOOLS.md
    ├── MEMORY.md
    ├── memory/
    │   └── YYYY-MM-DD.md
    └── .git/
```

**変更点:**
- `getWorkspaceRoot()` を `{{stateDir}}/workspace/` に変更（現状は `getStateDir()` をそのまま返している）
- `seedWorkspaceBootstrapFiles()` と `initWorkspaceGit()` は workspace サブディレクトリに対して実行する
- `SessionConfig.workingDirectory` は workspace を指す
- 既存環境のマイグレーション: state dir 直下のブートストラップファイルを workspace/ に移動する

**Copilot SDK の制約と将来設計:**
- `SessionConfig.workingDirectory` は session ごとに固定され、subagent ごとに変えることはできない
- OpenClaw は同一 state dir 内に `workspace-{{agentName}}/` を並列配置して agent ごとの workspace を分離しているが、CopilotClaw では同じ設計は取れない（session 単位で workingDirectory が固定されるため）
- 将来的に同一 profile 内で複数の役割の agent を分ける機能を実現する際には、OpenClaw とは異なる workspace 設計が必要

### Workspace Bootstrap Files

`copilotclaw setup` 時に `{{workspaceRoot}}/` に以下のデフォルトテンプレートを生成する:

| ファイル | 用途 | OpenClaw 相当 |
|---|---|---|
| `SOUL.md` | agent の人格・トーン・価値観 | SOUL.md |
| `AGENTS.md` | workspace 操作マニュアル（セッション開始手順、memory の使い方、安全ルール） | AGENTS.md |
| `USER.md` | ユーザー情報 | USER.md |
| `TOOLS.md` | ローカルツールのメモ | TOOLS.md |

agent はセッション開始時にこれらを自発的に読む。system prompt（`CHANNEL_OPERATOR_PROMPT`）に読み取り順序を指示する。

**読み取り順序（OpenClaw 準拠）:**
- SOUL.md → USER.md → memory（今日+昨日の日次ログ）→ MEMORY.md

OpenClaw では AGENTS.md テンプレートの Session Startup セクションでこの順序を定義している。SOUL.md が最優先（「this is who you are」）。OpenClaw のシステムプロンプトでは SOUL.md の存在を検出し、「embody its persona and tone, unless higher-priority instructions override it」という特別な指示を追加する。AGENTS.md にはこのような特別扱いはない。

CopilotClaw でも SOUL.md を最優先とし、system prompt に以下を含める:
- 「セッション開始時にまず SOUL.md を読み、その人格を体現せよ」
- 「次に AGENTS.md を読み、workspace の操作手順に従え」
- SOUL.md の指示は AGENTS.md より優先されるが、copilotclaw のシステムプロンプト（`copilotclaw_receive_input` 義務等）が最優先

**ロードの仕組み:**
- OpenClaw は CLI 内部でファイルを読みシステムプロンプトに直接埋め込む → CopilotClaw では agent が session 開始後にビルトインツール（ファイル読み取り）で自発的に読む
- system prompt に読み取り順序を記載するだけで実現可能

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
- copilotclaw のコード側で自動コミットは行わない
- agent が自主的にコミットすることは、AGENTS.md テンプレートで明示的に誘導する（OpenClaw の delegation パターンに倣う）
- AGENTS.md テンプレートの proactive work セクションに「Commit and push your own changes」を記載し、agent が許可なしに git add / commit / push を行えることを示す
- agent はビルトインツール（shell 実行）で git 操作を行う

