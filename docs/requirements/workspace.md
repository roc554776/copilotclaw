# 要求定義: Workspace Bootstrap Files・Memory・Git 管理

### Req: Workspace Bootstrap Files（SOUL.md, AGENTS.md, MEMORY.md 等）

OpenClaw の workspace bootstrap files に相当するファイルを workspace に配置し、agent がセッション開始時に自発的に読み取る仕組みを提供する。OpenClaw はシステムプロンプトにファイルを直接埋め込む方式（Project Context 注入）だが、CopilotClaw では agent がビルトインツールで自発的に読む方式とする（Copilot SDK の制約による）。

- SOUL.md（人格・トーン・価値観）、AGENTS.md（操作マニュアル）、USER.md（ユーザー情報）等をデフォルトテンプレートから生成する
- これらは **ユーザーが自由にカスタマイズするファイル** であり、copilotclaw のシステムプロンプトではない
- SOUL.md 等の workspace ファイルを読み込むと大量のコンテキストが注入され、`copilotclaw_receive_input` の義務が埋もれるリスクがある。多層防御で対策する:
  - **システムプロンプト**（custom agent の prompt フィールド）に冒頭と末尾で記載（最も信頼性が高い層、ユーザーが変更不可）
  - **workspace ファイル読み込み後のリマインド** — onPostToolUse hook 等でシステム的に `copilotclaw_receive_input` の義務をリマインドする（既に実装済み: `<system>` タグ方式）
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
