# 要求定義: Workspace Bootstrap Files・Memory・Git 管理

### Req: Workspace Bootstrap Files（SOUL.md, AGENTS.md, MEMORY.md 等）

<!-- TODO: 未実装 -->

OpenClaw の workspace bootstrap files に相当するファイルを workspace に配置し、agent がセッション開始時に自発的に読み取る仕組みを提供する。

- SOUL.md（人格・トーン・価値観）、AGENTS.md（操作マニュアル）、USER.md（ユーザー情報）等をデフォルトテンプレートから生成する
- これらは **ユーザーが自由にカスタマイズするファイル** であり、copilotclaw のシステムプロンプトではない
- `copilotclaw_receive_input` の義務は多層防御で記載する:
  - **システムプロンプト**（custom agent の prompt フィールド）に冒頭と末尾で記載（最も信頼性が高い層、ユーザーが変更不可）
  - **AGENTS.md デフォルトテンプレート**にも冒頭と末尾で記載（ユーザーが削除してもシステムプロンプト側がフォールバック）
- agent はビルトインツール（ファイル読み書き）でこれらを読み書きする
- system prompt に「AGENTS.md を最初に読め」という指示を含める

### Req: Memory（永続記憶）

<!-- TODO: 未実装 -->

agent が学んだことや覚えておくべき情報を、session をまたいで永続的に記録・参照できる仕組みを提供する。

- workspace 内に memory ファイル（Markdown）として保存する
- agent がビルトインツール（ファイル読み書き）で memory を読み書きする
- AGENTS.md に memory の使い方を記載し、agent が自発的に memory を活用するよう導く

### Req: Workspace Git 管理

<!-- TODO: 未実装 -->

agent の workspace での作業内容を Git で追跡できるようにする。

- workspace ディレクトリを Git リポジトリとして初期化する（setup 時）
- 自動コミットは行わない（OpenClaw と同様、明示的なコマンドまたは agent の判断で操作する）
- agent はビルトインツール（shell 実行）で Git 操作が可能
