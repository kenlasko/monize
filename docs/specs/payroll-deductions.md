# Payroll deductions (Tools, Taxes)

Specification of the first tool under the new **Taxes** section of the Tools
menu: a yearly maximum per deduction category on one payroll scheduled bill,
the year-to-date already paid to that category, and a cap that reduces the
bill's deduction line as the maximum is approached. Written from the
maintainer's request of 2026-10-26; the reference case is a Canadian
paycheque whose CPP and EI lines stop once the year's maximum is reached and
start again at the next year's figure.

## 1. Goal

- A **Taxes** entry in the Tools menu, a landing page listing the tax tools,
  and the first tool, **Payroll Deductions** (route `/taxes/payroll-deductions`).
- A **rule** names the payroll scheduled bill, one category of that bill, the
  yearly maximum deducted to that category, when the count resets (Yearly, on a
  chosen date, usually 1 January; the form defaults to the next one) and, only when the bill carries no line for
  the category, the amount expected per paycheque. The form creates the rules
  of one bill together: the bill and the reset are shared, each category row
  carries its own maximum, and the batch is one request (section 5.2).
- The form offers as the bill only an active, non-investment, non-transfer
  schedule whose amount is a net income (a paycheque pays in more than it
  takes out), and as categories only that bill's deduction lines: split lines
  with a category and a non-positive amount (`billDeductionCategoryIds`). The
  gross line is not a deduction; a zero line is one the bill stopped
  collecting, which a rule may resume. Creating, a bill that already has
  rules is not offered again (its rules are edited from the list), and a
  category the bill already has a rule for is not offered again; editing, the
  rule's own bill stays offered even when it no longer qualifies. When
  another bill already caps the category, an empty yearly maximum starts
  from that rule's figure, since the two share one room.
- When the bill **posts** (automatically or from the Post dialog), each
  deduction line of a category with a rule is reduced to what room is left
  under the maximum, down to zero. The parent amount follows.
- The **Cash Flow Forecast** (Bills page chart and the dashboard widget)
  projects the same reduction occurrence by occurrence, and the reset.
- The page offers a **year-to-date** table, collapsed by default: one row per
  category, currency and period (`groupYearToDateRows`), naming every bill
  that caps it, with the period, the amount paid so far, the maximum and the
  room left. Paid is category-wide, so two paycheques on one category over
  one period are one row; where their maxima differ the lower one binds, as
  in the forecast's pooled room.
- The page offers a **Previous Periods** table, collapsed by default and
  loaded when opened (`GET /payroll-deductions/history`): per ruled category
  and currency, what the category collected in each of its last five closed
  periods (`HISTORY_PERIODS`), newest first, the oldest empty ones dropped.
- Two months before a rule resets, a **notification** asks the user to confirm
  the next period's figures. Nothing changes if they do not: the rule keeps
  its values and resets on its date.
- A rule **never alters a posted transaction**. It is read when an occurrence
  is posted and when a projection is drawn; the ledger is only ever read.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| The payroll bill and its lines | `scheduled_transactions`, `scheduled_transaction_splits` | A paycheque is a split deposit: a positive gross line, negative deduction lines. |
| The posting path | `ScheduledTransactionsService.post` | Builds `transactionPayload.splits` under the schedule lock; the cap is applied there, before the occurrence claim and the write. |
| What was paid | `transactions`, `transaction_splits` | The year-to-date figure is the signed sum of the category's rows in the period, both unsplit rows and split lines, VOID excluded, the same rows `queryCategorySpending` counts. |
| The projection | `frontend/src/lib/forecast.ts` (`generateOccurrences`) | Both forecast surfaces share it, so one change reaches both. |
| The read model every surface loads | `ScheduledTransactionsService.findAll` | Carries the rules and the year-to-date figures as `payrollDeductions`, so the forecast needs no second fetch. |
| The reminder | `NotificationDispatchService.notify`, the PAYMENTS category | One row per rule per reset date through the dedupe key. |

## 3. Product decisions

1. **One rule per (bill, category).** A unique key holds it. A second rule
   for the same line would be two ceilings on one figure.
2. **The maximum is a magnitude.** `yearly_maximum >= 0`, in the bill's
   account currency. A deduction line is negative in the ledger; "paid" is the
   negation of the category's signed sum, so a refund row lowers it.
