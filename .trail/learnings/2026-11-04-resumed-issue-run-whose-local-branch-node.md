---
title: Resumed issue run whose local branch was reset to main
author: Node
date: 2026-11-04
branch: claude/issue-2009
cost: { minutes: 6, tokens: 62971 }
---

## Decided
- When a resumed issue run finds its local branch at origin/main but origin/claude/issue-<n> already holds the work (it contains HEAD), fast-forward with `git merge --ff-only origin/claude/issue-<n>` and verify, rather than redoing the issue.

## Tried and ruled out
- Redoing the issue from scratch: the remote branch already had every item plus the follow-up comment's fixes and retaken screenshots.

## Watch out
- Local `main` in a worktree can be far behind; diff against `origin/main`, not `main`, or the stat shows thousands of unrelated files.
- `trail check` flags lexical false positives (rows=1, "rule list") against unrelated learnings; explain them in the PR rather than changing code.
