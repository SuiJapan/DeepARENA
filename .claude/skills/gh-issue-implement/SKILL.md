---
name: gh-issue-implement
description: Implement a GitHub issue end to end in this repository using only Claude Code. The orchestrator owns planning, plan review, implementation, verification, and PR creation via sub-agents. Use when the user gives a GitHub issue URL or asks to implement, fix, or work on a GitHub issue.
---

# gh-issue-implement

GitHub issue を **Claude Code だけで完結**させる repo-local workflow。

## 役割分担

- Claude Code（オーケストレーター）:
  - issue 取得
  - 実装計画の立案
  - 計画監査
  - 実装、テスト、コミット、push、PR 作成、worktree cleanup
  - 最終レビュー

オーケストレーターは、計画・実装・レビューを専用のサブエージェントへ委譲する。サブエージェントは Agent tool の `subagent_type` で起動する。

## 関連サーフェス

- subagents（`.claude/agents/` に定義）:
  - `issue-planner`
  - `plan-reviewer`
  - `issue-step-worker`
  - `verification-reviewer`（fresh context の PR 前ゲートレビュー）
- worktree 操作:
  - Claude Code の `EnterWorktree` / `ExitWorktree`、または `git worktree add` / `git worktree remove`
- references:
  - `references/step-design.md`
  - `references/workflow-checklist.md`
- supporting skills:
  - `prepare-issue`
  - `draft-commit-message`
  - `prepare-pr`

## 前提

- `gh` CLI が認証済み
- root `AGENTS.md` の repository instructions を守る

## 計画書の文体方針

この方針は issue に書き込む「実装計画」に適用する。PR 本文は `prepare-pr` の規約に従う。

- 読み手は「実装に関わらないチームメンバーや他部署の大人」を想定する
- 基準は **中学生でも読み通せるレベル** にする
- 専門用語を使う場合は、初見で伝わりにくい語に短い補足か日常の比喩を添える
- 1 文は原則 60 文字以内を目安にし、能動態で主語をはっきりさせる
- 目的、変更点、影響範囲の順で書く
- 箇条書きは 1 項目 1 事実に分ける
- 絵文字や過剰な装飾は使わない
- 比喩は必要なときだけ使い、説明を飾りすぎない

## 実行契約

入力:

- GitHub issue URL
- または `owner/repo` と issue 番号

フロー:

1. オーケストレーターが issue を取得
2. 前提 issue がある場合は完了状態を確認する
3. `issue-planner` サブエージェントで phase / step 計画を固める
4. `plan-reviewer` サブエージェントが別コンテキストで計画監査する
5. blocking 指摘を反映後、ユーザー承認を 1 回だけ取る
6. 承認済み計画を issue 本文へ追記する
7. worktree を作り、`issue-step-worker` サブエージェントで step 単位に実装する
8. 各 step は完了直後に **その step 専用の 1 commit** を作る
9. ローカル検証を実行
10. fresh context の `verification-reviewer` サブエージェントに PR 前ゲートレビューを実行させる
11. 指摘事項を修正し、指摘がなくなるまでレビューと再検証を繰り返す
12. `prepare-pr` の規約で PR を作成する
13. worktree と作業ブランチを cleanup する
14. cleanup 完了を確認してからユーザーへ完了報告する

## Preflight

実装前に必ず確認する:

```bash
gh --version
gh auth status -h github.com
git status --short --branch
```

`gh` が使えない、または認証されていない場合は続行しない。

## Phase 0: Issue 取得

issue 情報は GitHub app か `gh` CLI で取得する。CLI を使う場合:

```bash
gh issue view <number> --repo <owner>/<repo> --json title,body,labels,assignees,url
```

取得後に短く整理する:

- 目的
- 期待する動き
- 完了条件
- 影響範囲
- 依存関係
- スコープ外
- 再現手順（修正 issue の場合）
- 不明点

issue 本文が `prepare-issue` または `.github/ISSUE_TEMPLATE` の構成で作られている場合は、その見出しを優先して要件を読む。特に `一言でいうと`、`なぜ必要か`、`期待する動き`、`完了条件`、`依存関係`、`影響範囲`、`実装メモ` を計画の入力として扱う。

### 事前準備: `references_path` の算出

スキル起動時のベースディレクトリを基に、`<skill-dir>/references/step-design.md` を `references_path` として保持する。

以降の計画立案と実装では、この絶対パスを `issue-planner` / `issue-step-worker` へ渡して共通フォーマットの基準にする。

