---
name: process-requirements
description: raw requirements を受け取って整理し、ドキュメントに反映する。raw requirements を与えられたとき、仕様を確認するとき、正しい挙動を理解するときに使う
argument-hint: "[要望のテキスト]"
---

human から受け取った要望を、以下の3層のドキュメントに整理・反映する。

## ドキュメント階層

- **raw-requirements** (`docs/raw-requirements/`): human 原文をそのまま記録する。タイムスタンプ（`<!-- YYYY-MM-DD -->`）を付与する
- **requirements** (`docs/requirements/`): raw-requirements を整理した要求。要件定義ではない。要望の意図を損なわず、構造化して記述する
- **proposal** (`docs/proposals/`): 要件定義。具体的な設計・実装方針を記述する

## 処理手順

### Step: 既存ドキュメントの確認

既存の関連する raw-requirements / requirements / proposal を確認する。直接同じ内容でなくとも、設計上関連する内容があり、要望の実現に影響する可能性がある。

### Step: 関連する実装の確認

ドキュメントと実装が一致していると盲信してはいけない。ドキュメントに現れない実装詳細もある。コードを読んで現状を把握する。

### Step: 内容の整理

- 抽象セッションと物理セッションなど、プロジェクト固有の概念を正確に区別して記述する
- 未実現の要望には明確にマーカーを付ける（例: `（未実現）`）
- 既存の要望と矛盾する場合は、新しい要望が優先される。古い記述を更新する

### Step: ドキュメントへの反映

- raw-requirements: human 原文を適切なファイルに追記する。新規テーマなら新規ファイルを作成する
- requirements: 整理した要求を適切なファイルに追記・更新する
- proposal: 要件定義を適切なファイルに追記・更新する
- proposals/status.md: 未実現セクションに追加する

## 注意事項

- requirements は要件定義ではない。要望を整理したもの
- proposal が要件定義
- 文書中で抽象セッションと物理セッションを明確に分けて記述すること
- 実装の修正はこの skill では行わない。ドキュメントの整理のみ

## 要望

$ARGUMENTS
