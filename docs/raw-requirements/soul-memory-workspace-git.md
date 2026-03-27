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
- SOUL.md 等の workspace ファイルを agent が読み込んだ結果、大量のコンテキストが注入され `copilotclaw_receive_input` の義務が埋もれて忘れられる可能性がある
- そのため、SOUL.md 等が読み込まれた後に、システム的に `copilotclaw_receive_input` のことをリマインドする対策が必要

### 多層防御の設計

- **システムプロンプト**（custom agent の prompt フィールド）→ `copilotclaw_receive_input` の義務を最初と最後に記載（既に実装済み: CHANNEL_OPERATOR_PROMPT）。ユーザーが変更できない、最も信頼性の高い層
- **workspace ファイル読み込み後のリマインド** → agent が SOUL.md / AGENTS.md 等を読み込んだ直後に、onPostToolUse hook 等でシステム的に `copilotclaw_receive_input` の義務をリマインドする（既に実装済み: session.usage_info / session.compaction_complete トリガーの `<system>` タグ方式）

## Memory

- agent が学んだことや覚えておくべきことを、永続的に記録・参照できる仕組みがほしい
- OpenClaw のように、session をまたいで記憶が保たれるようにしたい
- workspace 内に memory ファイル（Markdown）として保存し、agent がビルトインツールで読み書きする

## Workspace の Git 管理

- agent が workspace で作業した内容を Git で追跡できるようにしたい
- OpenClaw はコード側で自動コミットはしないが、AGENTS.md テンプレートで「Commit and push your own changes」を proactive work として明記し、agent が自主的にコミットすることを誘導している（delegation パターン）
- setup 時に git init する（git がなければスキップ）