## Phase 0.5: 依存 issue の完了確認

issue 本文に `依存関係`、`前提issue`、`依存するissue`、`blocked by`、`depends on` の見出しや記述がある場合は、計画立案や worktree 作成の前に必ず確認する。

確認ルール:

- `前提issue` に書かれた `#123`、`owner/repo#123`、GitHub issue URL を抽出する
- 同じ repo の `#123` は `gh issue view 123 --json state,title,url,closedAt` で確認する
- 他 repo の `owner/repo#123` は `gh issue view 123 --repo owner/repo --json state,title,url,closedAt` で確認する
- 前提 issue は `state` が `CLOSED` の場合だけ完了扱いにする
- 前提 issue が `OPEN`、取得不能、不明、または issue 番号未確定の場合は実装しない
- 未完了または確認不能な前提 issue がある場合は、ユーザーに状況を報告して判断を尋ねる

未完了時の停止メッセージには次を含める:

- 現在実装しようとしている issue
- 未完了または確認不能な前提 issue の一覧
- 各 issue の `state`、title、URL
- 実装を止めた理由
- ユーザーに確認したい判断

ユーザーが明示的に「未完了でも進める」と指示した場合だけ続行してよい。その場合でも、計画本文と PR 本文に前提未完了のまま進めたことを明記する。

## Phase 1: 計画立案

計画は **phase -> step** の 2 層で作る。詳細な判断基準と issue へ書き戻す計画書フォーマットは `references/step-design.md` を使う。

要件:

- TDD 前提で分割する
- フェーズ数は最大 3
- 各 step に完了条件を付ける
- ローカル検証の範囲を明記する
- PR-ready の判定条件を含める

`issue-planner` サブエージェントへ渡す入力:

- issue URL
- issue タイトル
- issue 本文
- `references_path`
- この SKILL.md の「計画書の文体方針」

計画は一時ファイルに書き出し、`plan-reviewer` サブエージェントへ渡す。

計画監査ルール:

- `plan-reviewer` は read-only の fresh context で計画だけを **1 回** レビューする
- 返却カテゴリは `blocking` と `advice` の 2 つに絞る
- `blocking` があればオーケストレーターが計画へ反映する
- 反映後は原則として再監査しない
- phase 構成、step 分割、検証方針が大きく変わった場合のみ、例外として **1 回だけ** 再監査してよい
- `advice` は必要なものだけ計画本文か実装メモへ反映する

## Phase 2: ユーザー承認

オーケストレーターは計画監査結果を 2 から 4 行に圧縮して添え、ユーザーに **1 回だけ** 承認を求める。

修正要望があれば、`issue-planner` を再実行して計画を更新する。

## Phase 3: issue への計画書き込み

承認後、計画を issue 本文に追記する。

```bash
gh issue edit <number> --repo <owner>/<repo> --body "<original_body>

---

## 実装計画

<plan_content>"
```

追記する計画本文は `references/step-design.md` の issue 計画フォーマットに準拠させる。

## Phase 4: Worktree 作成

実装は専用の worktree で行う。元の作業ツリーは触らない。

- Claude Code の `EnterWorktree` で worktree に入る（第一候補）
- または `git worktree add` で `main` を基点に作業ブランチ用の worktree を作る:

```bash
git worktree add <path> -b feature/issue-<issue-number>-<slug> main
```

作成された worktree で実装する。依存が未インストールなら、その worktree で必要な package manager install を行う。

## Phase 5: 実装

実装は **フェーズ -> step** の順で進める。フェーズ数が複数ある場合は、各フェーズが意味のある塊になっていることを保つ。

各 step では `issue-step-worker` サブエージェントに次を渡す:

- step 番号
- step タイトル
- step 目標
- step 完了条件
- 所属フェーズ番号・タイトル
- 計画全体
- `references_path`

各 step で行うこと:

1. 失敗するテストを追加または更新
2. 失敗を確認
3. 最小実装で通す
4. リファクタしてテスト再実行
5. step 完了条件を満たしたことを確認
6. その step の変更だけを commit して worktree を clean に戻す

step 完了の定義:

- **1 step = 1 commit**。例外なく守る
- 次の step に進む前に `git status --short` が空であることを確認する
- 複数 step の変更をまとめて 1 commit にしてはならない
- step の変更が独立して commit できない計画は粒度が大きすぎるため、計画を分割し直す
- **すべての commit message は `draft-commit-message` スキルを必ず使って作る**
- オーケストレーターやサブエージェントが commit message を手書きしてはならない