3. **The expected amount comes from the bill when it can.** When the bill
   has a split line for the category, that line's magnitude is the expected
   amount and the stored `expected_per_paycheque` is ignored. When it has no
   such line, the user must enter one; the projection uses it, and the posting
   has nothing to cap. `expectedSource` in the read model says which. The
   figure the form suggests for an entered amount is the magnitude the
   category's deduction rows most often carry over the last twelve months
   (`SUGGESTION_WINDOW_MONTHS`), ties to the more recently seen figure; the
   latest row alone is not it, because the last paycheque of a year is often
   capped or zeroed, and a longer window lets last year's rate outvote this
   year's. The form also suggests the **yearly maximum** from what the
   category has already collected, since a capped deduction stops exactly at
   its maximum (`estimateMaximum`): the current period's total when the
   bill's own postings show the deduction stopped (its latest posted
   paycheque in the period carries no deduction line for the category after
   one that did, `deductionStopped`); else the current period's total when
   it already exceeds the last full period's (a rate rose); else the last
   full period's total; nothing when nothing was collected. The form fills an
   empty box from it and says so; a typed figure is kept.
4. **Reset is Yearly, on a date.** `reset_date` is the anchor; a period runs
   from one anniversary of its month and day to the day before the next. The
   29th of February clamps to the 28th in a common year. The enumeration
   leaves room for other periods later (`reset_period` is checked against
   the list `YEARLY`).
5. **The cap is a ceiling, applied on every posting path.** Base splits,
   override splits and inline (Post dialog) splits are all capped: a category
   line with a rule is reduced to `-min(|line|, remaining)`. A line that is
   not a deduction (positive) is left alone. The cap never raises a figure.
6. **Year-to-date is category-wide in the bill's currency.** Rows of the
   category in any account count, in the period that contains the date asked
   about (today for the page and the read model; the posting date for a
   post). Rows in another currency are not converted: they are counted and
   reported as `foreignCurrencyRows`, and the paid figure is then a lower
   bound (the cap errs towards collecting, never towards skipping).
