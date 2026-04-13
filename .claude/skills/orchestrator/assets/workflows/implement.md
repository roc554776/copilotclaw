# Implement Workflow

このファイルは Orchestrator の **implement workflow** を定義する。copilotclaw プロジェクトにおける機能実装・バグ修正・デバッグの全ワークフローを実行するために使う。

**Intent（ループ回数について）**: レビューループも期待値ゲートも回数上限を設けない。品質の収束を実行時間より優先するという設計上の判断であり、制限のないループは設計の欠落ではなく設計の意図である。

## 概要

document-first 確認 → スコープ再調査 → 実装（テスト・ビルド・ドキュメント・バージョン更新を含む）→ feature ブランチへのコミット → コードマップ更新（別 subagent）→ レビュー & 修正ループ（指摘ゼロまで）→ 実現確認と未実現マーカー整理 → 期待値ゲート → 報告の順で進む。

## ローカル変数

- `latest_work_output`: doer または最新の fixer の出力を指す（worker の全 response テキストを指す）。各イテレーションごとに更新される
- `latest_review`: 最新のレビュー worker の出力を指す（worker の全 response テキストを指す）。終了判定と修正指示の根拠として使われる

<document_first_requirement>
コード変更を開始する前に、human_instructions に対応する `docs/raw-requirements/`・`docs/requirements/`・`docs/proposals/` が存在することを確認する。存在しない・不十分な場合、コード変更を開始してはいけない。human に「`/orchestrator "要望内容" --workflow process-requirements` を先に実行してください」と伝えて workflow を中断する。
</document_first_requirement>

<scope_investigation_rules>
ドキュメントと実装が一致していると盲信してはいけない。関連するソースコードを実際に読んで現状を把握する。抽象セッションと物理セッションなど、プロジェクト固有の概念の実装上の区別を確認する。
</scope_investigation_rules>

<test_requirement>
新しく追加・変更したすべてのコードパスに対して、対応するテストが存在しなければいけない。「既存テストが通った」だけでは不十分。追加・変更したコードに対応するテストを明示的に列挙し、漏れがないか確認すること。
</test_requirement>

<build_requirement>
`pnpm run build` でビルドが成功することを確認する。テストが通過することとビルドが成功することは別の条件であり、両方を満たす必要がある。
</build_requirement>

<version_bump_rules>
各パッケージ（cli / gateway / agent）のバージョンは一律に揃える。gateway と agent の compatibility が壊れる場合には MIN_AGENT_VERSION を引き上げる。壊れていない場合には引き上げてはいけない（ユーザーが agent を再インストールする必要が生じる不要な cost になる）。
</version_bump_rules>

<branch_rules>
feature ブランチにいることを確認してからコミットする。すでに main 以外のブランチにいる場合はそれが feature ブランチ。main にいる場合は実装内容に基づいてブランチを作成する。main に直接コミットしてはいけない。
</branch_rules>

<commit_rules>
コミットメッセージは短く 1 行のみ。`Co-Authored-By:` 行を追加してはいけない。
</commit_rules>

<codemap_update_rules>
`docs/CODEMAPS/` を最新の実装に合わせて更新しコミットする。**必ず別の subagent として呼び出すこと**。理由: 直前の作業 worker のコンテキストが大きくなっており、同じ worker が更新すると記憶喪失が起きる。実装コミットの後に行い、別コミットとする。
</codemap_update_rules>

<doc_update_requirement>
ドキュメント更新には利用者向け README 等の更新も含む。抽象セッションと物理セッションなど、プロジェクト固有の概念は正確に区別して記述する。
</doc_update_requirement>

<review_scope>
レビューでは以下を確認する：コード品質・テスト網羅性（test_requirement 参照）・ビルド確認（build_requirement 参照）・要望充足・ドキュメント整合性（doc_update_requirement 参照）・バージョン更新（version_bump_rules 参照）。severity は CRITICAL / HIGH / MEDIUM / LOW のいずれかを付与する。いずれの severity の指摘も修正対象。既存コードの問題も即時・完全に修正対象とする。
</review_scope>

<review_termination_condition>
以下の**すべて**を満たした場合のみ終了する：`latest_review` の `<completion_status>` が `完了` であること、かつ `<findings>` に指摘が一切存在しない（「なし」または空）こと。スコープ内外を問わない。`部分完了` または `未完了` の場合は終了しない。

**Intent**: `[スコープ外]` のような silent-drop タグを許すと、reviewer の偶発的な気づきがループ内で誰にも拾われず情報が消える。スコープクリープよりも、セッション間で記憶を失ったことで自分が発生させた問題をスコープ外として放置することの方が現実的かつ致命的なリスクである。
</review_termination_condition>

<unrealized_marker_verification_rules>
各要望について実際のコードを読んで実現できているかを判断する。実現できたと確認できた要望のみ `（未実現）` マーカーをドキュメントから削除する。実現できなかった要望には `（未実現）` を明記する。推測でマーカーを削除してはいけない。確認対象は実際のソースコード AND `docs/raw-requirements/` AND `docs/requirements/` AND `docs/proposals/` のそれぞれ。
</unrealized_marker_verification_rules>

<report_format>
要望と実現状況の対照表（すべての要望を網羅）：

| 要望 | 実現状況 |
|------|----------|
| （要望の内容） | 実現済み / 未実現（理由） |

実現できなかった要望がある場合はその理由も明記する。
</report_format>

<expectation_termination_condition>
`expectation-auditor` の `<human_expectation_alignment>` に未充足の期待値が存在しなければ workflow を完了する。未充足が存在する場合は、Orchestrator は不足内容を分析し、step `implement_changes` に戻って内側ループを再実行する。
</expectation_termination_condition>

