# Orchestrator Skill — Requirements

human からの要望を整理した要求。

## 背景と動機

AI エージェントが単独で長大なタスクを処理すると、コンテキスト喪失・見落とし・自己チェックの死角が生じる。これを構造的に解決するため、Orchestrator と worker subagent を分離した multi-agent framework を skill として実装する。

既存の skill や CLAUDE.md の cross-cutting ルールに触れることなく、新規フレームワークとして greenfield で構築する。CLAUDE.md を subagent に読ませると subagent 自身が orchestrator skill を呼び出す無限ループが生じるため、worker 向けルールは専用ファイルに分離する。

## Orchestrator Skill の要求

### 呼び出し方式

- 当初はスラッシュコマンド（`/orchestrator`）として呼び出す
- 将来的には agent 化を検討するが、今は単純な方式を選ぶ

### 再帰防止

- worker への指示には、orchestrator skill を呼び出さないことを示す固定フレーズを必ず含める
- この固定フレーズを定数として管理し、drift を防ぐ
- worker は orchestrator skill も他の subagent も呼び出してはいけない

### Worker 呼び出し形式

- worker への指示は、worker ルールファイルを worker 自身に読ませる形式（参照渡し）で渡す
- worker には全ての tool にアクセス可能な汎用 agent を必ず使う

### Workflow 管理

- subagent の呼び出し workflow は `{{skill}}/assets/workflows/*.md` に定義する
- 当面はビルトイン workflow のみをサポートする（将来 pluggable 化を想定）
- `--workflow` 未指定時はデフォルト workflow を使う

### デフォルト Workflow の要求

- subagent による作業に対し、常に別の subagent がレビューする
- レビューで指摘があれば修正し、さらに別の subagent が再レビューする
- 指摘がゼロになるまでループを続ける（回数上限なし。品質収束を優先する）
- さらに human の指示から期待値を読み取り、充足しているかを確認する外側ゲートを設ける
- 期待値未充足であれば、内側の作業ループに戻る（回数上限なし）

### Worker ルール（`agents/worker.md`）

- 変数タグ仕様を定義する
  - `<name />`: デフォルト値なし。Orchestrator が呼び出し時に必ず指定する
  - `<name>{{default}}</name>`: デフォルト値あり。Orchestrator が値を指定した場合はそちらを優先する
- worker は human の指示原文から期待値を自ら読み解き、Orchestrator の指示ミスを常に考慮する
- worker の response フォーマットを定義する
  - 編集ファイル一覧、発見した問題・観察事項（スコープ外も可）、指示を完遂できたか、指示を再解釈した部分、human 期待値との整合性評価

### パラメータ管理

- モデル名（例: sonnet の ID）、agent 種別などパラメータ化すべき値を定数として管理する
- ハードコードであっても、マジックナンバーにはしない（定数として名前を付ける）

## 境界と制約

- 既存の skill（process-requirements, implement, fetch-codebase 等）は変更しない
- Orchestrator 自身はコードを変更しない。作業・レビュー・修正はすべて worker に委譲する
- CLAUDE.md のルールは Orchestrator 自身が守る。worker には worker.md 経由で伝える

---

**注記**: 本ファイルの要求の一部は `SKILL.md` の「注意事項」にも記載されている。それらは意図的な冗長性であるが、両者を変更する場合は整合性を保つこと。両者が矛盾した場合、本ファイル（requirements）が正とし、`SKILL.md` を本ファイルに合わせて修正する。
