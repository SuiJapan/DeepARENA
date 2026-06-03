---
name: draft-commit-message
description: Draft a commit message from the current git diff using the repository's Japanese commit message format. Use when the user asks for a commit message, asks how to summarize the current diff for a commit, or wants a commit body before running git commit.
---

# draft-commit-message

現在の diff から、日本語のコミットメッセージを作る。

## 実行手順

1. `git status --short` で変更ファイルを確認する
2. `git diff --stat` と `git diff` で変更内容を確認する
3. `git log -5 --oneline` で最近のコミットメッセージの傾向を確認する
4. 以下のフォーマットでコミットメッセージを作成する
5. **実コミットはせず**、コードブロックだけを返す

## フォーマット

```text
type: タイトル

- `対象ファイル`
  - 変更内容1
  - 変更内容2
```

## Type

- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `chore`

## ルール

- 本文は日本語で具体的に書く
- `🤖 Generated with ...` のような署名を付けない
- `Co-Authored-By` を付けない
- 出力はコミットメッセージ本文のみ
