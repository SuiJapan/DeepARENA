---
name: code-review
description: Review local changes or a GitHub PR using the Codex standard /review command. Use when the user asks for a code review, PR review, regression check, or quality/security review.
---

# code-review

Codex 標準の `/review` コマンドを使って、ローカル変更または GitHub PR をレビューする。

## When To Use

- ユーザーがレビュー、PR レビュー、差分レビュー、回帰確認を求めている
- 実装後に品質・正しさ・セキュリティ・テスト不足を点検したい
- ローカル未コミット差分か、GitHub PR 番号/URL が対象

## Inputs

- 引数なし: ローカル未コミット差分をレビューする
- PR 番号 or PR URL: GitHub PR レビューとして扱う

## Review Mode

1. 対象を判定する
   ローカル差分があるなら local review、PR 番号/URL があれば PR review。
2. `/review` に渡す前提情報を集める
   ローカルなら `git status --short --branch` と `git diff --stat` を確認する。
   PR なら PR 番号、ベースブランチ、変更ファイル一覧を確認する。
3. Codex 標準の `/review` を実行する
   レビュー対象、ベースブランチ、検証済みコマンドを明示して渡す。
4. `/review` の結果をそのまま尊重する
   指摘は重要度順に整理し、ファイルと行番号がある場合は必ず含める。

## Validation Context

可能なら、その repo の標準コマンドを優先する。存在しないコマンドは発明しない。

優先順:

```bash
npm run check
npm run typecheck
npm test
npm run build
```

別の package manager を使う repo では、その repo の既存 script に合わせる。

全部を無理に走らせる必要はない。変更範囲に関係するものを優先し、実行できなかった検証は明示する。

## Output Format

findings を先に出す。各 finding は次を含める。

- Severity
- File + line
- 問題の内容
- なぜ問題か
- 必要なら短い修正方針

その後に短く:

- Open questions / assumptions
- Validation results
- Overall verdict

## Verdict Rule

- CRITICAL がある: block
- HIGH がある: request changes 相当
- MEDIUM/LOW のみ: comments
- finding なし: no findings と明示し、残るテストギャップがあれば添える

## Notes

- この skill は独自 rubric を定義しない
- レビュー判断は Codex 標準の `/review` に委ねる
- 現在の repo の制約や規約がある場合は、repo ルールを優先する