7. **Projection state starts from the server's figure.** The read model
   carries `remaining` as of today; the forecast walks each occurrence in
   order, spends the expected amount against the room left, and projects the
   occurrence at the template's amount, **less what the template already
   deducts for the category** (its line, or nothing when the figure was
   entered because the line is absent or zero), **plus what will be
   deducted**. So a bill whose line still deducts rises by what the room
   cannot cover, and a bill whose line was zeroed at this year's maximum
   stays where it is until the reset and drops by the deduction from the
   first paycheque after it. The room refills to the maximum when an
   occurrence falls on or after the next anniversary of `reset_date`
   (stepped from the anchor, so a leap-day anchor returns to the 29th as the
   server's `anniversaryInYear` does). An occurrence dated inside a closed
   period (an overdue paycheque from before the current period) neither
   spends the room nor changes: its ledger is written. An occurrence whose
   override states its own amount is projected as stated and still spends
   the expected amount. The Edit Occurrence dialog opens a payroll bill's
   occurrence on the same lines (`projectPayrollOccurrence`), so what it
   shows is what the forecast projects and the posting will cap to. **The room is one per category and currency,
   shared by every bill that names it** (`buildDeductionPools`): two
   paycheques deducting to the same category, a mid-month and a month-end,
   draw down one maximum, spent in date order across both bills and across
   every account, as the category-wide paid figure does on the server. Each
   bill spends its own expected figure. Where two rules on one category
   differ, the lower maximum, the lower remaining and the earlier reset bind:
   the projection errs towards collecting, as the posting cap does.
8. **The reminder opens two calendar months before the reset date** and is
   keyed on the rule and that reset date, so it fires once per period.
9. **The page is owner-only.** The Tools entry is hidden while acting as a
   delegate, and every route is owner-only by the global delegate guard's
   default.

## 4. Invariants

- **INV-PAYROLL-001 (a rule never writes the ledger).** The module reads
  `transactions` and `transaction_splits` and writes only
  `payroll_deduction_rules`; changing a rule changes no posted row. Held by
  the source guard `payroll-deductions.guard.spec.ts`.
- **INV-PAYROLL-002 (the cap is decided under the posting lock).** The
  year-to-date figure that caps a line is read inside the posting transaction
  after the schedule row is locked, on the same `EntityManager`, so a line is
  priced against the ledger as it stands when the occurrence is claimed.
- **INV-PAYROLL-003 (one surface, one answer).** The posting and the
  projection both reduce a line by `capDeductionLine` over the same
  `paid`/`remaining` definition (`payroll-deduction-cap.ts`); the forecast
  reads the server's `remaining` and never re-derives it from rows.
- **INV-PAYROLL-004 (one reminder per reset).** The notification's dedupe
  key is `pdr:reset:<ruleId>:<resetOn>`; `NotificationService.create` is
  `INSERT ... ON CONFLICT DO NOTHING`, so a second replica or a second day in
  the window writes nothing new.

## 5. Data contract

### 5.1 Table `payroll_deduction_rules`

```
id                       UUID PK
user_id                  UUID NOT NULL -> users ON DELETE CASCADE
scheduled_transaction_id UUID NOT NULL -> scheduled_transactions ON DELETE CASCADE
category_id              UUID NOT NULL -> categories ON DELETE CASCADE
yearly_maximum           NUMERIC(24,8) NOT NULL CHECK (>= 0)
reset_period             VARCHAR(20) NOT NULL DEFAULT 'YEARLY' CHECK (IN ('YEARLY'))
reset_date               DATE NOT NULL
expected_per_paycheque   NUMERIC(24,8) NULL CHECK (IS NULL OR >= 0)
created_at, updated_at   TIMESTAMPTZ
UNIQUE (scheduled_transaction_id, category_id)
```

Direct RLS policy on `user_id`. Exported in the portable backup after
`scheduled_transaction_splits`; every column `keep` in the support backup
(amounts `scale`).

### 5.2 Routes (`/payroll-deductions`, owner-only)

- `GET /` the user's rules with their figures as of today.
- `GET /suggest?scheduledTransactionId&categoryId[&resetDate]` the expected
  amount the bill's line gives, or the mode of the category's deduction rows
  over the last year when the bill has no line (decision 3), or `null`; with
  `resetDate`, also the yearly maximum the ledger suggests and its source
  (`previousPeriod`, `currentPeriod`, `currentPeriodCapped`, or `null`).
- `GET /history` per ruled category and currency, the collected total of
  each of the last `HISTORY_PERIODS` closed periods, newest first.
- `GET /report?year=` the Payroll Deductions report (section 10); `year` is
  a whole number from 1900 to 2100, the current year when absent.
- `POST /` one rule; `POST /batch` several categories of one bill sharing a
  reset, every ownership, duplicate and expected-amount check before the
  first `INSERT` in one `withScopedDb` transaction, so a refused line writes
  nothing (`PAYROLL_BATCH_MAX_LINES` lines at most); `PATCH /:id`,
  `DELETE /:id`.

### 5.3 Figures (`PayrollDeductionFigures`, on a rule and on the read model)

`periodStart`, `periodEnd`, `nextResetOn`, `paidToDate`, `remaining`,
`foreignCurrencyRows`, `currencyCode`, `expectedPerPaycheque` (null when
unknown), `expectedSource` (`line`, `entered`, `null`).

### 5.4 Notification

`NotificationType.PAYROLL_DEDUCTION_RESET_DUE`, category PAYMENTS, severity
INFO, data `{ ruleId, categoryName, scheduledTransactionName, resetOn,
yearlyMaximum, currencyCode }`, target `/taxes/payroll-deductions`.

### 5.5 Cron

`payroll-deduction-reset-reminder.service`, daily 06:23 UTC. Fan-out under
`withSystemContext` over every rule whose next reset falls within the next
two months plus one day; per user under `withUserContext`.

## 6. Truth tables

### A. Capping one line (`capDeductionLine(line, remaining)`)

| line | remaining | result |
|---|---|---|
| -300 | 1000 | -300 |
| -300 | 120 | -120 |
| -300 | 0 | 0 |
| -300 | -5 (over-collected) | 0 |
| 250 (not a deduction) | 0 | 250 |

### B. Period of a date (`reset_date` 2026-01-01)

| asOf | periodStart | periodEnd | nextResetOn |
|---|---|---|---|
| 2026-10-26 | 2026-01-01 | 2026-12-31 | 2027-01-01 |
| 2027-01-01 | 2027-01-01 | 2027-12-31 | 2028-01-01 |
| 2025-12-31 | 2025-01-01 | 2025-12-31 | 2026-01-01 |

`reset_date` 2024-02-29, asOf 2025-06-01: period 2025-02-28 to 2026-02-27.

### C. Reminder window (`reset_date` 2026-01-01, next reset 2027-01-01)

| today | due |
|---|---|
| 2026-10-31 | no |
| 2026-11-01 | yes, key `pdr:reset:<id>:2027-01-01` |
| 2026-12-31 | yes, same key (no new row) |
| 2027-01-01 | no (the next window is 2027-11-01) |

## 7. Numerical example

EI, maximum 1,077.48, expected 64.00 per biweekly paycheque, paid so far
1,024.00 on 2026-04-10. Next occurrence 2026-04-24: room 53.48, line
becomes -53.48, parent rises by 10.52. Occurrence 2026-05-08: room 0, line 0,
parent rises by 64.00. First occurrence of 2027: room 1,077.48 again.

## 8. Missing-data policy

- No line and no entered amount: the projection leaves the bill unchanged and
  the page marks the rule "expected amount needed"; posting caps nothing.
- Rows in another currency: counted in `foreignCurrencyRows`, excluded from
  `paidToDate`; the page says so beside the figure.
- The figures never carry `null` for `paidToDate`: an empty period is a known
  zero.

## 9. Test matrix

- Pure: `capDeductionLine` (table A), period bounds (table B, leap day),
  reminder window (table C), dedupe key.
- Service: create refuses a bill or category the user does not own, a
  duplicate, and a missing expected amount when the bill has no line; update
  and delete are scoped by user; the year-to-date query is shaped as section 3
  decision 6 says.
- Posting: a base-split post with a rule caps the line and re-sums the
  parent; a post with no rule is unchanged; a positive line is untouched.
- Cron: a rule inside the window writes once; outside it writes nothing;
  a lost insert sends nothing.
- Frontend: the forecast spends room, projects each occurrence at the
  template less its current line plus the deduction due (a zeroed line stays
  until the reset and then drops), refills on the anchor's anniversary (a
  leap-day anchor returns to the 29th), leaves a closed-period occurrence and
  a bill with no figure untouched, pools the room of two bills on one
  category in date order and across accounts, lets the lower ceiling bind,
  and answers one occurrence's lines for the Edit Occurrence dialog; the
  reminder skips an inactive bill; the nav link,
  the landing page and the Payroll Deductions page render, create several
  categories in one batch, edit, delete and expand the year-to-date table;
  the form offers only net-income bills and only the bill's deduction lines,
  less those already ruled.
