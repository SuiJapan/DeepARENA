# Workflow Checklist

Use this checklist while running `gh-issue-implement`.

1. Preflight:
   - `gh auth status`
   - repo root and worktree status
2. Plan:
   - phase and step split
   - references/step-design.md format
   - acceptance criteria
   - verification plan
3. Codex plan audit:
   - single pass by default
   - zero unresolved blocking items
   - rerun only if plan structure changed materially
4. User approval:
   - exactly one approval gate before implementation
5. Issue update:
   - approved plan appended to issue body
6. Implementation:
   - TDD per step
   - progress reported with phase/step context
   - bounded edits per step
   - each step ends with exactly one dedicated commit
   - worktree is clean before the next step starts
   - every commit message is generated via `draft-commit-message`
7. Local verification:
   - available `check`
   - available `typecheck`
   - available `test`
   - available `build` when needed
8. Codex `/review`:
   - a clean-context subagent runs the default Codex CLI `/review` command
   - `/review` uses PR-style comparison: implementation branch against `main`
   - review context includes issue summary, implementation summary, validation results, changed files, current branch, base branch, and `git diff --stat main...HEAD`
   - unresolved findings stop PR creation
   - local verification is rerun after review fixes
   - `/review` is repeated in a clean-context subagent until there are no findings
9. PR:
   - issue link
   - test results
   - concise summary
10. Cleanup and final report:
   - `git -C <worktree-path> status --short` was empty before cleanup
   - `git worktree remove <worktree-path>` was executed after PR creation
   - `git branch -d feature/issue-<issue-number>-<slug>` was executed for the local branch
   - target worktree no longer appears in `git worktree list`
   - target feature branch no longer appears in `git branch --list`
   - remote branch was left in place for the PR
   - final user report was sent only after cleanup completed
