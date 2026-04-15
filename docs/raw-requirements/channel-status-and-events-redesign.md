# Channel Status and Events Redesign (raw requirement)

<!-- 2026-04-14 -->
チャンネルのステータス定義について補足しておく。

- チャンネルのステータスは本来複雑な状態を内包している。
  - 例
    - 対応する abstract session の状態
    - 現在アクティブな physical session の状態
    - turn run の状態
  - 画面上で表示するチャンネルのステータスはそれを単純な状態に射影したものです。
    - ※ 本来チャンネルのステータスであるものが、ステータスバーに表示されているので、やや分かりにくい。選択中のチャンネルと、そのステータス、というような表示が望ましい。
    - 何かしらのデザインに基いて、ステータスを定義する必要がある。
    - 画面上で表示するので、ユーザーにとって便利なものになるべき。
    - この意味のステータスは何かしらの排他的な enum 的ものになり、定義と状態から導出されるものになるべき。
    - 要望としてほしいステート
      - （単一の） SDK client が起動していない
      - （初回なので）チャンネルに対応する physical session が存在しない
        - ※ abstract session は常に存在します。
      - （physical session の強制停止後なので）チャンネルに対応する physical session が存在しない
        - 普段は、前回の physical session を引き継ぐので、この状態にはならない
        - ※ abstract session は常に存在します。
      - physical session はあるが、 turn run が開始されておらず、その起動トリガーとなるイベントも発生していない
      - turn run 開始前で、turn run が開始されておらず、その起動トリガーとなるイベントは発生している状態
        - ここから turn run が開始されるはず
      - turn run が開始されており、 copilotclaw_wait で待っているのではない状態
        - copiltoclaw_wait の待ち状態が解除され、稼動している状態も含む
- 例えば、無理矢理全てをメッセージとして処理しようとしているため、メッセージの sender 等で copilotclaw_wait の待ちを解除するべきか調整した結果としてスパゲッティコードになっている（と想像している）
  - より抽象化したイベントの定義と、その一部としてメッセージイベントがある、というような整理が必要
  - メッセージでないイベントについても channel operator が知覚すべきものが含まれるはず。
- sub-subagent の完了通知が親エージェントへのメッセージとして届いてしまい、雑音になっている（これもコードが荒れていることが原因と考えている）
  - parent tool call id を見れば sub-subagent のイベントかどうかは分かるはず。
- さらに追加要望として考えているもの
  - メッセージが誰からのものか分かるようにする
    - copilotclaw_send_message は誰が使ったか分からない可能性がある。何かしらの方法で誰が使ったか分かるようにする必要がある。
      - なお、 hooks は親エージェント（channel-operator）に対してしか機能してくれないので、 hooks を使って sender を特定するのは難しい。
      - もしかしたら session event などを活用したりすれば可能なのかもしれないが、少なくとも一定の高度な工夫が必要。
      - もし session event が subagent/sub-subagent/... のイベントも拾えるのであれば、 tool call event からメッセージを拾うことで、対処できる。（呼び出された tool 側自体は特に何もしない or ログを取っておくだけにするとか。）
    - user, agent(channel-operator, subagent/subsubagent ... など)
      - agent は id と表示名を持つので内部的に区別できる
      - アイコン + 表示名で、ユーザーに分かりやすく表示する
      - task tool （subagent を呼び出すツール）のインタフェースを把握し、かつシステムプロンプトなどを工夫することで、上手く agent ごとに違う名前が割り当てられるようにする工夫が必要
      - アイコンを押したときに、プロフィールのような感じのモーダルで agent のタイプや、モデル、ステータス（session-event で分かる範囲で OK）も表示する
      - subagent/sub-subagent/... からのメッセージは、基本的には collapse しておいて、必要に応じて展開できるようにする
  - メッセージ以外にもチャンネルのタイムライン UI 上に表示すべき要素がある。
    - turn run が開始、停止イベントがタイムライン上で表示される
    - subagent/sub-subagent/... の開始、 idle 、停止等々のイベントもタイムライン上で表示される
  - copilotclaw_send_message に加えて、 copilotclaw_intent のような、 agent の意図を伝えるための tool を追加する
    - これは GitHub Copilot の intent と同様のもので、 agent が何をしようとしているのかを伝えるためのもの
    - intent は、 UI のチャンネルのタイムライン上では、メッセージとは区別して表示し、まずは、 agent のプロフィールモーダル上でのみ、タイムライン的に表示するのがよさそう。
    - 他のツールと同時に呼ぶ（単独で呼ぶな）というようなシステムプロンプトをつけることで、 tool 呼び出し時に、その意図も伝わるようにするようにしているらしい
  - channel operator と worker に渡すべきツールを整理する
    - channel operator に渡す tool
      - ビルトインツール
      - copilotclaw_wait, copilotclaw_list_messages, copilotclaw_send_message, copilotclaw_intent
    - worker に渡す tool
      - ビルトインツール
      - copilotclaw_list_messages, copilotclaw_send_message, copilotclaw_intent
    - ビルトインツールを list する API が SDK にあるので、それを使って、 custom agent の定義の tool 定義に明示するようにする
      - そうしないと、どうやら copilotclaw_* ツールが割り当てられるときと、そうでないときができてしまう。

<!-- 2026-04-14 -->
もう少しだけ要望追加しておく

- チャンネルのメッセージ、イベントステータス等、チャンネルごとの情報は SSE で送信してほしい。
- チャンネル固有でない情報は、専用の SSE で送信してほしい。
- （現状は、メッセージだけが SSE で送られており、それ以外はポーリングなので、 UI の描画が滑らかでない。）

<!-- 2026-04-15 -->
- session-scoped SSE に Last-Event-ID reconnect replay を実装して、切断→再接続時の event 欠損を解消してほしい。ネットワーク blip やタブ sleep の後に missed event が戻ってくるように。EventSource の Last-Event-ID 標準機能を使いたい。global / channel SSE の replay は別 scope で後回し。
