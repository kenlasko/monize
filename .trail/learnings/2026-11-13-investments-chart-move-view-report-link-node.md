---
title: "Investments chart: move View report link below x-axis"
author: Node
date: 2026-11-13
branch: claude/issue-2135
cost: { minutes: 6, tokens: 84117 }
touches:
  - frontend/src/components/investments/InvestmentValueChart.tsx
---

## Decided
Moved the "View report" deep-link on InvestmentValueChart.tsx out of the title's flex row and into its own centered `flex justify-center mt-2` div after the chart (before the card's closing div), so it renders below the x-axis regardless of loading/empty/intraday-unavailable state. Also dropped the now-single-child wrapper div that used to group the h3 and the link.

## Tried and ruled out
Did not touch the chart's own margin/SVG to reposition the link "inside" the plot area — the link stays as a normal DOM sibling below the ResponsiveContainer, not absolutely positioned over the SVG. `trail check` flagged two learnings as conflicts (a Prettier-reformatting-the-frontend one, and a dashboard-hero negative-top-margin-overlaps-sub-figures one); neither applies — both are keyword-matched false positives against unrelated files/approaches, not against this change.

## Watch out
The link previously sat inside the same flex row as the "Updating" spinner and the intraday-fallback warning icon (the title row) — that's the issue #2135 bug: that row could wrap and push DateRangeSelector to a second line. If anyone moves summary cards or adds more title-row content again, check whether the same wrap-pushes-selectors issue recurs.
