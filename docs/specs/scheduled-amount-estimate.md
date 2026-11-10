# Estimated scheduled amounts

Specification of the **Estimate** option on a scheduled transaction (issue
#2096): instead of a typed amount, every occurrence is priced from the payee and
category's payment history, month by month, so a bill that costs more in winter
is forecast as costing more in winter. Agreed with the maintainer on the issue
on 2026-11-10; the answers are restated in section 9 so this document stands
alone.

## 1. Goal

- The New/Edit Scheduled Transaction form offers an **Estimate** toggle between
  **Amount** and **Reference Number**, in single-transaction mode only. When on,
  the Amount input is disabled and says the amount is worked out from payment
  history, and shows the next occurrence's estimate when there is one.
- Each occurrence is priced at the estimate for the month it falls in. A person
  sees the estimate for any month in the occurrence editor and in the Cash Flow
  Forecast chart's tooltip, where an estimated occurrence is marked as one.
- An occurrence stays editable as before. An override that states an amount is
  that occurrence's amount, and no later estimate touches it.
- Posting prefills the occurrence's estimate in the Post dialog, editable as
  before. An estimated schedule is never auto-posted.
- The estimate follows new payments: it is computed on every read, never stored
  per occurrence.

## 2. Which schedules can be estimated

An estimated schedule (`scheduled_transactions.amount_is_estimated`) is a plain,
single-category schedule in its account's currency, with a payee and a category:

| Shape | Estimate on create / explicit update | Flag already on, update changes the shape |
| --- | --- | --- |
| Split, transfer, investment | refused (`estimateRequiresPlain`) | flag dropped, like the foreign-currency trio |
| Foreign-currency amount (`original_currency_code`) | refused (`estimateRequiresPlain`) | flag dropped |
| Auto-post on | refused (`estimateNoAutoPost`) | refused |
| No payee id or no category | refused (`estimateRequiresPayeeAndCategory`) | refused when this request clears it; a payee or category gone on its own leaves the schedule editable (status `no-basis`) |

A loan or payroll bill is a split and so never qualifies. The refusals run
before anything is written (`ScheduledTransactionsService.assertEstimatable`).
The auto-post cron also skips the flag in both of its candidate reads and under
the lock (`requireActiveAutoPost`), so no path posts an estimate unattended. A
CHECK constraint is not added in the expanding migration: a pod of the previous
release could still turn auto-post on during a rolling deployment
(`docs/database-migrations.md`, "narrow a type or add a CHECK"). A category
deleted later (`ON DELETE SET NULL`) leaves the schedule estimated with status
`no-basis` (section 5).

The refusals read the row from before the update's transaction, so two
concurrent edits, one turning auto-post on and one turning the estimate on, can
leave a row with both set. Nothing posts it: both auto-post candidate reads
filter `amount_is_estimated` and the under-lock `requireActiveAutoPost` check
refuses it. The row only reads oddly until the next edit refuses the pair; the
CHECK constraint in a later contract migration closes it.

In the form, the toggle is disabled for a delegate (the reason in its tooltip)
and the currency picker is disabled while estimating, so neither a delegate's
toggle nor a switch to a foreign entry is dropped silently.

## 3. Which payments count

`ScheduledAmountEstimateService.loadHistory`, one statement per read for every
estimated schedule in it:

- The user's transactions with the schedule's `payee_id` and, on the row or on
  one of its split lines, its `category_id`. Transfers, transfer lines and
  investment cash (`investmentExclusionSql`) are excluded; so is `VOID`.
- Dated after today minus 24 months (`ESTIMATE_HISTORY_MONTHS`, the day clamped
  to the month's end) and on or before today. A future-dated row is not a
  payment yet.
- Any account. A payment in another currency is converted into the schedule's
  currency at the **current** rate, the newest stored on or before today
  (`ExchangeRateService.getRateForDate(from, to, today, { fetchMissing: false })`:
  this runs on every list read, expansion and reminder pass, and the daily
  refresh stores the currencies accounts are held in), at the schedule
  currency's money precision. No rate for one payment makes the whole estimate
  unknown (`missing-rate`, with the pair named): the mean of the rest would be
  another bill's mean.
- Only payments on the history's dominant side of zero (the sign of the
  window's sum, the newest payment's when the sum is zero): a refund from the
  biller is not a bill. A zero payment carries no amount and is dropped.

## 4. The estimate for one month

`backend/src/scheduled-transactions/amount-estimate.ts`, pure. The estimate
is a **level**, a **seasonal index** and a **trend**, each admitted only when
the history shows it, so a flat bill stays flat and a price change is the
price from then on (review of the first version: a two-year history was read
as seasonal whatever its shape, and a price step as both a season and a
trend).

Each payment is placed by its calendar-month offset from today's month: 0 to
11 is the latest year, 12 to 23 the one before.

1. **Seasonal index.** Per year, a calendar month's mean over the mean of that
   year's monthly means, so a price change between the years cancels out. The
   history is **seasonal** only when each year holds at least four months
   (`ESTIMATE_SEASONAL_MIN_MONTHS`, a quarterly bill), each year's index
   strays at least 10% from 1 somewhere (`ESTIMATE_SEASONAL_MIN_SPREAD`), and
   the months both years hold agree with a correlation of at least 0.6
   (`ESTIMATE_SEASONAL_MIN_CORRELATION`). A flat bill does not vary; a price
   step varies in one year only. The index used is the two years' average.
2. **Level.** The mean of the newest three payments, each divided by its
   month's index (1 when not seasonal): what a month of index 1 costs at the
   latest price.
3. **Growth** `g`. Over the offsets `k` holding a payment at both `k` and
   `k + 12`, the sum of the latest year's monthly means over the earlier
   year's, minus one, only when at least three months compare
   (`ESTIMATE_MIN_GROWTH_MONTHS`) and their per-month ratios agree within a
   standard deviation of 0.1 (`ESTIMATE_GROWTH_MAX_DISPERSION`): a trend moves
   every month alike, a step moves some and not others and is already in the
   level. Clamped to [-50%, +100%].
4. For an occurrence falling in month `M` (the date it falls on, an override's
   moved date included): `level x index(M) x (1 + g)^(months from the newest
   payment to M / 12)`, `basis: "seasonal"` when the index holds `M`,
   `"recent"` otherwise.
5. Rounded to the currency's entry places (`currencies.decimal_places`): an
   estimate is a figure a person would have typed. The amount is per payment,
   not per month, so a weekly bill's estimate is one week's payment.

Worked examples, all from `amount-estimate.spec.ts` with today 2026-11-09 and
one payment on the 5th of each month from December 2024:

| History | Month | Estimate |
| --- | --- | --- |
| -100 (Jul), -110 (Aug), -120 (Sep), -130 (Oct 2026) only | any | (-110 - 120 - 130) / 3 = -120, recent |
| -10 every month | any | -10: no season, no trend |
| -10, then -15 from May 2026 (24 or 13 months) | 2026-12 to 2027-11 | -15: the new level; no season, no trend |
| -100, then -105 every month from Dec 2025 | 2027-11 | -105 x 1.05 = -110.25 |
| heating shape (Jan 200 ... Jul 50), latest year 10% dearer | 2027-01 | -220 x 1.1^(2/12) = -223.52, seasonal |
| same | 2027-07 | -55 x 1.1^(8/12) = -58.61, seasonal |
| same | 2027-11 | -165 x 1.1 = -181.50, seasonal |

## 5. Missing data

`ScheduleAmountEstimateStatus`; every status but `estimated` leaves every
estimated occurrence's amount **unknown** (`null`, `complete: false`, direction
`null`), never the stored `amount`:

