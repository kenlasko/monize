---
title: "Brokerage register uses Pebble's day-block list on phones too, like the cash register"
author: Ken
date: 2026-11-28
branch: claude/investments-mobile-pebble-folio
cost: { minutes: 5, tokens: 82653 }
id: l-03b8140b
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/investments/InvestmentTransactionList.tsx
---

## Decided
- In Pebble, the brokerage register draws `InvestmentPebbleRegister` at every width and density, phones included. PR #2511 (issue #2510) left phones on the #2508 wrapped cards with a Pebble day title. The maintainer reported that as "Pebble not showing on mobile", because the cash register beside it shows its Pebble list on a phone.
- Folio on a phone is unchanged: wrapped cards under the ledger's eyebrow heading at Normal, and the ledger table at Compact and Dense. That already matches the cash register.

## Watch out
- `InvestmentDayHeading` now only draws for Folio. Pebble maps to `NoHeading`, because a Pebble register never reaches the table.
- On a phone, a Pebble trade row has no Edit, Duplicate or Delete buttons (`hidden sm:flex`). It relies on the long-press sheet, and the status sits under the security name.

In the code: frontend/src/components/investments/InvestmentTransactionList.tsx (`pebbleList`, `groupedByDate`), variants/InvestmentDayHeading.tsx, InvestmentTransactionList.mobileWrapped.test.tsx.