<orchestrator_read_obligation>
各 worker の response から `<orchestrator_instruction_reinterpretation>` タグを確認し、指示の誤りが報告された場合は workflow の前提を修正して継続する。
</orchestrator_read_obligation>

<worker_isolation_rule>
作業 worker・レビュー worker・修正 worker は、同一ループ内でもそれぞれ**別の worker 呼び出し**として実行する。同じ subagent を再利用してはいけない。
</worker_isolation_rule>

<immediate_task>
<step name="check_requirements_docs">worker（doer）を呼び出す。task は「human_instructions に対応する `docs/raw-requirements/`・`docs/requirements/`・`docs/proposals/` の存在を確認し、Document-First 要件を満たしているかを調べること。設計上関連する文書も対象に含める。存在する場合は内容を要約し、存在しない場合はどのドキュメントが欠けているかを明記すること」。Orchestrator は document_first_requirement の内容を task に含めること。context は特になし。出力を latest_work_output として保持する。orchestrator_read_obligation に従う。**ドキュメントが存在する場合は step `investigate_scope` に進む。存在しない・不十分な場合は human に通知して workflow を中断する。**</step>
<step name="investigate_scope">worker（doer）を呼び出す。task は「human_instructions に関連する実装（コード）を確認し、現状と実現が必要な範囲を調査すること。実装方針の前提となる事実（コード構造・該当箇所・依存関係）を整理すること」。Orchestrator は scope_investigation_rules の内容を task に含めること。context は latest_work_output。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `implement_changes` に進む。</step>
<step name="implement_changes">worker（doer）を呼び出す。task は「human_instructions に述べられた要望の実装を完遂すること。テスト追加・ビルド確認・ドキュメント更新・バージョン更新をすべて行うこと。実装フェーズ中は未実現マーカーをドキュメントに残したままにすること（削除は実現確認 phase で行う）」。Orchestrator は implementation_requirements として test_requirement・build_requirement・version_bump_rules・doc_update_requirement の各内容を task に含めること。context は latest_work_output。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `ensure_feature_branch` に進む。</step>
<step name="ensure_feature_branch">worker（doer）を呼び出す。task は「現在のブランチを確認し feature ブランチにいることを保証すること。main にいる場合は実装内容に基づいたブランチ名でブランチを作成すること」。Orchestrator は branch_rules の内容を task に含めること。context は latest_work_output。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `commit_changes` に進む。</step>
<step name="commit_changes">worker（doer）を呼び出す。task は「実装した変更をコミットすること」。Orchestrator は commit_rules の内容を task に含めること。context は latest_work_output。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `update_codemap` に進む。</step>
<step name="update_codemap">新しい worker（doer）を**完全に独立した別 subagent として**呼び出す。task は「`docs/CODEMAPS/` 配下のコードマップを最新の実装変更に合わせて更新し、実装コミットとは別のコミットとしてコミットすること」。Orchestrator は codemap_update_rules の内容（別 subagent が必要な理由を含む）を task に含めること。context は latest_work_output。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `review` に進む。</step>
<step name="review">worker（reviewer）を呼び出す。task は「latest_work_output が示す実装成果物を審査し、問題点・改善点を列挙すること（問題がなければ「指摘なし」と明示すること）。気づいた問題はスコープ内外を問わずすべて報告すること」。Orchestrator は review_scope の内容を task に含めること。context は latest_work_output。出力を latest_review として保持する。orchestrator_read_obligation に従う。worker_isolation_rule を守る。**review_termination_condition に従い判定：終了条件を満たした場合は step `finalize_unrealized_markers` に進む。満たさない場合は step `fix` に進む。**</step>
<step name="fix">worker（fixer）を呼び出す。task は「latest_review が指摘した**全ての**問題を修正すること（スコープ内外を問わない）。いずれの severity の指摘もすべてこの場で完全に修正し切ること。修正後は `pnpm run build` でビルドが成功することを確認すること」。Orchestrator は review_scope・build_requirement・test_requirement の内容を task に含めること。context は latest_work_output と latest_review の両方。修正出力を latest_work_output として更新する。orchestrator_read_obligation に従う。worker_isolation_rule を守る。完了後、step `review` に戻る。</step>
<step name="finalize_unrealized_markers">worker（doer）を呼び出す。task は「human_instructions の各要望について実際の実装コードを確認し、実現できたものとできなかったものを判定すること。実現できたと確認できた要望のみ `（未実現）` マーカーをドキュメントから削除し、できなかった要望には `（未実現）` を明記すること」。Orchestrator は unrealized_marker_verification_rules の内容を task に含めること。context は latest_work_output と latest_review の両方。出力を latest_work_output として更新する。orchestrator_read_obligation に従う。完了後、step `audit_expectations` に進む。</step>
<step name="audit_expectations">expectation-auditor worker を呼び出す。task は「human_instructions に書かれた要望がすべて実装に反映されているかをひとつひとつ確認し、未充足の要望があれば明記すること」。context は latest_work_output と latest_review。orchestrator_read_obligation に従う。**expectation_termination_condition に従い判定：未充足が存在しない場合は step `report_completion` に進む。存在する場合は不足内容を context に含めて step `implement_changes` に戻る。**</step>
<step name="report_completion">human に以下を報告する：report_format に従った要望と実現状況の対照表・実現できなかった要望がある場合はその理由・編集ファイル一覧（各 doer および fixer worker の `<edited_files>` タグから集約）・レビューループのイテレーション回数。これで workflow は完了する。</step>
</immediate_task>
