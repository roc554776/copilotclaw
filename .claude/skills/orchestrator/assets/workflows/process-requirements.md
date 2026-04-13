# Process Requirements Workflow

このファイルは Orchestrator の **process-requirements workflow** を定義する。human から受け取った要望を3層のドキュメント（raw-requirements / requirements / proposal）に整理・反映するために使う。`/orchestrator "要望テキスト" --workflow process-requirements` で呼び出す。

**Intent（なぜ専用 workflow か）**: process-requirements は汎用の「作業 → レビュー → 修正」とは異なる固有の substep 構造を持つ。既存ドキュメントの確認・関連実装の確認・内容の整理・ドキュメントへの反映・整合性レビューという段階が意味的に分かれており、それぞれに固有のルールが存在する。

**Intent（ドキュメントのみ変更する理由）**: 本 workflow は要望の意図をドキュメントに正確に記録することを唯一の責務とする。実装の変更は別途 Document-First Workflow に従って行われる。

## ローカル変数

- `latest_work_output`: doer または最新の fixer の出力（worker の全 response テキスト）。各イテレーションごとに更新される
- `latest_review`: 最新のレビュー worker の出力（worker の全 response テキスト）。終了判定と修正指示の根拠として使われる

<doc_layer_spec>
以下の3層構造でドキュメントを管理する。

| 層 | パス | 役割 |
|----|------|------|
| raw-requirements | `docs/raw-requirements/` | human 原文をそのまま記録する。要約・改変・補足の一切を禁じる |
| requirements | `docs/requirements/` | raw-requirements を整理した要求。要件定義ではなく「要望の構造化」。原文の意図を損なわず記述する |
| proposal | `docs/proposals/` | 要件定義。具体的な設計・実装方針を記述する。`docs/proposals/status.md` の未実現セクションに未実現の要望を追記する |

**重要な区別**: requirements は要件定義ではない。proposal が要件定義である。

raw-requirements のファイルは human 要望のテーマ別に分かれている（例: `agent-session.md`, `orchestrator-skill.md`）。新規テーマには新規ファイルを作成し、既存テーマには適切なファイルに追記する。
</doc_layer_spec>

<timestamp_rule>
raw-requirements に新しいブロックを追加するときは、ブロックの直前に ISO 8601 日付のタイムスタンプコメントを付与すること。

```
<!-- YYYY-MM-DD -->
- 要望の内容（human 原文）
```

目的: 矛盾する要望が生じたとき、どちらが新しいかを明確にするため。
</timestamp_rule>

<verbatim_rule>
raw-requirements には human の発言原文をそのまま記録する。要約・言い換え・補足・意図の推測による書き換えは一切禁じる。「分かりやすく」「簡潔に」する目的での変更も許されない。
</verbatim_rule>

<content_organization_rules>
- **抽象セッションと物理セッション**など、プロジェクト固有の概念を正確に区別して記述すること。混同すると設計の意図が失われる
- 現時点で実装されていない要望・機能には `（未実現）` マーカーを明記する（requirements・proposal の記述内、および proposals/status.md の `**未実現:**` セクション）
- 既存ドキュメントと新しい要望が矛盾する場合、**新しい要望が優先される**。古い記述を更新し、矛盾を残さない
- ドキュメントが実装と一致していると盲信しないこと。コードを読んで現状を把握し、実際の実装状態を根拠にする
</content_organization_rules>

<reflection_targets>
各層のドキュメントに以下のように反映する：

- **raw-requirements**: human 原文を適切なファイルに追記する。timestamp_rule を適用し、verbatim_rule を厳守する
- **requirements**: 整理した要求を適切なファイルに追記・更新する。既存記述と矛盾する場合は更新する
- **proposal** (`docs/proposals/`): 要件定義を適切なファイルに追記・更新する
- **proposals/status.md**: 未実現の要望を `**未実現:**` セクションに追加する。既に記載されている場合は重複させない

このワークフローはドキュメントのみ変更する。コードの変更は行わない。
</reflection_targets>

<integrity_review_scope>
レビュー時は以下の観点を**必ず**確認する（ただし指摘範囲はこれに限定されない）：

- **raw vs requirements 整合性**: requirements に原文にない内容が追加されていないか・原文の内容が欠落していないか・原文の意図を歪めていないか
- **raw vs proposal 整合性**: proposal の「現状の問題」が原文の指摘と一致しているか・原文にない原因を断定していないか
- **proposals/status.md 漏れ確認**: 未実現の要望が `**未実現:**` セクションに漏れなく追記されているか

上記は reviewer が**必ず確認すべき観点**であり、reviewer はそれ以外に気づいた問題（誤字・別テーマへの波及・既存記述の矛盾など）もすべて指摘してよい。`[スコープ外]` のような silent-drop 用タグは使わない。

**Intent**: スコープを狭く絞って silent-drop を許すと、reviewer の偶発的な気づきがループ内で誰にも拾われず情報が消える。スコープクリープよりも、セッション間で記憶を失ったことで自分が発生させた問題をスコープ外として放置することの方が現実的かつ致命的なリスクである。
</integrity_review_scope>

