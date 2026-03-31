# Agent Session (raw requirement)

- いまは channel に copilot の session (agent session) が直接対応する方式だが、この関係性を切り離し、agent session は単体で管理する
  - agent session という概念を明確に導入する
  - agent process は agent session を管理する責務を負う
  - channel には agent session が必要に応じて紐づく
  - 将来的に channel に紐づかない agent session も考えられる
- agent session はコストが高い（プレミアムリクエスト消費）。以下の原則に従う:
  - 無駄に起動しない: channel が存在しても、agent にまだ読まれていない user message がなければ新規起動は不要
  - 起動した session はできるだけ長く使い続ける: 未読 user message がない状態が続いているという理由で既存の agent session を終了させてはいけない
- agent session を保つための基本方針
  - `copilotclaw_*` tool で input を待たせておく
  - タイムアウトしそうになったら、一旦 input なしで返し、即時 `copilotclaw_*` tool を実行するように強く指示する
  - これを繰り返すことで、セッションを生かし続ける

<!-- 2026-03-26 -->
## 抽象 session と物理 session の分離

- agent session には agent process の意味での session（抽象 session）と、Copilot 側の物理的な session の両方がある
  - この抽象的な session と物理的な session の関係をもう少し綺麗に整理したい
- agent session に直接対応する（つまり、subagent でない）Copilot 側の物理的な session が意図せず停止してしまった場合、抽象的な agent session はそのまま残し、物理的な session が存在しない状態に遷移させるのが自然
- そして、次に何かしらのトリガーで、物理的な session が実際に必要になったときには、抽象的な agent session はそのままにして、物理的な session を新たに作成して紐づけるのが自然
- これにより、channel と agent session の紐づけが基本的には恒久的になり、扱いやすくなるはず
- agent restart しても、channel と agent session の紐づけは維持されることになる

## 物理 session 停止後の記憶の保持

- channel に直接紐づく agent session について、物理的な session が停止した場合も、再開時に記憶がある程度は保てるようにしてほしい
  - 物理的な session を保存しておいて resume するか、起動時に、直近の会話履歴やログなどを渡すかなどの方法がありそう

<!-- 2026-03-26 -->
## Agent Session の作業ディレクトリ

- agent session を起動するときの cwd（workingDirectory）は、当該 profile の workspace ディレクトリにすべき
  - SDK の `SessionConfig.workingDirectory` で指定できる
  - 現状は未指定で、agent process の cwd がそのまま使われている（意図しない動作）
  - profile ごとに workspace が分離される設計に合わせて、session の作業ディレクトリも profile workspace に揃える

<!-- 2026-03-31 -->
## session.idle での subagent 停止時の処理分離

- session.idle について、 subagent が完全に停止したときにくる session.idle で、処理が壊れないようにしてください。
  - session.idle が、 abstract session に直接紐づく agent のものなのか、 subagent のものなのかで、処理を分けるようにしてください。
    - backgroundTasks が null でないときは、それは subagent が停止しただけのようです。
    - また wait_tool がまだ complete していない、ということもヒントになるかもしれません。

<!-- 2026-03-31 -->
## physical session の常時保持と連続 turn 列の概念

- chat 履歴があって、かつ current physical session がない状態って、作らないでほしい。
  - 一番最後に使った physical session を使い続けてるはずだから。
  - status 表示や cron の設定で表示されてくれないと使いづらい。
- セッションの子として、さらに、連続した turn 列のような概念を用意するべき（これがプレミアムリクエスト 1 回に対応する）
  - プレミアムリクエストを消費するのって physical session 単位ではなく、それより小さい、 idle になるまでの期間単位で、言い変えると turn の連番が終わるまでです。（subagent でない agent の session.idle が来ると、そこで turn の連番がリセットされる。）
  - 連続した turn 列のような概念に適切に呼びやすく、内容とも一致している名前をつけて、概念として明確化すべきです。
  - 「連続した turn 列のような概念」が 1 度停止したら、次に開始するときにはプレミアムリクエストが消費されることになるわけです。
    - このときにモデルを切り替えたりできるというわけ。
    - よって、いまの「連続した turn 列のような概念」が 1 度停止したら、次に開始するときには設定値を反映してモデルを切り替えるべきです。
    - なお、いまの channel に紐づく physical session を archive する機能に加えて、単にいまの「連続した turn 列のような概念」強制停止させる機能もほしいです。（これをすると、次の会話から、設定したモデルが適用される。）

<!-- 2026-03-31 -->
## status の細分化

- status が雑すぎる。もっと細かくすべき。
  - 初めてなので abstract session に physical session が 1 つも紐づいていない状態や、過去の physical session はあるけど、現在は idle になっている状態などを適切に区別して表示するべきです。
  - また、 wait tool で待っている状態と、 「連続した turn 列のような概念」 が途切れて idle になっている状態も適切に区別して表示するべきです。
  - さらに、 wait で待っていたけど、新規の message が入ってきて、これから wait が解かれるまでの間も、適切に status を分けるべきだと思います。
    - これをすることで、より反応性の高い UI を作れます。
