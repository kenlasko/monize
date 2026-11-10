---
title: "Issue #2070: undo/import balance recompute used CURRENT_DATE instead of the user's day"
author: Node
date: 2026-11-10
branch: claude/issue-2070
cost: { minutes: 16, tokens: 150062 }
touches:
  - backend/src/action-history/action-history.service.spec.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/import/import-post-processing.service.spec.ts
  - backend/src/import/import-post-processing.service.ts
---

## Decided
ActionHistoryService.recalculateBalance (backend/src/action-history/action-history.service.ts)
and ImportPostProcessingService.run (backend/src/import/import-post-processing.service.ts) both
summed the ledger bounded by the database server's CURRENT_DATE. Fixed both to take todayYMD()
as a bound query parameter ($2), matching AccountsService.recalculateCurrentBalance. Both call
sites run inside authenticated HTTP requests (undo/redo controller, import controllers), so
todayYMD()'s AsyncLocalStorage-backed getRequestTimezone() resolves correctly without threading
a timezone parameter through.

## Tried and ruled out
Did not touch the "Related" CURRENT_DATE cuts the issue mentions in net-worth.service.ts and
portfolio-calculation.service.ts (current month boundary) -- those were flagged only as related,
not part of "fix the issue as stated" (Ken's comment scoped it to the two recomputes named in
"Where"). Treat as a separate issue if asked.

## Watch out
backend/src/import/import-post-processing.service.spec.ts had a literal assertion
`expect(sql).toContain("t.transaction_date <= CURRENT_DATE")` that had to become `<= $2` --
grep for CURRENT_DATE in spec files before changing a SQL literal to a parameter, tests assert
the raw SQL string. On this worker, `npx tsc --noEmit -p tsconfig.json` OOMs at default heap but
passes clean with `NODE_OPTIONS="--max-old-space-size=4096"`. `npm run test:changed` errors if
given any CLI args (it's a no-arg wrapper) -- to run with maxWorkers=1 you must replicate its two
`jest --listTests` calls yourself and feed the file list to `jest --runTestsByPath ... --maxWorkers=N`.
