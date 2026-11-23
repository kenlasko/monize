---
title: "Issue #2358: legacy foreign entries carrying the default exchange_rate 1"
author: Node
date: 2026-11-23
branch: claude/issue-2358
cost: { minutes: 3, tokens: 79032 }
---

## Decided
- Nothing implemented yet; asked the maintainer to choose between a data migration, a read-side check, or a documented residual.
- Hole rows come from TransactionsService.update between d48161e0e (2026-07-20) and #2348: a plain row gained originalAmount/originalCurrencyCode with no rate, kept the default 1, and kept its old amount (normalizeFxEntry never recomputes or checks amount vs originalAmount x rate).
- Only rows whose amounts DISAGREE with 1:1 (fee included) are wrong; a row that agrees at 1:1 converts correctly at 1 however it got there.
- Recommended fix: a data-only migration that sets exchange_rate = fxBaseFromCharged(amount, account fx_fee_percent) / original_amount for those rows, the same rate resolveForeignEntry (MCP path) derives from two amounts with no rate.

## Tried and ruled out
- A read-side band check without the account fee: fee can be up to 100%, so the band lets EUR 100 charged as USD 117.50 pass.
- A read-side check with the fee: needs accounts.fx_fee_percent joined into about ten query shapes and leaves the Foreign Currency Fees report wrong (it derives the fee from original_amount, rate and amount).

## Watch out
- ScheduledTransactionsService.update (~L2757) has the same fallback to scheduled.exchangeRate for a plain schedule. The impact is minor: posting uses the market rate or derives one (resolveFxForPosting), and the estimate refresh cron overwrites the stored rate.
- REST create does not check that the amounts agree with the rate; only the MCP/assistant path (resolveForeignEntry) does.
- There is no exchange_rate_source column on transactions, so a hole row cannot be told apart from a recorded 1 except by its amounts.
