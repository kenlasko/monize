---
title: "Pre-#2436 cash-leg repair: the trade owns the VOID boundary; report what cannot be repaired (#2445 review)"
author: Node
date: 2026-11-26
branch: claude/issue-2445
cost: { minutes: 13, tokens: 106278 }
touches:
  - backend/test/integration/migration-heal-imported-investment-cash-leg-shape.integration.spec.ts
  - database/migrations/20261126140130_heal_imported_investment_cash_leg_shape.sql
  - docs/backend/transactions-and-money.md
---

## Decided
- The investment row owns its cash leg's VOID boundary (`assertVoidTransitionAllowedOnRow` refuses voiding a cash leg alone; `updateStatus` carries the trade's VOID to the row `transaction_id` names). On the old imported shape that row was the brokerage counterpart, so a trade voided from the investment side left its real cash row active. The repair migration voids that cash row and gives back its amount (not for a future-dated row), and drops that cash account's `monthly_account_balances` too.
- Left unrepaired and named in a NOTICE: an active trade over a VOID cash row (voided from the register on the old shape; whether the trade or only its cash was meant cannot be read), and a VOID trade over a RECONCILED cash row.
- Rows the #2436 edit defect already damaged are reported only: an unlinked transfer row in a linked cash account beside a trade's cash row of the same date and amount.
- PR #2443's doc sentence "nothing repairs them in place" now points at the repair (the earlier learning's watch-out is resolved).

## Tried and ruled out
- `DROP TABLE IF EXISTS pg_temp.x` at the top of a DO block: raises `schema "pg_temp" does not exist, skipping` on a fresh session. Guard it with `to_regclass('pg_temp.x') IS NOT NULL`; the migration lint still wants `IF EXISTS` on the DROP inside the guard.

## Watch out
- NOTICEs are testable with a raw `pg` Client (`client.on("notice", ...)`); TypeORM's `query` drops them.
- Owner-timezone tests: Pacific/Kiritimati (UTC+14) and Etc/GMT+12 (UTC-12) are 26 hours apart, so their dates always differ; the two together catch a "zone ignored" mutation at any hour.
