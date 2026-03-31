# Channel Tool Redesign (raw requirement)

## コスト最小化の原則

- `client.send()` は session の開始時以外は使わない
- session keepalive のための `session.send()` も不要にする（tool 内で keepalive を完結させる）

## ツール構成の統廃合

### 現行ツール（廃止）

- `copilotclaw_receive_first_input`
- `copilotclaw_reply_and_receive_input`

### 新ツール構成

- channel にメッセージを送る tool
  - 即時 return する（ポーリングしない）
- input を取得する tool
  - 現在の `copilotclaw_receive_first_input` と同じポーリング処理
  - keepalive timeout つき
- 指定 channel の過去のメッセージを list 取得する tool
  - デフォルトは limit 5 で最新のものから時刻降順で取得
  - sender が user なのか agent なのかもわかるようにする

## 作業中の状況報告

- agent が作業を継続しつつ、途中経過を chat UI に送信できるようにしたい
- 現在の方式（reply と次の input 取得が一体）ではこれができない
- メッセージ送信 tool を即時 return にすることで、作業の途中報告が可能になる

<!-- 2026-03-28 -->
## copilotclaw_receive_input の copilotclaw_wait への rename

- copilotclaw_receive_input を copilotclaw_wait に rename する
  - 理由: これは、入力を受け取るためだけの tool ではなく、例えば subagent を呼び出したあと、自分自身がやることがなくなって、それを待つ状態になった場合にも即時実行する必要があるから
- channel-operator に対して、以下のシステムプロンプトを与えること（現在の内容に、整合性を加味してマージすること）:
  - 直近、一時的にでも自分のやることがなくなったときには必ず `copilotclaw_wait` tool を使う必要がある
  - `copilotclaw_wait` tool を使わずに自分のターンを終了させてしまうと、非常に非常に非常に危険。デッドロックになり、セッションが停止してしまう
  - `copilotclaw_wait` tool の利用シーン例:
    - 会話のターンをユーザーに渡すとき、ユーザーの回答を待つとき
    - subagent を呼び出したあと、自分自身がやることがなくなって、それを待つ状態になったとき
    - 全ての作業を完遂したとき
    - それ以外、何をすればいいか分からないとき
    - 自分自身の身を危うくする、想定しないシステム的な異常事態に陥ったとき

## 作業中表示

- chat UI 上で、agent が作業中であることをユーザーに見えるようにしたい
- 次の入力を待って待機している間以外は、作業中であることを表示する

## 作業中の割り込み

- 作業中でも、ユーザーからの入力に適宜対応できるようにしたい
- 完璧でなくてよい

## channel と agent session の紐づけルール

- channel には最大 1 つの agent session が紐づく
- channel に未処理のユーザー input があるが agent session がない場合、agent session が開始され channel と紐づく
- channel のユーザー input が全て処理されても agent session は終了せずに生かし続ける（agent session は高価なので壊さない）
- agent session には最大 1 つの channel が紐づく
- channel に紐づかない agent session も存在しうる（まだ実装はないが）

## assistant.message のタイムライン反映

<!-- 2026-03-26 -->
- channel に紐づいている agent session の `assistant.message` イベントで送られたメッセージを、channel のタイムラインに sender が agent のメッセージとして表示させる
- 理由: `assistant.message` で送出されるメッセージは、本来は agent が channel に送出したいメッセージであるはずだから
  - 本来は `copilotclaw_*` tool で送ってほしいんだけど、上手くいかないこともあるので

<!-- 2026-03-31 -->
- assistant.message の直接チャンネル反映が agent 側にある wrong-side ロジックの修正。agent の physical-session-manager.ts にある assistant.message イベントハンドラが、gateway 接続中にも関わらず agent 側で直接 channel_message を送信している。gateway は既に session_event として assistant.message を受信しているので、gateway 側の onSessionEvent で処理すべき。agent からこのコードを削除する。

## post tool use hook による新着通知

- channel に紐づく agent session では、任意の tool を呼び出した後に SDK の `onPostToolUse` hook を発火させる
- hook 処理:
  - 当該 channel に未読の user message があるか確認
  - もしあれば `additionalContext` に以下を追加:
    - 未読の user message があること
    - input 取得 tool で即時確認すべきであること
- channel に紐づく agent session を起動する際、「tool の response の additionalContext で新着通知がされる可能性があること」を起動時のプロンプトで伝える
