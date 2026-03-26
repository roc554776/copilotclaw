# Testing (raw requirement)

- このリポジトリでは自動テストが必要
  - 実装には常に自動テストがセットでなければいけない
  - 実装だけで自動テストがない PR は許されない
    - 例外的に後続機能を待つなどで pending する場合は、skip の状態で実装するなど
- unit / integration / E2E の各レイヤーが必要
- unit は依存ほぼなし、integration は DB に依存するとかそんなイメージ、E2E は実際にサーバーを立てる
- 重要な注意: E2E だとしても、GitHub Copilot だけは mock を使うようにする
  - 理由: GitHub Copilot は基本的には認証情報を必要とするし、実際の通信の乱発で BAN される危険もある。自動テストで使うべきではない
- フロントエンドの E2E は、playwright を使う
- E2E でサーバー等を起動する場合は、E2E 専用ビルドディレクトリ、E2E 専用ポート、E2E 専用 DB などなど、分離する
  - 理由: そうしないと自動テストが安定しない

<!-- 2026-03-26 -->
## Dashboard フロントエンド技術の移行

- 将来的に dashboard のフロントエンドを vite + React に移行する
  - 理由: 開発当初は server-side HTML テンプレート + inline JS で十分だったが、状況が変わって手法の割に複雑なことをやりすぎている
  - テンプレートリテラル内にクライアント JS を書き、その中で HTML 文字列を組み立てる方式は限界に達している（クォートの入れ子問題、inline JS の構文エラーがテストで検出できない等）
  - vite + React に移行することで:
    - コンポーネントごとの型安全な JSX
    - React Testing Library によるコンポーネントテスト（Playwright なしでもモーダル内 JS をテスト可能）
    - SSE / fetch の状態管理を hooks で整理
