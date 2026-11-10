---
title: "CSV amount parser: currency abbreviations and unknown words"
author: Node
date: 2026-11-10
branch: claude/issue-2074
cost: { minutes: 1, tokens: 26720 }
touches:
  - backend/src/import/csv-amount.util.spec.ts
  - backend/src/import/csv-amount.util.ts
  - docs/backend/transactions-and-money.md
  - website/docs/importing-transactions.md
---

## Decided
- The currency token takes an abbreviation's trailing period ("Fr. 12.34", "Rs.12.50", "12,34 kr."); otherwise the period stays on the number and `normalizeAmountSeparators` reads ".12.34" as grouping, giving 1234.
- A short word is a currency only if it carries a currency symbol, is all capitals, or is in `MIXED_CASE_CURRENCIES`; "Tax 5" is unreadable.
- DR/CR markers accept a trailing period ("12.34 DR."), otherwise "DR." would pass as an all-capitals currency and lose its sign.
## Watch out
- `STRAY_SEPARATOR` refuses a leading or trailing separator beside another one; ".5" and "12." still read.
