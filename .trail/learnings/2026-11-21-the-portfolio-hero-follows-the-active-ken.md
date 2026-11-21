---
title: "The portfolio hero follows the active UI style like net worth, but keeps its area chart"
author: Ken
date: 2026-11-21
branch: fix/portfolio-hero-size
cost: { minutes: 15, tokens: 206194 }
id: l-37cde720
scope: repo
status: active
src: agent
touches:
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/fr/dashboard.json
  - frontend/src/i18n/messages/hi/dashboard.json
  - frontend/src/i18n/messages/id/dashboard.json
  - frontend/src/i18n/messages/it/dashboard.json
  - frontend/src/i18n/messages/ja/dashboard.json
  - frontend/src/i18n/messages/ko/dashboard.json
  - frontend/src/i18n/messages/nl/dashboard.json
  - frontend/src/i18n/messages/pl/dashboard.json
---

## Decided
The portfolio hero was drawing only the Standard layout in every UI style, so under Folio and Pebble it looked small next to net worth's large display figure and tall chart. It now renders through the active style from one prepared view, the way net worth does, so both sets share headline size, typeface, figure layout and chart height. The Folio and Pebble pieces net worth drew inline (ruled figure cells, block figures, the change line and pill) were moved into a shared file so the two sets cannot drift apart again.

## Tried and ruled out
Reusing net worth's Folio step chart and Pebble month bars for the portfolio: both are drawn one slot per month and name months, while the portfolio series is daily or intraday. The portfolio keeps its area chart, placed in a box of the same height as net worth's chart.

New catalog keys for the statement cell labels (Holdings, Cash) rather than reusing the sentence strings: those are rich sentences with the figure inside them and cannot serve as a label. The metric cell reuses the Customize modal's existing metric names.

## Watch out
The user's "only a bit more than 50% of the section" was the portfolio set's height and type size under Folio or Pebble, not a width bug; Standard was already identical for both sets. Check the UI style first when a hero set looks different from its sibling.

Not seen in a browser: checked by tests, lint and type-check only.

In the code: PortfolioHero.tsx (renderForStyle), variants/PortfolioHeroFolio.tsx, variants/PortfolioHeroPebble.tsx, variants/hero-statement-parts.tsx, hero.holdingsLabel and hero.cashLabel in the dashboard catalog.
