---
name: cleanup-gone-branches
description: Delete local branches whose upstream branches are gone, with an explicit confirmation step. Use when the user wants to clean local branches or remove stale gone branches.
---

# cleanup-gone-branches

リモートに存在しないローカルブランチを削除する。

## 実行手順

1. `git status --short --branch` を確認する
2. 安全なブランチへ移動する

```bash
git checkout dev 2>/dev/null || git checkout main 2>/dev/null || git checkout master
```

3. リモート情報を更新する

```bash
git fetch --prune
```

4. 削除候補を抽出する

```bash
git branch -vv | grep ': gone]' | awk '{print $1}' | sed 's/^[* ]*//' | grep -v -E '^(main|master|develop|dev)$'
```

5. 候補をユーザーへ提示し、削除前に必ず確認を取る
6. 承認後に削除する

```bash
git branch -vv | grep ': gone]' | awk '{print $1}' | sed 's/^[* ]*//' | grep -v -E '^(main|master|develop|dev)$' | grep . | xargs -I {} git branch -D {}
```

## 安全保護

以下は絶対に削除しない:

- `main`
- `master`
- `develop`
- `dev`
- 現在 checkout 中のブランチ
