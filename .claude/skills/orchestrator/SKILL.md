---
name: orchestrator
description: subagent を組み合わせて複雑なタスクを自律的に遂行する Orchestrator フレームワーク。workflow に従って worker subagent を呼び出し、レビューループで品質を保証する。subagent オーケストレーションが必要なとき、複数の worker を協調させたいとき、レビューループ付きで品質保証したいときに使う。
argument-hint: "[タスクの内容] [--workflow {{workflow名}}]"
---

このスキルは、subagent を組み合わせた multi-agent workflow の司令塔として機能する。human から受け取ったタスクを、定められた workflow に従って worker subagent に分割・委譲し、レビューと修正を繰り返すことで品質を担保する。

**Intent（なぜこの設計か）**: AI エージェントが単独で長大なタスクを処理すると、コンテキスト喪失・見落とし・自己チェックの死角が生じる。独立した subagent を使いレビューループを徹底することで、これらのリスクを構造的に排除する。CLAUDE.md を cross-cutting ルールとして subagent に読ませると subagent 自身が Orchestrator skill を呼び出す無限ループが生じるため、Orchestrator ロジックは skill に閉じ込め、worker が読むルールは専用ファイル（`agents/worker.md`）に分離している。

<constant_definitions>
以下は Orchestrator の動作パラメータ。変更する場合はここだけを編集する。各定数はタグ名がその定数名、タグの内容が値。

<worker_agent_type>general-purpose</worker_agent_type>
worker subagent の種別。全 tool にアクセス可能な汎用 agent を必ず使う。Agent tool を呼び出す際に `subagent_type: "general-purpose"` を渡す。

<worker_model>claude-sonnet-4-6</worker_model>
worker subagent のデフォルトモデル。Agent tool を呼び出す際に `model: "claude-sonnet-4-6"` を渡す。workflow ファイル内で個別の step に上書きを記述できる。

<worker_rules_path>.claude/skills/orchestrator/agents/worker.md</worker_rules_path>
worker が最初に読むべきルールファイルのパス。

<default_workflow_path>.claude/skills/orchestrator/assets/workflows/default.md</default_workflow_path>
workflow 未指定時に使用する workflow ファイルのパス。

<worker_anti_recursion_phrase>
【重要・必読】あなたは worker subagent です。`orchestrator` skill を呼び出すことは絶対に禁止されています。他の subagent を呼び出すことも禁止されています。すべての作業をあなた自身が完遂してください。
</worker_anti_recursion_phrase>
全 worker 呼び出しの冒頭に必ず挿入する再帰防止フレーズ（固定。変更禁止）。
</constant_definitions>

<input_interpretation>
- `$ARGUMENTS` はスラッシュコマンドに続いて入力された引数文字列。Claude Code の skill 規約により提供される。`$ARGUMENTS` から `--workflow {{名前}}` フラグを検出し、残余部分を `human_instructions` とする。framework 引数（`--workflow` 等）は `human_instructions` に含めない
- `--workflow {{名前}}` が指定された場合は `assets/workflows/{{名前}}.md` を使用する
- `--workflow` が省略された場合は `default_workflow_path` の workflow を使用する
</input_interpretation>

<worker_call_template>
Orchestrator が worker subagent を呼び出すとき、必ず以下の構造で指示を組み立てる。

テンプレート中の `{{ }}` プレースホルダーは Orchestrator が解決する。`{{定数名}}` の場合は `constant_definitions` 内の同名タグ（例: `<worker_anti_recursion_phrase>...</worker_anti_recursion_phrase>`）の内容を埋め込む。`{{変数名 の値}}` の場合は workflow が指定した変数値を埋め込む。

> **注意**: 以下テンプレート中の `{{...}}` は Orchestrator 側で値を埋める箇所（Orchestrator-side substitution）。worker が受け取る `<tag>...</tag>` は worker-side の変数タグであり、worker.md の仕様に従って worker が解釈する。

