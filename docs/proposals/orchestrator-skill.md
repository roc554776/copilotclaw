# Orchestrator Skill — Proposal

## 設計意図

Orchestrator フレームワークは、独立した worker subagent を組み合わせることで、AI 単独実行の死角（自己チェック不能・コンテキスト喪失）を構造的に排除する。

CLAUDE.md を cross-cutting ルールとして subagent に読ませると、subagent 自身が orchestrator skill を呼び出す無限ループが生じる。これを防ぐため、worker が読むべきルールは専用ファイル（`agents/worker.md`）に分離し、Orchestrator ロジックは skill 内に閉じ込める。

## ファイル構成

```
.claude/skills/orchestrator/
├── SKILL.md                          — Orchestrator の動作定義・定数・呼び出しフォーマット
├── agents/
│   └── worker.md                     — worker subagent が読むルールと response フォーマット
└── assets/
    └── workflows/
        └── default.md                — デフォルト workflow 定義
```

## 定数管理

以下の値を `SKILL.md` に定数として定義し、ハードコードしながらもマジックナンバーにしない。

| 定数名 | 内容 |
|--------|------|
| `worker_agent_type` | worker subagent の種別（`general-purpose` — 全 tool にアクセス可能） |
| `worker_model` | worker の使用モデル（現在: `claude-sonnet-4-6`） |
| `worker_rules_path` | worker.md のパス |
| `default_workflow_path` | デフォルト workflow のパス |
| `worker_anti_recursion_phrase` | 全 worker 呼び出しの冒頭に挿入する再帰防止フレーズ |

## Worker 呼び出し形式

Orchestrator は以下の layered 形式で worker を呼び出す。worker.md をインライン展開せず、worker 自身に読ませる。

```
{{worker_anti_recursion_phrase の値（定数ブロック参照）}}

{{worker_rules_path の値（定数ブロック参照）}} を読み、そこに書かれたルールに従って行動してください。
ただし、変数部は以下の値を使うこと：

<human_instructions>
{{ここに human_instructions の値を Orchestrator が埋める}}
</human_instructions>

<task>
{{ここに task の値を Orchestrator が埋める}}
</task>

<worker_role>
{{ここに worker_role の値を Orchestrator が埋める（例: doer / reviewer / fixer / expectation-auditor）}}
</worker_role>

<context>
{{ここに context の値を Orchestrator が埋める。省略時はこの行を "特になし" にする}}
</context>

<expected_output>
{{ここに expected_output の値を Orchestrator が埋める}}
</expected_output>
```

**Intent（なぜ `<immediate_task>` と `<output_format>` を worker.md 末尾に置くか）**: LLM は直近のコンテキストに強く影響される。変数値・ルール・ロール定義などの背景情報をプロンプト前半に置き、`<immediate_task>`（実行手順）と `<output_format>`（期待出力）をプロンプト末尾に配置することで、worker が「今何をすべきか」を文脈として最も近い位置で受け取れる。named tag（`<orchestrator_error_consideration>`, `<role_definitions>`, `<output_format>` 等）を worker.md に定義し、`<immediate_task>` 内でタグ名参照することで、詳細ルールを離れた場所に置きつつ参照時に適切に考慮させる。`<immediate_task>` と `<output_format>` は worker.md に一元管理し、呼び出しテンプレート（SKILL.md）には重複して記述しない。これにより将来の変更が一箇所で済み、drift を防ぐ。

呼び出しテンプレートの詳細は本 proposal が定義し、`SKILL.md` の「Worker 呼び出しフォーマット」セクションはこれに従う実装である。定数値（`worker_anti_recursion_phrase`・`worker_rules_path`）は `SKILL.md` の定数ブロックで一元管理する。

Orchestrator は `worker_agent_type`（= `general-purpose`）の subagent を Agent tool で呼び出し、`model` パラメータに `worker_model`（= `claude-sonnet-4-6`）を指定する。

## 再帰防止

`worker_anti_recursion_phrase` を定数として定義し、全 worker 呼び出しの冒頭に必ず挿入する。この定数を変更することなく、drift を防ぐ。

worker.md にも冒頭の mandatory preamble として、orchestrator skill と他の subagent の呼び出し禁止を明記する。

## デフォルト Workflow

```
[作業] → [レビュー] → 指摘あり → [修正] → [再レビュー] → ... → 指摘ゼロ
                                                                      ↓
                                                              [期待値確認]
                                                           充足 ↙     ↘ 未充足
                                                        [完了]       [作業へ戻る]
```

内側ループ（レビューループ）・外側ゲート（期待値確認）のいずれも回数上限を設けない。品質収束を時間より優先する。

## 引数パーシング

`$ARGUMENTS` から `--workflow {{name}}` フラグを抽出し、残余を `human_instructions` とする。これにより framework 引数が `human_instructions` に混入しない。

## 境界と制約

- 既存の skill（process-requirements, implement, fetch-codebase 等）は変更しない
- Orchestrator 自身はコードを変更しない。作業・レビュー・修正はすべて worker に委譲する
- CLAUDE.md のルールは Orchestrator 自身が守る。worker には worker.md 経由で伝える
