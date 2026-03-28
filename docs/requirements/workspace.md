# 要求定義: Workspace Bootstrap Files・Memory・Git 管理

### Req: State Directory と Workspace の概念的分離

state directory と workspace を概念的・物理的に明確に区別する。

- state directory: `~/.copilotclaw` or `~/.copilotclaw-{{profile}}`。config, data, agent-bindings 等のシステム管理データを格納する
- workspace: `{{stateDir}}/workspace/`。ユーザーがカスタマイズするファイル（SOUL.md 等）、memory、agent の作業ディレクトリを格納する
- Copilot SDK の `SessionConfig.workingDirectory` は workspace を指す
- Copilot SDK の制約: `workingDirectory` は session ごとに固定され、subagent ごとに変えることはできない。そのため、将来的に同一 profile 内で複数の役割の agent を分ける機能を実現する際には OpenClaw とは異なる workspace 設計が必要になる

### Req: Workspace Bootstrap Files（SOUL.md, AGENTS.md, MEMORY.md 等）

OpenClaw の workspace bootstrap files に相当するファイルを workspace に配置し、agent がセッション開始時に自発的に読み取る仕組みを提供する。OpenClaw はシステムプロンプトにファイルを直接埋め込む方式（Project Context 注入）だが、CopilotClaw では agent がビルトインツールで自発的に読む方式とする（Copilot SDK の制約による）。

- SOUL.md（人格・トーン・価値観）、AGENTS.md（操作マニュアル）、USER.md（ユーザー情報）等をデフォルトテンプレートから生成する
- これらは **ユーザーが自由にカスタマイズするファイル** であり、copilotclaw のシステムプロンプトではない
- SOUL.md 等の workspace ファイルを読み込むと大量のコンテキストが注入され、`copilotclaw_wait` の義務が埋もれるリスクがある。多層防御で対策する:
  - **システムプロンプト**（custom agent の prompt フィールド）に冒頭と末尾で記載（最も信頼性が高い層、ユーザーが変更不可）
  - **workspace ファイル読み込み後のリマインド** — onPostToolUse hook 等でシステム的に `copilotclaw_wait` の義務をリマインドする（既に実装済み: `<system>` タグ方式）
- agent はビルトインツール（ファイル読み書き）でこれらを読み書きする
- 読み取り順序: SOUL.md（人格、最優先）→ USER.md → memory → MEMORY.md。OpenClaw と同様に SOUL.md を AGENTS.md より優先する
- system prompt に読み取り順序と「SOUL.md の人格を体現せよ」という指示を含める

### Req: Memory（永続記憶）

agent が学んだことや覚えておくべき情報を、session をまたいで永続的に記録・参照できる仕組みを提供する。

- workspace 内に memory ファイル（Markdown）として保存する
- agent がビルトインツール（ファイル読み書き）で memory を読み書きする
- AGENTS.md に memory の使い方を記載し、agent が自発的に memory を活用するよう導く

### Req: Workspace Git 管理

agent の workspace での作業内容を Git で追跡できるようにする。

- workspace ディレクトリを Git リポジトリとして初期化する（setup 時）
- copilotclaw のコード側で自動コミットは行わない
- AGENTS.md テンプレートで agent の自主的なコミットを誘導する（OpenClaw の delegation パターン: AGENTS.md が "Commit and push your own changes" を proactive work として記載）
- agent はビルトインツール（shell 実行）で Git 操作が可能

### Req: Workspace Ensure

workspace が正常な状態であることを保証する ensure 処理を提供する。

- ensure 処理の内容:
  - workspace ディレクトリの作成
  - git init（git が利用可能な場合）
  - 初期ファイルの生成（`SOUL.md`, `TOOLS.md`, `USER.md`, `memory/.gitkeep` 等が存在しなければ作成）
  - 初期ファイルの git add + commit（workspace の初期状態を git で記録する）
- ensure の実行タイミング:
  - `copilotclaw setup` 実行時
  - 物理 session の開始前
- `copilotclaw doctor` で workspace に不備があればエラーを出す
- `copilotclaw doctor --fix` で workspace の ensure を実行して修正する

### Req: Workspace 情報のシステムインストラクション記載

workspace の構造・使い方・git 管理の方針を CopilotClaw 共通のシステムインストラクション（`CHANNEL_OPERATOR_PROMPT`）に含める。

- workspace の構造やその使い方、git 管理することなどはシステムインストラクションに記載する
- システムインストラクションと SOUL.md 等はレイヤーが異なる:
  - **システムインストラクション**（`CHANNEL_OPERATOR_PROMPT`）: ユーザーが変更しない。CopilotClaw システムが規定する
  - **SOUL.md 等**: ユーザーが変更してもよいし、agent が自分で変更してもよい（ユーザーの好みにカスタマイズする）
