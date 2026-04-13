# Default Workflow

このファイルは Orchestrator の**デフォルト workflow** を定義する。`--workflow` オプションが省略された場合に使用される。

**Intent（なぜこの workflow か）**: AI が自分自身の成果物を自己チェックしても死角は埋まらない。独立した subagent による作業 → レビュー → 修正のループを、不整合ゼロになるまで繰り返すことで品質を構造的に保証する。さらに、human の期待値との整合性を外側のゲートとして設けることで、ループ収束後も human の真の要求を充たしているかを確認する。

**Intent（ループ回数について）**: 内側レビューループも外側期待値ゲートも、意図的に回数上限を設けない。品質の収束を実行時間より優先するという設計上の判断であり、制限のないループは設計の欠落ではなく設計の意図である。

## 概要

内側ループ（作業 → レビュー → 修正を指摘ゼロまで繰り返す）と、外側ゲート（human の期待値を確認し未充足なら内側ループへ戻る）の2重構造で品質を保証する。

## ローカル変数

このワークフロー内で使用するローカル変数の説明：

- `latest_work_output`: doer または最新の fixer の出力を指す（worker の全 response テキストを指す）。各イテレーションごとに更新される。レビューループの「現在の成果物」として一貫して参照される
- `latest_review`: 最新のレビュー worker の出力を指す（worker の全 response テキストを指す）。終了判定と修正指示の根拠として使われる

<review_termination_condition>
レビューループを終了して「期待値確認」に進む条件。以下の**すべて**を満たした場合のみ終了する：

- **完了状態の確認**: `latest_review` の `<completion_status>` が `完了` であること。`部分完了` または `未完了` の場合は終了しない
- **指摘の不在**: `latest_review` の `<findings>` に指摘が一切存在しない（「なし」または空）こと。スコープ内外を問わない

`<completion_status>` が `部分完了` または `未完了` の場合、Orchestrator はレビューの不完全な点を把握し、追加の context を付与した上でレビューを再度呼び出すか、または修正後に再レビューを行う。

**Intent**: `[スコープ外]` のような silent-drop タグを許すと、reviewer の偶発的な気づきがループ内で誰にも拾われず情報が消える。スコープクリープよりも、セッション間で記憶を失ったことで自分が発生させた問題をスコープ外として放置することの方が現実的かつ致命的なリスクである。
</review_termination_condition>

<expectation_termination_condition>
期待値確認の終了条件: `expectation-auditor` の `<human_expectation_alignment>` に未充足の期待値が存在しなければ workflow を完了する。

未充足の期待値が存在する場合は、Orchestrator は不足内容を分析し、「作業」ステップに戻って内側ループを再実行する。戻る際の `context` には `expectation-auditor` の指摘内容を含める。
</expectation_termination_condition>

<orchestrator_read_obligation>
各 worker の response から `<orchestrator_instruction_reinterpretation>` タグを確認し、指示の誤りが報告された場合は workflow の前提を修正して継続する。
</orchestrator_read_obligation>

<worker_isolation_rule>
作業 worker・レビュー worker・修正 worker は、同一ループ内でもそれぞれ**別の worker 呼び出し**として実行する。同じ subagent を再利用してはいけない。
</worker_isolation_rule>

<immediate_task>
<step name="do_work">以下の変数で worker を呼び出す。task は human_instructions を分析して遂行方針・対象範囲・具体的な作業内容を具体化して記述すること（human_instructions をそのままコピーしてはいけない。作業方針の判断を worker に丸投げすることは禁止）。worker_role は `doer`。context は特になし（初回呼び出しのため）。expected_output は作業完了後の成果物の概要と Worker Response フォーマットに準拠した報告。出力を latest_work_output として保持する。orchestrator_read_obligation に従い `<orchestrator_instruction_reinterpretation>` タグを確認する。完了後、step `review` に進む。</step>
<step name="review">以下の変数で worker を呼び出す。task は latest_work_output の内容を審査し問題点・改善点を列挙すること（問題がなければ「指摘なし」と明示すること）。気づいた問題はスコープ内外を問わずすべて報告すること。worker_role は `reviewer`。context は latest_work_output。expected_output は Worker Response フォーマット準拠の報告（`<findings>` タグに指摘を列挙、指摘がない場合は「なし」と明記）。出力を latest_review として保持する。orchestrator_read_obligation に従い `<orchestrator_instruction_reinterpretation>` タグを確認する。worker_isolation_rule を守る。review_termination_condition に従い終了判定を行う：終了条件を満たした場合（`<completion_status>` が `完了` かつ `<findings>` に指摘が一切存在しない）は step `audit_expectations` に進む。終了条件を満たさない場合は step `fix` に進む（`<completion_status>` が `部分完了` または `未完了` の場合はその旨を次の context に含める）。</step>
<step name="fix">以下の変数で worker を呼び出す。task は latest_review が指摘した**全ての**問題を修正すること（スコープ内外を問わない）。worker_role は `fixer`。context は latest_work_output と latest_review の両方。修正出力を latest_work_output として更新する。orchestrator_read_obligation に従い `<orchestrator_instruction_reinterpretation>` タグを確認する。worker_isolation_rule を守る。修正 worker の `<completion_status>` が `部分完了` または `未完了` の場合、その旨を次のレビューの context に含める。完了後、step `review` に戻る。</step>
<step name="audit_expectations">expectation-auditor worker を呼び出す。task は human_instructions に書かれた要求が実際の成果物によって充たされているかをひとつひとつ確認し未充足があれば明記すること。worker_role は `expectation-auditor`。context は latest_work_output と latest_review。expected_output は Worker Response フォーマット準拠の報告（`<human_expectation_alignment>` タグに充足状況を列挙）。orchestrator_read_obligation に従う。expectation_termination_condition に従い判定する：`<human_expectation_alignment>` に未充足の期待値が存在しない場合は step `report_completion` に進む。未充足の期待値が存在する場合は、Orchestrator は不足内容を分析し、その内容を context に含めて step `do_work` に戻る。</step>
<step name="report_completion">human に以下を報告する：実施内容の要約・編集ファイル一覧（各 doer および fixer worker の `<edited_files>` タグから集約する。reviewer と expectation-auditor は通常ファイルを変更しないため集約対象外）・レビューループのイテレーション回数・期待値確認で確認した各要求の充足状況。これで workflow は完了する。</step>
</immediate_task>
