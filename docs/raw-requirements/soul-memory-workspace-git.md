# SOUL.md・Memory・Workspace Git 管理 (raw requirement)

<!-- 2026-03-27 -->

## OpenClaw 相当の workspace 機能

- OpenClaw には SOUL.md, memory や workspace の自発的な Git 管理などがある
- CopilotClaw も同様の機能がほしい
- OpenClaw の codebase を調査済み — 参考: docs/references/openclaw-soul-memory-workspace.md
  - OpenClaw のシステムプロンプトや workspace の構造について調査した

## SOUL.md 等の workspace bootstrap files

- OpenClaw の bootstrap files（SOUL.md, AGENTS.md, USER.md, IDENTITY.md, TOOLS.md, MEMORY.md 等）に相当するファイルを workspace に配置する
- これらは **ユーザーが自由にカスタマイズするファイル** であり、copilotclaw のシステムプロンプトではない
- agent はセッション開始時にこれらを自発的に読み取る

## copilotclaw_receive_input の扱い

- channel に紐づく agent session については、`copilotclaw_receive_input` tool に関する情報が最優先
- これがないとシステムが壊れる
- SOUL.md などで、`copilotclaw_receive_input` tool のことを忘れてしまわないように、最初と最後に `copilotclaw_receive_input` tool のことを念入りに書いておく

### 多層防御の設計

- **システムプロンプト**（custom agent の prompt フィールド）→ `copilotclaw_receive_input` の義務を最初と最後に記載（既に実装済み: CHANNEL_OPERATOR_PROMPT）。ユーザーが変更できない、最も信頼性の高い層
- **AGENTS.md**（デフォルトテンプレート）→ セッション開始手順の一部として `copilotclaw_receive_input` の義務を冒頭と末尾に記載。ユーザーが削除しても、システムプロンプト側の記載がフォールバックになる

## Memory

- agent が学んだことや覚えておくべきことを、永続的に記録・参照できる仕組みがほしい
- OpenClaw のように、session をまたいで記憶が保たれるようにしたい
- workspace 内に memory ファイル（Markdown）として保存し、agent がビルトインツールで読み書きする

## Workspace の Git 管理

- agent が workspace で作業した内容を Git で追跡できるようにしたい
- OpenClaw はコード側で自動コミットはしないが、AGENTS.md テンプレートで「Commit and push your own changes」を proactive work として明記し、agent が自主的にコミットすることを誘導している（delegation パターン）
- setup 時に git init する（git がなければスキップ）
