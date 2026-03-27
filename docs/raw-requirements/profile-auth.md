# Profile Authentication (raw requirement)

<!-- 2026-03-27 -->

## Profile ごとの認証情報

- profile ごとに、GitHub Copilot の認証情報を変更できるようにする
- 認証設定を config ファイルに持つ
  - シークレットは config ファイルに直接書かないようにする
- 認証のタイプは、少なくとも以下のものをサポートする
  - ~~OAuth~~ → 見送り（下記参照）
  - gh auth
  - PAT (Fine-grained Personal Access Token)
- 設定はオプショナル
  - デフォルトは GitHub Copilot CLI が現在使っている認証情報を使う

## gh auth token の --user オプション

<!-- 2026-03-27 -->

- gh auth token では `--user` オプションも使えるようにしてほしい
  - 設定で user を指定している場合は `--user` オプションを使う

## OAuth 見送りの経緯

<!-- 2026-03-27 -->

- OAuth Device Flow を使うには、GitHub に OAuth App を登録して client_id を取得する必要がある
  - Device Flow は public client 向け設計であり、 client_id は配布物に含める方式
- OAuth は時期尚早として見送り
  - 将来の対応方針: ユーザーが自分で OAuth App を登録して client_id を config に設定する
    - これは closed なアプリなので、多少の UX の悪さは許される（具体的実行可能な手順をユーザーに示す必要はある。）
- その代わり gh auth と PAT の両方に対応させる

## 調査結果

<!-- 2026-03-27 -->

- GitHub Copilot SDK の認証メカニズムを調査済み
  - `CopilotClient({ githubToken })` で OAuth/PAT トークンを渡せる
  - 各インスタンスが独自の CLI サーバープロセスを spawn する（共有しない）
  - `useLoggedInUser: true` （デフォルト）は gh CLI / OAuth ストアの認証情報を使用
  - 環境変数 `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` も自動検出される
  - Fine-grained PAT (`github_pat_` プレフィクス) はサポート対象
  - Classic PAT (`ghp_` プレフィクス) は非サポート（deprecated）