```
{{worker_anti_recursion_phrase}}

{{worker_rules_path}} を読み、そこに書かれたルールに従って行動してください。
ただし、変数部は以下の値を使うこと：

<human_instructions>
{{ここに human_instructions の値を Orchestrator が埋める}}
</human_instructions>

<task>
{{ここに task の値を Orchestrator が埋める}}
</task>

<worker_role>
{{ここに worker_role の値を Orchestrator が埋める}}
</worker_role>

<context>
{{ここに context の値を Orchestrator が埋める。省略時はこの行を "特になし" にする}}
</context>

<expected_output>
{{ここに expected_output の値を Orchestrator が埋める}}
</expected_output>
```

**各変数の説明**:

| 変数名 | 必須/省略可 | 内容 |
|--------|-----------|------|
| `human_instructions` | 必須 | human の指示原文。要約・改変禁止 |
| `task` | 必須 | Orchestrator がこの worker に依頼する具体的な作業内容 |
| `worker_role` | 必須 | この呼び出しでの worker の役割（例: `doer`, `reviewer`, `fixer`, `expectation-auditor`） |
| `context` | 省略可（デフォルト: 特になし） | 前の worker の出力や参照すべき情報 |
| `expected_output` | 必須 | worker が返すべき response のフォーマットと内容の期待値 |

**Subagent 呼び出しの実装**: Agent tool を使って `subagent_type: "general-purpose"`、`model: "claude-sonnet-4-6"` を指定して呼び出す（`worker_agent_type` / `worker_model` 定数を参照）。
</worker_call_template>

<worker_response_reading>
各 worker の response から以下の XML タグを読み取り、次のステップに反映する。

- `<completion_status>` — `完了` / `部分完了` / `未完了` のいずれか。具体的な対処方法（中断するか、context を補強して再呼び出しするか、等）は実行中の workflow ファイルが定義する
- `<edited_files>` — 作業 worker・修正 worker が編集したファイルの一覧。完了報告時に集約する
- `<summary>` — worker が行った作業の概要
- `<findings>` — 全ての指摘（スコープ内外を問わない）をレビューループの継続判定に使う
- `<orchestrator_instruction_reinterpretation>` — 指示の誤りが報告された場合は workflow の前提を修正し、必要なら再実行する
- `<human_expectation_alignment>` — expectation-auditor の出力から未充足要求を読み取る
</worker_response_reading>

<orchestrator_rules>
- Orchestrator 自身はコードを変更しない。作業・レビュー・修正はすべて worker に委譲する
- workflow の選択・worker への指示の組み立て・結果の集約は Orchestrator の責務
- CLAUDE.md のルール（Intent-First Governance、Document-First Workflow 等）は Orchestrator 自身が守る。worker には `worker_rules_path` 経由で別途伝える
- **Document-First の保証**: 任意のタスクが実装・コード変更を含む場合、Orchestrator はまず `process-requirements` skill を使って raw-requirements / requirements / proposal を更新する。文書更新を skip して worker に実装を委譲してはいけない。worker 自身はドキュメント更新の責務を負わない（worker は受け取ったタスクを実行するのみ）
</orchestrator_rules>

## 使用例

```
/orchestrator セッション切断時の自動再接続機能を実装する
/orchestrator ログ出力のフォーマットを統一する --workflow my-custom-workflow
```

（`--workflow` に指定するファイルは `assets/workflows/{{名前}}.md` として事前に作成しておく必要がある。現在ビルトインで用意されているのは `default`・`process-requirements`・`implement` の 3 つ）

---

<immediate_task>
<step name="init">constant_definitions を参照して定数値を把握する。input_interpretation に従い $ARGUMENTS を解釈し、human_instructions と workflow 指定（`--workflow` フラグ）を分離して保持する。worker_rules_path を読み worker に渡す内容を把握する。指定された（またはデフォルトの）workflow ファイルを読む</step>
<step name="run_workflow">読み込んだ workflow の immediate_task に従い、worker_call_template を使って worker subagent を順次呼び出す。各呼び出しでは worker_call_template の冒頭に worker_anti_recursion_phrase を必ず配置する。worker の response は worker_response_reading に従って読み取り、次のステップに反映する。orchestrator_rules を遵守して進める。workflow が終了したら結果を human に報告する</step>
</immediate_task>
