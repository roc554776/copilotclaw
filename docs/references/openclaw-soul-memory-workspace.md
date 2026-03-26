# OpenClaw: Workspace・SOUL.md・Memory 参考情報

Source: `https://github.com/openclaw/openclaw`

OpenClaw における agent workspace、自己認識（SOUL.md）、記憶（Memory）、および workspace Git 管理について、codebase から得た知見。

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

## CopilotClaw への適用ポイント

**システムプロンプト vs ユーザーファイルの分離:**
- `copilotclaw_receive_input` の義務 → **システムプロンプト**（custom agent の `prompt` フィールド）に書く。ユーザーが変更できてはならない
- SOUL.md / AGENTS.md / MEMORY.md → **workspace 内のファイル**。ユーザーが自由にカスタマイズする。agent がビルトインツールで読み書きする

**ファイル読み取りの仕組み:**
- OpenClaw は CLI 内部でファイルをロードする → CopilotClaw では agent が session 開始後に自発的にファイルを読む
- AGENTS.md に「セッション開始時にこれらのファイルを読め」と書いておけば、Copilot のビルトインツール（ファイル読み取り）で実現可能
- system prompt（custom agent の prompt）に「AGENTS.md を最初に読め」という指示を含める