- Batch: every line saved in one transaction; a refused later line (missing
  expected amount, repeated category) saves nothing.
- Suggestion: the mode of the last year's deduction rows, not the latest.

## 10. The Payroll Deductions report

A built-in report, **Payroll Deductions** under the Tax section of Reports
(route `/reports/payroll-deductions`), drawn from
`GET /payroll-deductions/report?year=` (owner-only, as every route here). It
reads the rules and the ledger and writes nothing (INV-PAYROLL-001).

1. **What a category is.** One entry per ruled category and currency, every
   bill that caps it named, as in the year-to-date table: paid is
   category-wide. Where two rules disagree the lower maximum binds, and the
   periods follow the earliest rule's reset date, as the history route does
   (`groupReportRules`).
2. **What a year is.** The selected year reports, for each category, the
   period that starts in that year on its reset date (`periodStartingIn`):
   the calendar year for a 1 January reset, July to June for a 1 July one.
   The year defaults to the current one; the picker offers every year a
   category's period starts in, the current year and the one asked for.
   Reportable years are 1900 to 2100 (`PAYROLL_REPORT_MIN_YEAR`,
   `PAYROLL_REPORT_MAX_YEAR`), which the route accepts; the ledger is read
   only inside them and a period starting before 1900 is not offered, since
   a transaction date carries no such bound.
3. **The rows.** Every figure is a sum over `CATEGORY_DEDUCTION_ROWS_SQL`,
   the rows "paid" sums (decision 6), grouped per transaction: one query per
   category over the whole ledger (`queryDeductionTransactions`), bucketed
   into periods on the server. So the current period's paid figure is the
   page's and the one the next posting caps against (INV-PAYROLL-003). Rows
   in another currency are counted per period as `foreignCurrencyRows` and
   left out of the sums.
4. **Summary.** Per category, for the selected year: period, paid, maximum,
   remaining, paid as a percentage of the maximum, paycheques (transactions
   with a row in the currency), the average per paycheque, and the date of
   the paycheque that brought the total to the maximum. A rule stores only
   the maximum it caps with now, so the maximum, the remaining room, the
   percentage and the date are `null` for a period that has closed, and the
   report says "Not recorded" rather than measuring last year against this
   year's figure.
5. **Paycheque by paycheque.** One row per transaction that deducted to a
   reported category in its selected period, oldest first, one column per
   category (with its currency when the report spans more than one), the
   row's total in the transaction's currency. Each column counts only its
   category's own period and currency, so an absent amount is one of three
   things (`paychequeCell`): a counted paycheque with no line for the
   category, a known zero; a paycheque outside that category's period (its
   reset date differs), "Outside its period"; or one in another currency,
   "Other currency". The CSV leaves the last two empty. The footer is each category's paid figure;
   the grand total is `null` when the categories are in more than one
   currency, and the cell says they are not added together.
6. **Every year on record.** One table per category, never merged: every
   period from the latest holding a row (or the current one, if later) back
   to the earliest holding a row, empty periods between them included as
   known zeros, newest first, with paycheques, paid and the average.
7. **No rules.** The report says so and links to the Payroll Deductions page.

Tests: `payroll-deduction-report.spec.ts` (grouping, period mapping, the
history range, the closed-period maximum, the maximum-reached date, the
cross-currency total, money summed without float drift),
`PayrollDeductionsReport.test.tsx` (the three sections, the year picker,
the empty and error states, the CSV export).
