# Custom Agents と Subagent 完了通知 (raw requirement)

<!-- 2026-03-26 -->

## Custom Agent によるシステムプロンプトの安定化

- copilotclaw としてのシステムプロンプトが、もっと安定して残るようにしたい
- 重要性: システムプロンプトが消えると、`copilotclaw_receive_input` を呼び出さなければいけないという重要な指示を失い、copilotclaw 自体が破綻するため、非常に非常に非常に重要
- custom agent を導入して、custom agent としてのシステムプロンプトを設定する

### custom agents 構成

- channel に紐づき、user と直接やりとりする agent
  - 適切な名前を考えてあげてください
  - 説明には、「絶対に subagent として呼び出されてはならない」という内容を限界まで強調して入れてください
  - システムプロンプトとして、今使っているような内容を設定する
    - 特に、`copilotclaw_receive_input` を呼び出すことなく停止すると、デッドロックになり、もう二度と動かなくなってしまい、非常に非常に非常に危険であることを強調してください
  - tools として、全てのビルトインツールに追加して、以下を提供する
    - copilotclaw_receive_input
    - copilotclaw_list_messages
    - copilotclaw_send_message

- subagent として呼び出される multi purpose agent
  - 適切な名前を考えてあげてください
  - 説明には、「subagent として呼び出す、事実上唯一の agent である」という内容を限界まで強調して入れてください
  - システムプロンプトは、特別不要
  - tools として、全てのビルトインツールに追加して、以下を提供する
    - copilotclaw_list_messages
    - copilotclaw_send_message

## onPostToolUse hook によるシステムプロンプト補強

<!-- 2026-03-26 -->
- copilotclaw としてのシステムプロンプトが、もっと安定して残るようにしたい
- 重要性: システムプロンプトが消えると、`copilotclaw_receive_input` を呼び出さなければいけないという重要な指示を失い、copilotclaw 自体が破綻するため、非常に非常に非常に重要
- channel に紐づく agent session については、tool use の post hook の additional context を使って、停止は NG であって代わりに `copilotclaw_receive_input` を呼び出さなければいけないということを、定期的に念じるようにする
  - ポイント: LLM は最初と最後の情報に重みを置く傾向がある
  - システムプロンプトで、additional context に、今の tool use とは関係がないが重要な指示が差し込まれることがある、という説明を入れておく
    - そのような指示は `<system>` タグでくくって additional context に入れられることがある、という説明も入れておく
  - additional context に、そういう指示を入れるときには `<system>` タグで囲うようにする
  - ※ post hook の仕様がよく分かってないが、subagent の post hook では発火してはいけない（超重要）ので、注意して実装してください
    - 理由: subagent は `copilotclaw_receive_input` を使わずに普通に停止すべき。そもそも `copilotclaw_receive_input` は与えない
  - additional context に定期的に指示を入れますが、毎回ではなく、Context（token usage）が 10% 増えるごとに 1 回入れるようにしましょう
    - 理由: 毎回だと、コンテキストが食い潰されてしまうため
- channel に紐づく agent session については、compact が起きた後には、すぐに tool use の post hook の additional context を使って、停止は NG であって代わりに `copilotclaw_receive_input` を呼び出さなければいけないということを、念じるようにしてください
  - 理由: compact はかなり性能が悪いので、compact 後は特に動作が不安定になりやすいと予想されるため
  - `session.compaction_complete` を使うのかな？
- 参考: docs/references/copilot-sdk-llm-context-and-message-retrieval.md

## Subagent の停止通知

- subagent の停止を、親エージェントが知覚できるようになってほしい
- 以下の session event で原理的には実現できるはず
  - `subagent.completed`
  - `subagent.failed`
- subagent は、親 agent から dispatch されるようなイメージなので、親とは非同期的に動く
  - なので、親は subagent を dispatch した後、ほとんどの場合、`copilotclaw_receive_input` で待っている状態になる

### 通知手段

- `copilotclaw_receive_input` tool の実装を変更して、subagent が停止したときに、tool としては subagent が停止した event 情報を返すようにする
- 親 agent もまだ動いているときに、subagent が停止した場合は、tool の posthook 等の additional context にねじ込むことで、比較的リアルタイムに通知する

<!-- 2026-03-29 -->
## subagent 停止通知の改修

- subagent が停止したことを wait している agent に通知する仕組みが必要です。
- この通知で wait が解除され、その通知をみた agent が次の行動を取れるようになります。
- ※ subagent call はネストされることがあります。直接呼び出した subagent の停止（成功失敗両方）のみを通知してください。
- ※ session event を使うことになるかと思います。 parent tool call の id を使えば、直接呼び出しか判定できるかと思います。
- 以前要望を出して完了報告も受けましたが機能してないみたいです。
- wait 中に色々なイベントやメッセージがやってくるが、それらをアドホックに処理する設計にしない。統一的な仕組みにする。
- フィルタリングロジックは agent process ではなく gateway process 側に置く。agent process は通知を受けて wait を解除するだけにする。
- session event を agent → gateway に送り、gateway 側が必要なフィルタリングをして agent に通知する構成にする。
- 理由: agent process をミニマルに保ち、gateway の更新だけで最新の機能を享受できるようにするコンセプトを維持するため。

<!-- 2026-03-31 -->
## subagent のネスト呼び出し通知の抑制

- subagent が呼び出した subagent の完了を、main の agent に伝えてしまうのはやめてください。
  - wait tool で待っている main agent には、直接呼び出しした subagent の停止だけを伝えてください。 parent tool call の id で判定できるはずです
