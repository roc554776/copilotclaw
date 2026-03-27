# Profile 機能の完成 (raw requirement)

<!-- 2026-03-27 -->

- profile 機能が不完全なので、profile を充実させる必要がある
  - 充実というか、本来必要な機能すらない
  - setup 等のコマンドにも profile の機能がないし、workspace ディレクトリも生成されていない
  - profile 別の動作がほぼまともに動いていないので、網羅的な改善が必要

<!-- 2026-03-27 -->

- profile ごとの state ディレクトリ分離について、 OpenClaw に合わせる
  - 現在: `~/.copilotclaw/workspace-{{profile}}`, `~/.copilotclaw/config-{{profile}}.json`（同じベースディレクトリ内で suffix で分離）
  - OpenClaw 方式: `~/.openclaw-{{profile}}/`（state ディレクトリ自体が別）
  - CopilotClaw も state ディレクトリ自体を分離する方式に変更する: `~/.copilotclaw-{{profile}}/`
