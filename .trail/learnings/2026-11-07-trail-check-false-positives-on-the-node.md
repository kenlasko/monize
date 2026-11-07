---
title: trail check false positives on the Rate Direction wording
author: Node
date: 2026-11-07
branch: claude/issue-2053
cost: { minutes: 1, tokens: 20464 }
touches:
  - website/docs/currency-management.html
  - website/docs/currency-management.md
  - website/docs/search-index.json
---

## Decided
- `trail check` on claude/issue-2053 flags website/docs/currency-management.md/.html and search-index.json against several unrelated learnings purely on keyword overlap: "rate column code" (Ken's Oct learning about NOT widening exchange-rate columns past NUMERIC(20,10) -- this PR touches no schema), "rate column direction" and "rate direction head" (a Nov 7 learning about NOT moving the rate-direction tooltip onto the existing Rate column header -- this PR did the opposite of what that bullet describes and puts the tooltip on the Rate History dialog's heading instead, which is the decision that actually shipped), "report direction transfer" and "field report result" (unrelated ReportResult/includeTransfers work), and "content search nav"/"link setting security" (unrelated help-panel test slicing and Reminders settings links). None of these touch the code this PR changed (frontend currency/transaction components, docs-links.ts, the currency-management guide).
- These are the same class of false positive as `.trail/learnings/2026-11-07-trail-check-false-positives-learnmore-forwarding-node.md`: a "ruled out" bullet phrased as "considered doing X, decided against it" matches code that actually does X when X is the shipped decision, not the rejected one.

## Watch out
- `trail check` also warned that claude/issue-2050 (pushed, not yet merged) touches the same website/docs/search-index.json -- that's a real, structural note (a regenerated search index both branches touch), not a content conflict; whichever branch merges second will just need the index regenerated again.
