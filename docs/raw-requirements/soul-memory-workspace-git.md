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

<!-- 2026-03-27 -->

## State Directory と Workspace の概念的分離

- state directory と workspace は概念的に明確に区別してほしい
- state directory: `~/.copilotclaw` or `~/.copilotclaw-{{profile}}`
- workspace: `~/.copilotclaw/workspace` or `~/.copilotclaw-{{profile}}/workspace`
  - Copilot SDK の SessionConfig の workingDirectory は、この workspace を指すようにする
  - ※ Copilot SDK の仕様により、SessionConfig の workingDirectory は session ごとに固定されてしまい、subagent ごとに変えることはできない
    - （将来の機能の話）そのため、OpenClaw のような、同じ profile の中で複数の役割の agent を分ける機能を実装するには、OpenClaw と同じ設計ではだめ
    - 将来的には OpenClaw とは異なる workspace 設計を行い、同じ profile の中で複数の役割の agent を分ける機能を実現する

## Workspace の ensure と doctor チェック

<!-- 2026-03-27 -->

- workspace は agent によって git 管理されるべきもの（agent が SOUL.md や TOOLS.md, USER.md などを自分で管理する）
- workspace の ensure:
  - workspace dir を作って、git init し、`SOUL.md` `TOOLS.md` `USER.md` `memory/.gitkeep` などのファイルがなければ作り、それらを git add してコミットする
- `copilotclaw setup` を実行したときに、workspace の ensure を行う
- 物理 session の開始前にも、workspace の ensure を行う
- `copilotclaw doctor` したときに、workspace に不備があれば、エラーを出す
- `copilotclaw doctor --fix` で修正する

## Workspace の構造と使い方をシステムインストラクションに含める

<!-- 2026-03-27 -->

- workspace の構造やその使い方、git 管理することなどは、CopilotClaw 共通のシステムインストラクション部分（`CHANNEL_OPERATOR_PROMPT`）に入れておく
- CopilotClaw 共通のシステムインストラクションと SOUL.md 等はレイヤーが違うので注意する
  - CopilotClaw 共通のシステムインストラクション: ユーザーが変更しない。CopilotClaw システムが規定する
  - SOUL.md 等: ユーザーが変更してもいいし、agent が自分で変更してもいい（ユーザーの好みにカスタマイズする）

## 抽象セッションへのトークン消費履歴の紐づけ

- agent session は抽象層と物理層に分かれている
- 各セッションの消費トークン数等の履歴は、抽象層に紐づけて管理してほしい
  - 現状の課題:
    - 停止した物理セッションの履歴が dashboard で見られない
    - 抽象セッションごとのトークン消費量がわからない
