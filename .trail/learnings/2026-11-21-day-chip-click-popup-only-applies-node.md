---
title: "Day-chip click popup only applies to Pebble's fourteen-day strip"
author: Node
date: 2026-11-21
branch: claude/issue-2318
cost: { minutes: 20, tokens: 232273 }
touches:
  - frontend/src/components/dashboard/variants/UpcomingBillsListPebble.tsx
  - frontend/src/components/dashboard/variants/UpcomingBillsListVariants.test.tsx
  - frontend/src/components/scheduled-transactions/variants/BillsOutlook.test.tsx
  - frontend/src/components/scheduled-transactions/variants/BillsOutlookPebble.tsx
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/en/dashboard.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/fr/dashboard.json
  - frontend/src/i18n/messages/hi/dashboard.json
  - frontend/src/i18n/messages/id/dashboard.json
---

## Decided
Issue #2318 ("click a day on the Next 14 Days widget to see its bills/deposits") is implemented only for the Pebble-style day-chip grid, shared by the dashboard's Upcoming Bills widget (`UpcomingBillsListPebble.tsx`) and the Bills page's "Next fourteen days" outlook band (`BillsOutlookPebble.tsx`). Extracted a shared `DayChip` component (in `UpcomingBillsListPebble.tsx`, exported and imported by `BillsOutlookPebble.tsx`, same pattern `StripDot` already used) that wraps the weekday/day-number in a `<button>` opening a `Modal` listing that day's occurrences (or a "nothing scheduled" message), while the dot buttons (InfoTooltip triggers) stay siblings, not nested, to avoid button-in-button.

## Tried and ruled out
Adding the same click-to-popup to the Folio style's day strip (`UpcomingBillsListFolio.tsx` / `BillsOutlookFolio.tsx`): its strip is explicitly `role="img"`, documented in its own comment as "Decorative beside the list/ledger under it, which carries every figure" -- i.e. a deliberate prior design decision that the full detail already lives in the ruled list below, one day-header per group. Making it interactive would contradict that existing architecture without a separate agreement; the Standard style has no day strip at all (comment: "Standard has no outlook band: the forecast chart and the list say it").

## Watch out
`trail check` flagged 7 conflicts on this change, all false positives (unrelated ListTopToolbar paging, CSV cell concatenation, date-format guessing, InsightsWidget CTA, dialog heading pattern) -- confirms the same false-positive pattern Node's Nov 7 learning already described (trail check scans a touched file's whole current content, not just the diff).

One of the 7 looked real at first glance: Node's Nov 7 learning warns against inserting new i18n keys into all 18 locale files by matching ambiguous substrings like "title". Verified this doesn't apply here -- the anchor used (`"stripLabel"`) was confirmed unique per file (`grep -c` = 1 in all 18) and its surrounding lines (`"stripLabel"` before, `"metaPayee"` after) were checked identical across every locale before and after insertion. `messages.parity.test.ts` (1934 assertions) and `npm run i18n:check` both passed. The learning's actual rule -- verify anchor uniqueness/content first -- was followed; a bare substring match on a key name is fine when that key only occurs once per file.
