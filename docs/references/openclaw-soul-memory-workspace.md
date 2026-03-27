# OpenClaw: Workspace・SOUL.md・Memory 参考情報

Source: `https://github.com/openclaw/openclaw`

OpenClaw における agent workspace、自己認識（SOUL.md）、記憶（Memory）、および workspace Git 管理について、codebase から得た知見。

---

## System Prompt（ハードコード部分）

OpenClaw のシステムプロンプトは `src/agents/system-prompt.ts` の `buildAgentSystemPrompt()` で構築される。ユーザーが変更できないハードコード部分と、workspace files として注入されるユーザー編集可能部分の2層構造。

### ハードコードされるセクション一覧

`buildAgentSystemPrompt()` が生成する固定セクション（ユーザー変更不可）:

| セクション | 内容 |
|---|---|
| Identity | `"You are a personal assistant running inside OpenClaw."` |
| Tooling | 利用可能ツール一覧（read, write, edit, exec, grep, find, ls 等）+ 各ツールの説明 |
| Tool Call Style | 低リスクなら無言で実行、複雑/センシティブなら説明。plain human language で |
| Safety | 自己保存・自己複製・権限拡大の禁止、人間の監督を優先（Anthropic constitution 参照） |
| CLI Quick Reference | `openclaw gateway status/start/stop/restart` 等のコマンド |
| Skills | `<available_skills>` からスキルを選んで SKILL.md を読む手順（mandatory） |
| Memory Recall | `memory_search` / `memory_get` ツールが有効な場合のみ追加 |
| Self-Update | `gateway` ツールが有効な場合のみ、config/update の操作方法 |
| Workspace | `"Your working directory is: {{workspaceDir}}"` + ファイル操作方針 |
| Docs | OpenClaw ドキュメントの参照先 |
| Workspace Files (injected) | `"These user-editable files are loaded by OpenClaw and included below in Project Context."` |
| Reply Tags | `[[reply_to_current]]` 等のリプライタグ仕様 |
| Messaging | メッセージ送信のルーティング方法 |
| Voice | TTS ヒント（有効な場合のみ） |
| Silent Replies | `HEARTBEAT_OK` 応答のルール |
| Heartbeats | Heartbeat poll への応答方法 |
| Sandbox | サンドボックス環境の制約（有効な場合のみ） |
| Reasoning | `<think>...</think>` 推論フォーマット（有効な場合のみ） |
| Runtime | agent ID, host, OS, model, channel 等のランタイム情報 |

**PromptMode（subagent 制御）:**
- `"full"` — 全セクション（メイン agent 用）
- `"minimal"` — Tooling, Workspace, Runtime のみ（subagent 用）
- `"none"` — Identity 1 行のみ

### Project Context セクション（ユーザー編集可能部分の注入）

workspace bootstrap files が `# Project Context` セクションとしてシステムプロンプトの末尾に注入される:

```
# Project Context

The following project context files have been loaded:
If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies;
follow its guidance unless higher-priority instructions override it.

## AGENTS.md
（ファイル内容）

## SOUL.md
（ファイル内容）

## USER.md
（ファイル内容）
```

SOUL.md の存在を検出（line 608-612）し、存在する場合のみ「embody its persona and tone」指示を追加。「higher-priority instructions override it」= ハードコードされたシステムプロンプト本体が優先。

Source: `src/agents/system-prompt.ts` lines 176-703

---

## Workspace Bootstrap Files

setup 時に `~/.openclaw/workspace/` に以下のファイルが生成される。これらは全て **ユーザー向け** のファイルであり、agent のシステムプロンプトではない。agent はセッション開始時にこれらを読み取り、指示に従う。

| ファイル | 用途 |
|---|---|
| `AGENTS.md` | workspace の操作マニュアル。セッション開始手順、memory の使い方、安全ルール、heartbeat 運用等 |
| `SOUL.md` | agent の人格・トーン・価値観。ユーザーがカスタマイズする |
| `USER.md` | ユーザー情報 |
| `IDENTITY.md` | agent の名前・emoji |
| `TOOLS.md` | ローカルツールのメモ（カメラ名、SSH 詳細等） |
| `HEARTBEAT.md` | 定期チェックのチェックリスト（任意） |
| `BOOTSTRAP.md` | 初回起動時のみ存在。"birth certificate" — 読んだら削除する |

Source: `src/agents/workspace.ts` lines 25-31, `docs/reference/templates/`

---

## SOUL.md

**SOUL.md はシステムプロンプトではない。** ユーザーが agent の人格やトーンを定義するファイルである。agent はこれを読み取り、「体現」する。

**SOUL.md は AGENTS.md より優先される。** システムプロンプトでは SOUL.md の存在を検出し、`"embody its persona and tone"` という特別な指示を追加する（AGENTS.md にはこのような特別扱いはない）。AGENTS.md テンプレートの Session Startup でも、読み取り順序は SOUL.md が最初（「this is who you are」）。

