---
title: "Report wire precision: round each report figure on the server at the reporting currency's places (Ken, #2384)"
author: Node
date: 2026-11-24
branch: claude/issue-2384
cost: { minutes: 2, tokens: 36579 }
touches:
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
  - docs/financial-calculation-contract.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/future-plans/report-rounding-and-aggregation.md
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
---

## Decided
- Ken chose option (b) of section 6 of docs/specs/report-rounding-and-aggregation.md: every report figure (built-in, custom, Sankey, AI/MCP report tools) is rounded once on the server at the reporting currency's own decimal places, so screen, CSV, PDF and the AI read the same figure and the screen's rounding is the identity.
- It ships as its own PR (stage 2). Stage 1 (#2384's first PR) keeps four places on the wire and is "Part of #2384", not "Closes"; stage 3 is the client surfaces, one PR per group in docs/future-plans/report-rounding-and-aggregation-tasks.md.

## Tried and ruled out
- (a) keeping four places and documenting the one-cent double rounding (2.50498 -> 2.5050 -> 2.51).
- (c) sending calculation precision and rounding only at presentation: long decimals in CSV and AI output, and every client sum would have to accumulate like FxAggregate.

## Watch out
- Under (b) the Sankey's unit becomes the currency's minor unit (apportionUnits is written for ten-thousandths today), JPY rounds to 0 places and a coin to 8, and every report fixture's 4-place expectation moves to currency places.