| Status | Meaning | What the person is told |
| --- | --- | --- |
| `estimated` | the history produced one | the estimate, labelled as one |
| `no-basis` | no payee or no category to match on | choose a payee and a category |
| `no-history` | no counted payment in the last 24 months | no payments to the payee in the category yet; enter this occurrence's amount |
| `missing-rate` | a payment's currency has no current rate | the pair (`from` to `to`) and that the rate is added on the Currencies page |

An unknown occurrence withholds every total it belongs to, as any unknown
occurrence does (INV-OCCURRENCE-003's aggregation rule). Posting one with no
amount entered is refused (`estimateUnknown`); the Post dialog asks for it.

## 6. Overrides, the snapshot and posting

- An override that states an amount, or carries split lines, governs its
  occurrence; `estimated` is false on it. An override that states only a date,
  category or description follows the estimate for the month it falls in.
- The occurrence editor prefills the estimate and says that saving it
  unchanged sends no amount, so the occurrence keeps following the estimate;
  "Keep this amount" pins the shown estimate as the occurrence's own amount
  instead. A changed amount is stored like any other override.
- `scheduled_transactions.amount` is a snapshot: on create and update it is set
  to the next occurrence's estimate when that is known (the sent amount is kept
  otherwise), and after each post it follows the new next occurrence
  (`refreshEstimateSnapshot`, a post-commit step writing only that column while
  the row is still estimated). No surface shows it for an estimated schedule.
