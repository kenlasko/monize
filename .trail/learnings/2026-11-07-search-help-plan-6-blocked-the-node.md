---
title: "search_help (plan 6) blocked: the scorer from #2050 is not on main"
author: Node
date: 2026-11-07
branch: claude/issue-2056
cost: { minutes: 1, tokens: 49038 }
touches:
  - backend/src/help/help.service.ts
---

## Decided
- Stopped before writing code on #2056 and asked whether to wait for #2050 or stack on it. `HelpService.getLlmHelp` is a thin layer over plan 3's `HelpService.search` and `backend/src/help/help-search.ts`. Both exist only on `origin/claude/issue-2050`, which was not merged as of `main` at 6cdb5f877.

## Tried and ruled out
- Stacking on #2050 without asking: the PR would carry #2050's 58 files until it merges, and its later review commits would conflict with the stacked copy.
- Writing a scorer of my own: it duplicates #2050.

## Watch out
- Before starting plan 6, check `git merge-base --is-ancestor origin/claude/issue-2050 HEAD`, or grep for `search(` in `backend/src/help/help.service.ts`.
- Plan 4 piece C (#2051) is not merged either: `isGuideUrl` is absent from `frontend/src`. Citations stay plain monize.net links and the PR says so.