コミットメッセージは `draft-commit-message` の規約に従う。

各 step 完了時には、フェーズ番号と step 番号が分かる形で進捗を短く共有する。自動 checkpoint は増やさない。

## Phase 6: ローカル検証

変更に応じて対象 workspace を特定し、利用可能な script を実行する。Node workspace では少なくとも次を優先する:

```bash
npm run check
npm run typecheck
npm test
```

変更が広い場合や runtime/build 影響がある場合は `npm run build` まで実行する。

## Phase 7: 最終レビュー

ローカル検証後、fresh context の `verification-reviewer` サブエージェントを起動し、**PR 前ゲートレビュー** を行わせる。`verification-reviewer` は `code-review` スキルの rubric（severity 分類・confidence filter・findings-first）に従う。

レビューは PR 方式で、実装ブランチと `main` を比較する形で行う。作業ツリー差分だけを対象にしてはならない。

`verification-reviewer` サブエージェントへ渡す context には少なくとも次を含める:

- issue 要約
- 実装サマリー
- ローカル検証結果
- 変更ファイル一覧
- current branch name
- base branch は `main`
- `git diff --stat main...HEAD`

最終レビューのルール:

- レビュー結果を PR 前ゲートとして扱う
- 指摘事項は severity に関係なく、解消するまで修正する
- 修正後は影響範囲のローカル検証をやり直す
- 指摘事項が 0 件になるまで、fresh context の `verification-reviewer` サブエージェントで再レビューする
- 指摘事項が解消できない場合は PR を作らず停止する

## Phase 8: PR 作成

最終レビューが通ったらオーケストレーターが PR を作成する。

- push はオーケストレーターが行う
- PR の宛先ブランチは常に `main` にする
- PR タイトルと本文は `prepare-pr` を必ず使用して作成する
- issue を必ず関連付ける
- テスト結果を本文に含める
- PR 作成だけでは完了扱いにしない

## Phase 9: Worktree cleanup と完了報告

PR 作成後は、ユーザーへ完了報告する前に worktree を必ず片付ける。

cleanup 手順:

```bash
# EnterWorktree で入った場合は ExitWorktree（action: remove）で閉じる
# git worktree add で作った場合は push 後に削除する
git worktree remove <path>
git worktree list
git branch --list "feature/issue-<issue-number>-<slug>"
```

ルール:

- 対象 worktree を削除する（`ExitWorktree` または `git worktree remove`）
- `git worktree list` で対象 worktree が消えたことを確認する
- `git branch --list` で対応する作業ブランチが残っていないことを確認する（PR 用にリモートへ push したブランチは残してよい）
- cleanup 完了後にのみ、PR URL を含む完了報告を行う
- cleanup が終わる前に「完了」「終わった」などの最終報告をしてはならない

cleanup で詰まりやすい例:

- worktree 内に未コミット変更や未追跡ファイルが残っている
- 別シェルや別プロセスがその worktree を使っている
- 対応ブランチを別 worktree が参照している
- `.git/worktrees/...` の管理情報が壊れている

## 停止条件

以下は即時停止する:

- `gh` 認証失敗
- 必須のローカル check が失敗し、解消できない
- `plan-reviewer` の `blocking` 指摘が未解消
- `verification-reviewer` の指摘事項が未解消
- PR 作成後の worktree cleanup が完了しない

## 重要事項

- `plan-reviewer` は read-only で使う
- 計画監査は fresh context のサブエージェントで実行する
- 最終レビューは **必ず fresh context の `verification-reviewer` サブエージェントに実行させる**
- レビューは PR 方式で、実装ブランチと `main` を比較する
- レビューは指摘事項が 0 件になるまで繰り返す
- 既存の未関連変更は巻き戻さない
- `issue-planner` / `plan-reviewer` / `issue-step-worker` / `verification-reviewer` の役割をまたいで責務を混ぜない
- オーケストレーターは複数 step の変更を溜めてからまとめて commit してはならない
- 各 step の終了条件には「専用 commit が 1 つ作られ、worktree が clean」が含まれる
- step commit、review 対応 commit、finalizer commit を含む **すべての commit** で `draft-commit-message` を先に使う
- issue 本文へ計画を書き戻してから worktree に入る
- PR 作成前に worktree と元の作業ツリーの状態を混同しない
- PR 作成後の worktree cleanup は省略不可
- cleanup 完了確認前にユーザーへ最終完了報告をしてはならない
