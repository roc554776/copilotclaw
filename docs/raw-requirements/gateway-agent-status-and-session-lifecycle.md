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

## 物理セッションの意図しない停止への対応

- 物理セッションが idle になったとき（LLM が tool を呼ばずに停止した場合）、session.send() による停止阻止はしない
  - （実装済み: session-loop.ts は idle 時に resolve するだけ）
- 物理セッションは停止し、抽象セッションは suspended 状態に遷移する（チャンネルへの紐づけは維持される）
- もし channel に紐づく抽象セッションだった場合には、channel に物理セッションが意図せず停止したことを通知する
- この channel に新たに user がメッセージを送った場合には、既存の抽象セッションを revive し、新しい物理セッションを作成する
  - `copilotSessionId` が保存されていれば `resumeSession` を試みる（前回の会話記憶を保持するため）
  - `resumeSession` が失敗した場合は `copilotSessionId` をクリアして `createSession` で新しい物理セッションを作成する

<!-- 2026-03-30 -->
## トークン消費指数と消費量の閲覧

- トークン消費指数とは以下の値です。
  - SUM {models} (MAX(モデルのプレミアムリクエスト乗数, 0.1) * トークン消費量)
- トークン消費指数もモデルごとのトークン消費量も、期間を指定すると決まる値なので、それぞれ厳密には期間を引数とする関数です。
- トークンの消費量をデータとして残し、API で取得できるようにしてあるはずですが、それを閲覧する UI も必要です。
  - 直近 5h のトークン消費指数
  - 直近 5h のモデルごとのトークン消費量
  - 期間ごとのトークン消費指数
  - モデルごと、期間ごとのトークン消費量

<!-- 2026-04-01 -->
- 消費トークンだけでなく、プレミアムリクエスト乗数も一緒に保存する
- API で時系列データを出せるようにする
  - 期間とタイムインスタンス数を指定して、時系列を得られるようにする
  - モデル別
  - 指数
  - 移動平均（時間幅指定可能）
- 時系列データをグラフで出せるような UI を新規ページに作る

これは要望ではなく開発hint
グラフには https://github.com/recharts/recharts 等を使うこともできそう。
