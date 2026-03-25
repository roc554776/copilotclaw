# Gateway-Agent Status Display and Session Lifecycle (raw requirement)

## Gateway と Agent の状態表示

- dashboard で以下が確認できるようにしたい:
  - gateway の status
  - agent のバージョン
  - agent session の状態（starting / waiting / processing / stopped など）
- status バーをホバーまたはクリックしたら、gateway と agent の詳細ステータスを modal で表示する
- dashboard の画面更新はリアルタイムであること（chat もステータスも）
  - WebSocket 等のプッシュ型通信を使用する（現在の polling ではなく）
- agent session が processing のとき、chat UI 上でそれが分かるようにしたい
  - チャット UI でよくある「送信中...」のようなアニメーション付き表示を、processing 中に表示する

## 古い Agent の強制停止と再起動

- gateway が必要な最低バージョンより古い agent process が起動している場合に、gateway の起動オプションで強制的に古いものを停止させて新しいものを起動できるようにしたい
  - 例: `copilotclaw gateway start --force-agent-restart` のようなオプション

## Agent Session の意図しない停止への対応

- agent session が idle になったとき（LLM が tool を呼ばずに停止した場合）、session.send() による停止阻止はしない
  - （実装済み: session-loop.ts は idle 時に resolve するだけ）
- agent session は停止の status になる
- もし channel に紐づく agent session だった場合には、channel に意図せず agent session が停止したことを通知する
- この channel に新たに user がメッセージを送った場合には、channel に紐づくアクティブな agent session がないため、gateway は agent process に agent session の新規起動と channel への紐づけを要求する
