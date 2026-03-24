# Channel (raw requirement)

- define tool で定義する tool は全て `copilotclaw_{{name}}` という名前にする
- ユーザーに reply し、次の input を受け取る tool を define する
    - input は、メッセージ文字列
    - 処理の内容は、POST /api/replies して、`/api/inputs/next` を無期限にポーリング（5 秒 wait）し、取得できたらそれを return する
        - ただし、`/api/inputs/next` で受け取った input の最後に、reply 用ツール名でリプライすること、のような趣旨の指示を付け加える
- session 初期化で、最初の入力を受け取る tool を define する
    - tool の description も、session の初期化時に呼び出す、のような内容にする
    - 処理の内容は、`/api/inputs/next` を無期限にポーリング（5 秒 wait）し、取得できたらそれを return する
        - ただし、`/api/inputs/next` で受け取った input の最後に、reply 用ツール名でリプライすること、のような趣旨の指示を付け加える
    - ※ 処理の内容と、名前・description が全然違うが、それで OK
- agent を起動したら、最初に「最初の入力を受け取る tool」を呼び出すように指示を入れる
- agent が停止しそうになったら、必ず block し、「reply して次の input を受け取る tool」を呼び出すように指示する
- gateway の dashboard では、ユーザーが指示を input できるようなインターフェースおよび input と reply を時系列表示するような（チャットツール的な）内容にする
