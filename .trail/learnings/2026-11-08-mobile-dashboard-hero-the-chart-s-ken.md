---
title: "Mobile dashboard hero: the chart's top margin can shrink because its flag bubbles sit beside the dot"
author: Ken
date: 2026-11-08
branch: main
id: l-83223425
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/NetWorthHero.test.tsx
  - frontend/src/components/dashboard/hero-parts.tsx
  - frontend/src/components/investments/portfolio-chart-utils.tsx
---

## Decided
The 36px Recharts top margin on the dashboard hero chart was mostly unused. The hero's high/low bubbles are placed left or right of their dot and centred on it, so a 22px bubble rises only 11px above a point at the top of the plot. Below `lg`, where the chart stacks under the figures, the margin is now 12px and the seam gap is 4px. From `lg` up the margin stays 36px, because the request was for mobile only and the chart sits beside the figures there.

## Tried and ruled out
A negative top margin on the chart's container (already considered in the issue #2075 work) was not used. It would put the chart's SVG over the sub-figures, and the SVG could then take taps meant for that text. Changing the Recharts margin leaves the boxes apart and gives the plot the reclaimed height.

## Watch out
12px depends on the bubbles being placed sideways. If the hero's flags ever move to `side: 'above'` (gap 24 + arrow 5 + height 22 above the dot), the stacked margin has to grow again.

In the code: frontend/src/components/dashboard/hero-parts.tsx (CHART_TOP_MARGIN_STACKED, LAYOUT_CLASS), renderMinMaxFlagDots in frontend/src/components/investments/portfolio-chart-utils.tsx. The breakpoint is useIsBelowDesktop, which matches the layout's `lg` stack point; useIsMobile stops at 639px and would miss tablets.
