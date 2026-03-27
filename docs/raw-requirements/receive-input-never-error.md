# receive_input Never Error (raw requirement)

<!-- 2026-03-27 -->

## copilotclaw_receive_input は何があってもエラーを返さない

- copilotclaw_receive_input tool は何があってもエラーを返さないようにする
  - 理由: ここでエラーを返すと、agent の物理 session が停止してしまい、非常に非常に非常に危険であるため
- どういう理由があっても、エラーを返すのは NG
- もし何か問題があっても、エラーを返さずに、通常のタイムアウトと同じで、ただ、もう一度 copilotclaw_receive_input を即時呼び出すように指示を返す
  - どのような例外であっても、それをキャッチして、エラーを返さず、タイムアウト時と全く同様にレスポンスする
  - エラーが発生したことや、エラーの理由を response の中に含めてはいけない
    - ただし、システムとしてのログには必ず出す（通常のログは agent には直接知覚されない）
  - agent が、copilotclaw_receive_input でエラーが発生したことを知覚できてはいけない
  - 理由: agent がエラーを知覚してしまうと、デッドロックになる可能性があり、非常に非常に非常に危険であるため