- The posting's under-lock basis check (`sameScheduleMutationBasis`) compares
  the payee as well for an estimated schedule: the estimate prepared before the
  lock is that payee's.
- `post()` without an inline amount and without an amount-stating override
  posts the estimate for the occurrence's month, computed by the same service
  the bills list read.
- The Bill Payment History report matches an estimated bill's payments by its
  payee, its category (the row's, or a split's line in it, counted at the
  line's amount) and its direction rather than inside the snapshot's 20% band,
  since the amount varies by design: a refund from the biller or another
  purchase from it is not a payment of the bill. A zero snapshot (an estimate
  saved before any history) assumes no direction.
- Undo restores `amount_is_estimated` with `auto_post`
  (`ActionHistoryService` `ALLOWED_COLUMNS`), so undoing the edit that switched
  the estimate on cannot leave an estimated schedule auto-posting.

## 7. Surfaces

Server: `ScheduledOccurrenceService.expand` prices each estimated occurrence
(`priceEstimatedOccurrences`) and marks it `estimated` with its
`estimateStatus`, so every occurrence consumer (budgets, bill reminders, the AI
forecast, the balance forecast, `GET /scheduled-transactions/occurrences`, the
AI assistant and MCP, whose items carry `amountEstimated`) reads the same
figure. `findAll` sends `amountEstimate` (status, one amount per month from the
earlier of the month before today's and the next due month, at most 24 months
back, through 24 months ahead; payment count, newest payment date, growth,
missing pair), sets `effectiveAmount` to the next occurrence's estimate and each
amountless override's `effectiveAmount` to its own month's. The rule for which
occurrence follows the estimate is `occurrenceFollowsEstimate` on each side.
`GET /scheduled-transactions/amount-estimate/:accountId?payeeId&categoryId` is
the form's preview, through the same service.

The history spans every one of the owner's accounts, so a delegate (an acting
session) is refused the preview, cannot turn the estimate on or off (the key is
dropped from its create or update) and cannot change an estimated bill's payee
or category (`estimateBasisOwnerOnly`), and `findAll` withholds `paymentCount` and
`latestPaymentDate` from one (`null`): the delegate sees the bill's figures, as
they would a typed amount, but not when or how often the owner paid. The AI
forecast prompt and the bill reminder email label an estimated amount, and an
unknown estimate there is not called a missing rate (the prompt names the
status). The `list_upcoming_bills` descriptions, assistant and MCP, describe
`amountEstimated`.

Client: `estimatedOccurrenceAmount` (`frontend/src/lib/scheduled-effective-amount.ts`)
is the one reader of `amountEstimate`; the cash-flow forecast, the Post dialog,
the occurrence editor and the occurrence picker read the month's estimate
through it, and the bills list, the forecast tooltip, the dashboard's
Upcoming Bills and the Upcoming Bills report label the figure as an estimate.
The account balance forecast reports an unknown estimate as `unknownEstimate`,
naming the pair when a payment's currency has no rate. The Bills page's monthly
totals use the estimate's typical month over the year ahead
(`estimatedTypicalAmount`). The bills CSV export carries the figure without a
marker.

## 8. Test matrix

| Claim | Test |
| --- | --- |
| Arithmetic: recent mean, seasonal mean, growth, clamp, rounding, window, refunds | `backend/src/scheduled-transactions/amount-estimate.spec.ts` |
| History match, FX conversion at today's rate, missing rate, no-history, no-basis, read model | `scheduled-amount-estimate.service.spec.ts` |
| Per-month pricing, override precedence, unknown is unknown, no read without an estimated schedule | `scheduled-occurrence.service.spec.ts`, "an estimated schedule" |
| Refusals before write, snapshot, flag dropped on a shape change, posting default and refusal, list read model | `scheduled-transactions.service.spec.ts`, "estimated amounts" |
| Bill Payment History band | `built-in-reports.service.spec.ts` |
| Client forecast, Post dialog, editor, list label, form toggle | the frontend tests named in `docs/future-plans/scheduled-amount-estimate-tasks.md` |

## 9. Decisions (issue #2096)

1. The estimate is computed on read from a flag on the schedule, never stored
   per occurrence; overrides always win.
2. History: payee and category, any account, posted and not void, last 24
   months; another currency is converted at the most recent rate. Split and
   transfer schedules are not estimated.
3. Seasonal per calendar month with a year-over-year growth trend; otherwise the
   mean of the last three payments.
4. No history: the toggle still saves, the amount is unknown and says why.
5. An estimated schedule is never auto-posted.
6. "The graph" is the Bills page Cash Flow Forecast chart.
7. One branch for the whole change.
