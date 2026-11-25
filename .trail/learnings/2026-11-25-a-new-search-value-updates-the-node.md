---
title: A new search value updates the website search docs in the same PR (issue 2393 review)
author: Node
date: 2026-11-25
branch: claude/issue-2393
cost: { minutes: 2, tokens: 13603 }
touches:
  - website/docs/importing-from-microsoft-money.html
  - website/docs/importing-from-microsoft-money.md
  - website/docs/search-index.json
  - website/docs/transactions.html
  - website/docs/transactions.md
  - backend/test/integration/transaction-search.integration.spec.ts
---

## Decided
- Reversing the earlier 2393 learning: the website "Search Syntax" table in `website/docs/transactions.md` lists the `is:` values, so a new value goes there in the same PR, and the "how to find these rows" steps in `website/docs/importing-from-microsoft-money.md` switch to `is:provisional` now. Only text describing the PENDING IMPORT note itself (e.g. `currency-management.md`) waits for B4.
- Regenerate with `npm run docs:build` from `frontend/` (writes `website/docs/*.html` and `search-index.json`); never hand-edit those.

## Tried and ruled out
- Deferring every website change to B4/Q: B4 retires the note, not how readers find the rows, and the column is already written.

## Watch out
- `docs:build` prints missing-image warnings for unrelated pages; they are pre-existing.
