---
title: "Dashboard trivia lives in its own opt-in widget, not in the hero"
author: Ken
date: 2026-11-10
branch: feat/dashboard-hero-trivia
id: l-f0b137d5
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/TriviaWidget.tsx
---

## Decided
The daily trivia is shown by an opt-in Trivia widget that cycles through the facts. The hero keeps its original layout: the figures as wide as they need, the chart taking the rest and rising beside the greeting, and the set switcher's two dots right after the greeting's gear and help icons. The daily build runs only for a layout that lists the widget, which also keeps AI cost to readers who asked for it.

## Tried and ruled out
Ken rejected every way of fitting the trivia into the hero, because each one changed the hero's layout:
- A line beside the greeting, which pushed the chart down or the figures lower.
- A column between the figures and the chart, which narrowed the chart.
- Half-width figures with the trivia above them, which cost the chart its width and needed clamping to four lines.

He also rejected moving the dots to the figures' caption line, because it looked out of place.

## Watch out
The chart rises beside the stationary greeting through a measured `--hero-head-h` (a negative top margin on the chart column). The figures column's minimum width is the measured greeting row, so they never sit narrower than the greeting, as when it was in their column.

In the code: frontend/src/components/dashboard/TriviaWidget.tsx, DashboardHero.tsx, hero-parts.tsx (FIGURES_COLUMN_CLASS, CHART_COLUMN_CLASS), backend TRIVIA_WIDGET_ID gate in dashboard-trivia.service.ts.