デフォルトテンプレートの構造:
- **Core Truths** — 行動原則（genuinely helpful, have opinions, be resourceful, earn trust, remember you're a guest）
- **Boundaries** — 安全ルール（private things stay private, ask before acting externally）
- **Vibe** — トーンの指針（concise when needed, thorough when it matters）
- **Continuity** — 「これらのファイルがあなたの記憶である。読め。更新しろ。」

system prompt からの参照方法（`src/agents/system-prompt.ts`）:
```
If SOUL.md is present, embody its persona and tone.
Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.
```

→ 「higher-priority instructions」がシステムプロンプト自体を指す。SOUL.md はシステムプロンプトより低い優先度。

Source: `docs/reference/templates/SOUL.md`, `src/agents/system-prompt.ts` lines 608-617

---

## AGENTS.md（操作マニュアル）

agent がセッション開始時に従う手順書。デフォルトテンプレートの構造:

**Session Startup:**
- `SOUL.md` を読む（自己認識）
- `USER.md` を読む（ユーザー情報）
- `memory/YYYY-MM-DD.md`（今日 + 昨日）を読む（直近のコンテキスト）
- メインセッションなら `MEMORY.md` も読む

**Memory:**
- `memory/YYYY-MM-DD.md` — 日次ログ（raw notes）
- `MEMORY.md` — 長期記憶（curated、メインセッションのみロード）
- 「Mental notes はセッション再起動で消える。ファイルに書け」

**Red Lines / External vs Internal:**
- 読み取り・整理・学習は自由にやれ
- メール送信・SNS 投稿等は先に聞け

Source: `docs/reference/templates/AGENTS.md`

---

## Memory System

### ファイル構成

- `MEMORY.md` — 長期記憶。agent が curate する "distilled essence"
  - メインセッションのみロード（セキュリティ: グループチャット等に漏れないように）
  - agent が自由に読み書き・更新する
- `memory/YYYY-MM-DD.md` — 日次ログ。raw notes
  - 毎日のファイルに、何が起きたかを記録
- `memory/heartbeat-state.json` — 定期チェックの状態追跡

### Memory Plugin（memory-core）

- SQLite バックエンドのオプショナルプラグイン
- `memory_search` / `memory_get` ツールを提供
- system prompt に "Memory Recall" セクションを追加（質問に答える前に memory_search を実行するよう指示）

### Memory ロードタイミング

- bootstrap files として session 開始時にロード
- AGENTS.md の指示に従い、agent がセッション開始時に自発的に読む

Source: `src/agents/workspace.ts` lines 467-485, `extensions/memory-core/`

---

## Workspace Git 管理

### git init

- brand-new workspace の場合のみ `git init` を実行
- git が利用不可の場合は静かにスキップ（workspace 作成は続行）
- 既存の `.git` がある場合はスキップ

Source: `src/agents/workspace.ts` lines 310-325

### Git コミットの誘導

**システムプロンプト自体には git commit の指示はない。** しかし、AGENTS.md テンプレートが workspace bootstrap file としてシステムプロンプトの "Project Context" セクションに注入されるため、実質的にシステムプロンプトを通じて agent に git 操作を誘導している。

AGENTS.md の heartbeat セクション（line 196-202）:
```
Proactive work you can do without asking:
- Read and organize memory files
- Check on projects (git status, etc.)
- Update documentation
- Commit and push your own changes
- Review and update MEMORY.md
```

→ 「Commit and push your own changes」が **許可なしに行える作業** として明示されている。

これは **delegation パターン**: システムプロンプトはインフラ（ファイル注入、workspace context）を提供し、AGENTS.md が agent 固有のポリシー（何をいつ行うか）を提供する。

Source: `docs/reference/templates/AGENTS.md` lines 196-202, `src/agents/system-prompt.ts` lines 553-554

---

## Profile ごとの State ディレクトリ分離

OpenClaw は profile ごとに state ディレクトリ自体を分離する:
- デフォルト: `~/.openclaw/`
- 名前付き profile: `~/.openclaw-{{profile}}/`（例: `~/.openclaw-dev/`）

config, workspace, sessions の全てが state ディレクトリ内に格納されるため、profile 間の干渉がない。

dev profile には特別なデフォルトポート (19001) がある。

Source: `src/cli/profile.ts` lines 81-88, `src/config/paths.ts` lines 106-115

## CopilotClaw への適用ポイント

**システムプロンプト vs ユーザーファイルの分離:**
- `copilotclaw_receive_input` の義務 → **システムプロンプト**（custom agent の `prompt` フィールド）に書く。ユーザーが変更できてはならない
- SOUL.md / AGENTS.md / MEMORY.md → **workspace 内のファイル**。ユーザーが自由にカスタマイズする。agent がビルトインツールで読み書きする

**ファイル読み取りの仕組み:**
- OpenClaw は CLI 内部でファイルをロードする → CopilotClaw では agent が session 開始後に自発的にファイルを読む
- AGENTS.md に「セッション開始時にこれらのファイルを読め」と書いておけば、Copilot のビルトインツール（ファイル読み取り）で実現可能
- system prompt（custom agent の prompt）に「AGENTS.md を最初に読め」という指示を含める
