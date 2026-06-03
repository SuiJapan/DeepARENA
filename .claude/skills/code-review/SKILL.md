---
name: code-review
description: Review local changes or a GitHub PR using the Everything Claude Code review rubric. Use when the user asks for a code review, PR review, regression check, or quality/security review and wants findings prioritized by severity.
---

# code-review

Everything Claude Code の `code-review` command と `code-reviewer` agent に合わせた、Claude Code 用のレビュー skill。

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
2. まず差分一覧を集める
   ローカルなら `git diff --name-only HEAD`、PR なら changed files と diff を取得する。
3. 変更ファイルを全文で読む
   diff hunk だけで済ませず、周辺コードと呼び出し元も確認する。
4. プロジェクト規約を読む
   `AGENTS.md`、`CLAUDE.md`、関連 docs を優先し、レビュー基準に反映する。
5. 必要なら検証する
   利用可能な lint/typecheck/test/build を走らせ、結果をレビューに含める。
6. findings-first で報告する
   重要度順に列挙し、確度の高い問題だけを出す。

## Confidence Filter

- 80% 以上の確度がある問題だけ報告する
- 単なる好みや一般論は避ける
- 変更されていないコードは、重大なセキュリティ問題でない限り主対象にしない
- 同種の問題はまとめる

## Review Checklist

### CRITICAL

- ハードコードされた secret、token、credential
- SQL injection、command injection、path traversal
- XSS、CSRF、auth bypass
- 機密情報のログ出力
- データ破壊や漏洩につながる欠陥

### HIGH

- 明確なバグ、回帰、ロジック不整合
- null/undefined や境界条件の取りこぼし
- エラーハンドリング欠落
- 新しい分岐や主要処理に対するテスト不足
- 深すぎるネスト、大きすぎる関数、死んだコード、`console.log`
- フレームワーク規約違反
  React/Next.js なら hooks dependency、client/server boundary、stale closure、list key
  Backend なら入力検証不足、N+1 query、timeout 欠落、無制限 query

### MEDIUM

- パフォーマンス懸念
- 保守性低下
- 命名や責務分離の弱さ
- TODO/FIXME の放置

### LOW

- 軽微なスタイル問題
- 任意の改善提案

## Validation

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

- Everything Claude Code の review 方針に合わせ、レビューは findings-first で行う
- PR review の場合も inline comment より先に、まず全体の findings を整理する
- 現在の repo の制約や規約が ECC の一般論と衝突する場合は、repo ルールを優先する
