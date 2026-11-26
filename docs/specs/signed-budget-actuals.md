# Signed budget actuals

Proposal for the budget portion of [discussion #2404](https://github.com/kenlasko/monize/discussions/2404).

On 11 March 2026, the budget started netting purchases and refunds and explicitly floored both spent and earned amounts at zero. A 500 purchase and matching 500 refund had previously appeared as 1,000 spent. On 12 November, a regression test pinned that zero floor in the live category trend. This proposal retains the original netting and allows its result to cross zero. [March calculation change](https://github.com/kenlasko/monize/commit/b16a50a7d53a5be66ddf379369a492ab43c07f77) · [November trend test](https://github.com/kenlasko/monize/commit/762a16689b49aaa9b995e98c344730354859f78d)

For an ordinary expense line, actual spending equals the negative of the signed sum of eligible postings in the budget currency. For an ordinary income line, actual income equals their signed sum. Use the budget line's existing classification throughout the period. A refund of a purchase from an earlier period can therefore produce negative spending this period. A salary reversal can produce negative actual income.

| Expense budget | Signed postings | Spent | Remaining (budget − spent) | Trend variance (spent − budget) |
| ---: | --- | ---: | ---: | ---: |
| 100 | −100, +30 | 70 | 30 | −30 |
| 100 | −100, +100 | 0 | 100 | −100 |
| 100 | −100, +150 | −50 | 150 | −150 |

Read signed actuals through the same rule in the live budget summary, the category and whole-budget trend, and the snapshot written on closing a period. The calculation is read-only until the existing close operation. Historical snapshots retain their recorded figures (INV-BUDGET-003). The existing account exclusions, split selection, dated FX conversion and missing-rate policy apply before each line is reported. A missing required rate still yields an unknown value on callers that request a complete line.

An income-linked allocation uses its existing nonnegative funding base. A transfer line tracking money from a funding account retains its separate rules in [Budget transfer income](budget-transfer-income.md). These funding calculations serve a different purpose from measuring actual income in ordinary categories.

The PostgreSQL regression in the budget multi-currency actuals suite follows a purchase and its larger refund through the summary, trend and period close. Unit tests cover income reversals, zero activity, missing rates and transfer-specific controls.

## Progress bars and notices

Bar widths and numeric accessibility positions stay within 0–100. The label and the accessible value text retain an out-of-range financial percentage in the reader's number format. A 100 budget with net spending of −50 has an empty bar and reports −50%. Spending of 150 fills the bar and reports 150%. The same geometric bounds apply to budget widgets, 50/30/20 group bars and monthly summary emails.

A negative milestone shows net spending and the budget amount. An income shortfall below zero shows signed actual income and the income expected so far. The daily budget fact shows net spending, the budget and the elapsed share of the month. [Review of PR #2429](https://github.com/kenlasko/monize/pull/2429#pullrequestreview-6067458497)

## Projection

For the velocity widget and projected-overspend alert, measure purchases on elapsed days before netting refunds. Divide those purchases by elapsed days and project only the remaining days. The month-end net is spending already recorded (purchases minus refunds) plus future purchases at that pace. Purchases of 50 and a refund of 300 by day 5 of 30 give a pace of 10 per day, another 250 in expected purchases, and projected net spending of zero. A refund-only period has zero purchase pace. On the last day the forecast equals recorded net spending. The widget applies the rule across expense lines and the alert applies it to its category. Use the budget’s account, split, transfer and currency eligibility at the posting date. A missing exchange rate leaves an unknown projection and suppresses a velocity alert.

## Expense and bucket rollover

When rollover is enabled, the next period receives the signed closing balance. For an expense line this is its allocation plus incoming rollover minus actual spending. For a bucket this is its own allocation plus its incoming carry minus its members’ spending. The bucket and its lines carry their balances independently. A configured cap limits positive carry only. Disabling carry makes the outgoing amount zero. A bucket with an unknown allocation keeps its existing zero outgoing carry. Previously closed periods keep their stored amounts. [Decision in #2404](https://github.com/kenlasko/monize/discussions/2404) · [Maintainer confirmation](https://github.com/kenlasko/monize/pull/2429#issuecomment-7180940431)

The live category row shows the amount over budget when the remaining balance is negative. A line with zero or negative effective funding has no meaningful percentage of budget used or comparison to the elapsed share of the month. The monthly email uses the effective expense funding recorded for the closed period.

With 100 allocated per month, monthly rollover and no cap, a January purchase of 300 followed by a full refund in February gives the same result for an expense line and a bucket:

| Month | Allocation | Carry in | Available before activity | Actual spending | Balance after activity |
| --- | ---: | ---: | ---: | ---: | ---: |
| January | 100 | 0 | 100 | 300 | −200 |
| February | 100 | −200 | −100 | −300 | 200 |
| March | 100 | 200 | 300 | 0 | 300 |
