---
title: "Provisional mark on account and net worth figures (F2, #2398)"
author: Node
date: 2026-11-26
branch: claude/issue-2398
cost: { minutes: 15, tokens: 217781 }
touches:
  - docs/future-plans/provisional-amounts.md
  - frontend/src/i18n/messages/de/common.json
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/es/common.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/common.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/common.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/common.json
---

## Decided
- The mark lives in `ProvisionalMark` (components/ui) and is drawn through `PartialTotal`'s optional `provisionalCount` prop, so partial + provisional shows both marks without a second wrapper at each call site. Surfaces with no `PartialTotal` (account row, register header) render `ProvisionalMark` directly.
- Counts are read through `provisionalCountOf` / `sumProvisionalCounts` (lib/provisional-amount.ts); absent = 0 = no mark.
- A window of net worth months uses the MAX month count for its note, not the sum: a provisional leg sits in every month from its date on.
- The hero's counts travel as `provisional: {netWorth, assets, liabilities}` on `HeroSnapshot` / `NetWorthHeroViewProps`; `StatementAmount` takes `provisionalCount`.

## Watch out
- A new key in `en/common.json` fails `type-check` until every locale's `common.json` has it: `src/app/global-error.tsx` types every locale's common catalog as `typeof enCommon`. Other namespaces don't have this coupling.
- `trail check` flags "provisional count" against an unrelated MCP-schema learning; it is a keyword match.
