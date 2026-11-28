---
title: "Why #2508 left the brokerage list unstyled in Folio/Pebble (issue #2510)"
author: Node
date: 2026-11-28
branch: claude/issue-2510
cost: { minutes: 1, tokens: 57753 }
touches:
  - frontend/src/components/investments/InvestmentTransactionList.tsx
  - frontend/CLAUDE.md
---

## Decided
- #2508 shipped only `InvestmentDayHeading`, gated by `groupedByDate = isMobile && density === 'normal' && uiStyle !== 'standard'` (`frontend/src/components/investments/InvestmentTransactionList.tsx`). At 640px and up, and on a phone at Compact or Dense, the brokerage register renders the same standard table in all three styles.
- The cash register's Folio/Pebble look is much more than day headings. Folio adds the `ui-register` class to the table (ledger rules, banded `ui-register-row`, Payment/Deposit `ui-register-money` columns, date group rows, `FolioRegisterFoot` totals, legend). Pebble replaces the table with `PebbleRegister` (day blocks, avatars, an inspector from `lg`). `InvestmentTransactionList` uses none of these.
- The #2508 session narrowed the scope to "phone only, the date alone" after asking the maintainer. Issue #2510 says that answer did not cover what they wanted, so the next step goes back to them to scope the desktop look.
## Watch out
- Payment/Deposit columns and day nets assume one signed amount in one currency. Brokerage rows carry their own `amountCurrencyCode`, and a client-side sum across rows is forbidden ("An investment row's money" in frontend/CLAUDE.md).
- `InvestmentTransactionList.tsx` is already over the 800-line cap. A Pebble brokerage renderer belongs in `components/investments/variants/`.