<integrity_review_termination_condition>
以下の**すべて**を満たした場合のみ終了する：

- `latest_review` の `<completion_status>` が `完了` であること
- `latest_review` の `<findings>` に指摘が一切存在しない（「なし」または空）こと。スコープ内外を問わない

`<completion_status>` が `部分完了` または `未完了` の場合、Orchestrator は不完全な点を把握し、追加の context を付与した上で修正後に再レビューする。
</integrity_review_termination_condition>

<orchestrator_read_obligation>
各 worker の response から `<orchestrator_instruction_reinterpretation>` タグを確認し、指示の誤りが報告された場合は workflow の前提を修正して継続する。
</orchestrator_read_obligation>

<worker_isolation_rule>
作業 worker・レビュー worker・修正 worker は、同一ループ内でもそれぞれ**別の worker 呼び出し**として実行する。同じ subagent を再利用してはいけない。
</worker_isolation_rule>

<expectation_termination_condition>
期待値確認の終了条件: `expectation-auditor` の `<human_expectation_alignment>` に未充足の期待値が存在しなければ workflow を完了する。未充足が存在する場合は、Orchestrator は不足内容を分析し、その内容を context に含めて step `organize_and_reflect` に戻る。
</expectation_termination_condition>

<immediate_task>
<step name="read_existing_docs">worker（doer）を呼び出す。task は「human_instructions で述べられた要望に関連する既存の raw-requirements / requirements / proposal（`docs/raw-requirements/`, `docs/requirements/`, `docs/proposals/`）を確認し、関連するドキュメントの現状をまとめること。直接同じ内容でなくとも、設計上関連する内容があり要望の実現に影響する可能性がある文書も対象に含める」。context は特になし（初回）。出力を latest_work_output として保持する。orchestrator_read_obligation に従う。完了後、step `read_related_implementation` に進む。</step>
<step name="read_related_implementation">worker（doer）を呼び出す。task は「human_instructions で述べられた要望に関連する実装（コード）を確認し、現在の実装状態をまとめること。ドキュメントに現れない実装詳細も対象に含める。ドキュメントと実装が一致していると盲信してはいけない。抽象セッションと物理セッションなど、プロジェクト固有の概念の実装上の区別を確認すること」。context は latest_work_output（前の step の調査結果）。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `organize_and_reflect` に進む。</step>
<step name="organize_and_reflect">worker（doer）を呼び出す。task は human_instructions を分析し、以下のルールに従って要望を3層ドキュメントに整理・反映すること（raw-requirements への原文の追記、requirements への構造化された要求の記述、proposal への要件定義の記述、proposals/status.md の未実現セクションへの追記）。コードの変更は行わない。Orchestrator は doc_layer_spec・timestamp_rule・verbatim_rule・content_organization_rules・reflection_targets の各内容を task に含めること。context は latest_work_output（既存ドキュメントと実装の調査結果）。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `integrity_review` に進む。</step>
<step name="integrity_review">worker（reviewer）を呼び出す。task は latest_work_output が示すドキュメント変更を審査し、不整合・問題点を列挙すること（問題がなければ「指摘なし」と明示すること）。Orchestrator は integrity_review_scope の内容を task に含めること（必須確認観点 + スコープ外でも気づいた問題は全て指摘する旨）。context は latest_work_output（変更されたドキュメントの内容または変更内容の要約）。出力を latest_review として保持する。orchestrator_read_obligation に従う。worker_isolation_rule を守る。**integrity_review_termination_condition に従い終了判定：終了条件を満たした場合は step `audit_expectations` に進む。満たさない場合は step `integrity_fix` に進む。**</step>
<step name="integrity_fix">worker（fixer）を呼び出す。task は latest_review が指摘した**全ての**問題を修正すること（スコープ内外を問わない）。Orchestrator は integrity_review_scope の内容を task に含めること。context は latest_work_output と latest_review の両方。修正出力を latest_work_output として更新する。orchestrator_read_obligation に従う。worker_isolation_rule を守る。修正 worker の `<completion_status>` が `部分完了` または `未完了` の場合、その旨を次のレビューの context に含める。完了後、step `integrity_review` に戻る。</step>
<step name="audit_expectations">expectation-auditor worker を呼び出す。task は human_instructions に書かれた要望がすべての変更ドキュメントに漏れなく反映されているかをひとつひとつ確認し未充足があれば明記すること。context は latest_work_output と latest_review。orchestrator_read_obligation に従う。**expectation_termination_condition に従い判定：未充足が存在しない場合は step `report_completion` に進む。存在する場合は不足内容を context に含めて step `organize_and_reflect` に戻る。**</step>
<step name="report_completion">human に以下を報告する：反映した要望の概要・編集ファイル一覧（各 doer および fixer worker の `<edited_files>` タグから集約する。reviewer と expectation-auditor は通常ファイルを変更しないため集約対象外）・整合性レビューループのイテレーション回数・期待値確認で確認した各要望の充足状況。これで workflow は完了する。</step>
</immediate_task>
