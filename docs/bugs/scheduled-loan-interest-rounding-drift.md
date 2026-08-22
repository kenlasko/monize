# Scheduled loan payment interest drifts from amortization report

## Summary

After a scheduled loan or mortgage payment posts, Monize can calculate the next bill's interest a few cents differently from the projected row in the loan amortization report.

The issue affects standard US mortgages and other amortizing loans. It is not specific to Canadian mortgage compounding.

## Affected behavior

- The loan amortization report calculates each projected period's interest from the outstanding balance and periodic interest rate.
- Initial bill setup can also calculate interest from the current balance when the detected historical split option is disabled.
- Subsequent bill recalculation instead advances the previous stored principal/interest split with an amortization recurrence.
- Stored split amounts have already been rounded to money precision, so the recurrence carries that rounding difference into future bills.
- The stored `currentBalance` excludes future-dated transactions. Using it after a future payment posts therefore repeats the prior balance and interest, even when future regular or principal-only payments have reduced the debt.

## Reproduction

1. Configure an amortizing loan or mortgage with an annual interest rate, payment amount, payment frequency, and scheduled split payment.
2. Ensure the scheduled payment contains principal and interest splits.
3. Post one scheduled payment.
4. Compare the interest split prepared for the next bill with the first projected interest row in the loan amortization report.
5. Repeat across several payments.

## Actual result

The next bill's interest may differ from the amortization report by a small amount. Differences can accumulate because each recalculation uses previously rounded split values.

## Expected result

For the same balance, annual rate, payment frequency, and mortgage compounding mode, the next scheduled bill and the first projected amortization row calculate the same interest amount. The balance is measured from the ledger through the next due date so all already-posted principal movements on or before that date are included:

```text
debt = max(0, -(openingBalance + postedTransactionsThroughNextDueDate))
interest = roundMoney(debt * periodicRate)
```

Principal is the regular payment less interest, subject to the existing loan payment waterfall and remaining-balance caps.

## Root cause

`ScheduledTransactionLoanService.recalculateLoanPaymentSplits` used this recurrence when prior principal and interest splits were available:

```text
nextInterest = previousInterest - previousPrincipal * periodicRate
```

The recurrence is algebraically equivalent to recalculating from balance only when its inputs retain full precision. Scheduled transaction splits are stored at money precision, so fractions discarded from the previous split cannot be recovered.

Replacing the recurrence with `account.currentBalance` alone is incomplete because that column intentionally represents the balance through today and excludes future-dated transactions. A payment posted for a future date therefore does not change it.

## Proposed fix

Always calculate the next scheduled interest split from the authoritative loan ledger balance through the schedule's next due date. Include every non-void, top-level transaction through that date, including regular and principal-only payments. Continue using the existing periodic-rate rules:

- Standard US mortgage and loan: nominal annual rate divided by payments per year.
- Canadian fixed-rate mortgage: effective periodic rate derived from semiannual compounding.
- Existing variable-rate behavior remains unchanged.

Continue passing the calculated interest and principal through `allocateLoanPayment` so interest-first allocation, extra principal, and final-payment clamps remain unchanged.

## Acceptance criteria

- A standard US mortgage bill calculates interest from the post-payment balance.
- Previously rounded or inconsistent template splits do not influence the next interest calculation.
- Future-dated regular and principal-only payments posted on or before the next due date reduce the balance used for interest.
- Transactions after the next due date do not affect that installment.
- Canadian fixed-rate periodic-rate behavior remains intact.
- Loan, mortgage, and line-of-credit scheduled payments remain supported.
- Extra-principal and final-payment clamps continue to pass their existing tests.
- The scheduled-loan service test suite includes a regression where prior rounded splits disagree with the authoritative balance.
