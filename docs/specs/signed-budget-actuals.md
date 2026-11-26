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
