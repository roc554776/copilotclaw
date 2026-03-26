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

<!-- 2026-03-26 -->
## Copilot 物理セッションの状態可視化

- api やダッシュボードで、Copilot 側の session の生の状態を見られるようにしたい
  - agent process 上の概念としての session と、Copilot 側の物理的な session の両方の状態を見られるようにしたい
  - Copilot 側の物理的な session の中で subagent が呼び出された場合、その subagent の session も見られるようにしたい
  - 構造: agent session → 物理 session → subagent の物理 session（0〜複数個）
- ダッシュボードのモーダルで、サマリーを表示し、さらにクリックで詳細も見られるようにしたい
  - ステータスバーには表示しなくて OK
- サマリー表示項目:
  - 現在の GitHub 認証でのプレミアムリクエスト残量/上限
    - 従量課金制の料金体系になった場合には、消費総量等を取得して表示したい
  - 利用可能なモデルとプレミアムリクエスト乗数
  - 物理 session のプロパティ（サマリー）:
    - session id
    - model
    - コンテキストのトークン数
      - コンテキストのトークン数 / 最大トークン数 % , compact 閾値 %
      - （可能なら、これまでトータルで消費したトークン数）
    - 開始時刻（+ 経過時間）
    - 現在の状態（idle, xxx tool の呼び出し中, など）
- 物理 session の詳細（個別選択して詳細表示するときのみ）:
  - （サマリーに加えて）
  - 現在のコンテキスト（システムプロンプト + ユーザープロンプト）

## 古い Agent の強制停止と再起動

- gateway が必要な最低バージョンより古い agent process が起動している場合に、gateway の起動オプションで強制的に古いものを停止させて新しいものを起動できるようにしたい
  - 例: `copilotclaw gateway start --force-agent-restart` のようなオプション

## Agent Session の意図しない停止への対応

- agent session が idle になったとき（LLM が tool を呼ばずに停止した場合）、session.send() による停止阻止はしない
  - （実装済み: session-loop.ts は idle 時に resolve するだけ）
- agent session は停止の status になる
- もし channel に紐づく agent session だった場合には、channel に意図せず agent session が停止したことを通知する
- この channel に新たに user がメッセージを送った場合には、channel に紐づくアクティブな agent session がないため、gateway は agent process に agent session の新規起動と channel への紐づけを要求する
