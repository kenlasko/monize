# Custom recurrence on scheduled transactions

Specification of the **Custom** frequency on a scheduled transaction: a schedule
that repeats on chosen weekdays, chosen days of the month, or chosen dates of
the year, optionally every N weeks, months or years. Agreed with the maintainer
on 2026-11-11; the answers to the open questions are restated in section 8 so
this document stands alone.

## 1. Goal

- The frequency selector of the New/Edit Scheduled Transaction form offers
  **Custom** after Every 2 years, in every mode that offers a frequency
  (transaction, split, transfer, investment).
- Choosing it reveals an editor: Weekly / Monthly / Yearly, an "Every N" box
  (1-12), and the day picker for the unit: weekday buttons, a 1-31 grid plus
  **Last day**, or a list of month-day dates. The form shows the first
  occurrence and a plain-language summary ("Every week on Mon, Wed and Fri").
- Every occurrence the rule produces is an ordinary slot. Overrides, skip, post,
  move, the occurrence picker, estimates, reminders, auto-post, the calendar,
  the cash-flow forecast and every report read Custom slots through the same
  code they read any other slot through. Nothing about editing one occurrence is
  new.

## 2. Storage

- `scheduled_transactions.frequency` takes the new value `'CUSTOM'` (the
  column is `varchar(20)`).
- New nullable column `scheduled_transactions.custom_recurrence jsonb`. It holds
  the canonical rule when `frequency = 'CUSTOM'` and is `NULL` otherwise. The
  service enforces the pairing on every write (create, update, import, restore).
  A CHECK constraint is left to a later contract migration, as
  `docs/database-migrations.md` requires of an expanding release.

The canonical rule (`CustomRecurrence`, `backend/src/common/custom-recurrence.ts`,
mirrored in `frontend/src/lib/custom-recurrence.ts`):

```json
{ "unit": "WEEK",  "interval": 1, "weekdays": [1, 3, 5], "weekStartsOn": 1 }
{ "unit": "MONTH", "interval": 1, "monthDays": [5, 20, -1] }
{ "unit": "YEAR",  "interval": 1, "dates": ["02-01", "06-01", "10-01"] }
```

| Field | Rule |
| --- | --- |
| `unit` | `WEEK`, `MONTH` or `YEAR` |
| `interval` | integer 1-12 |
| `weekdays` | WEEK only. ISO weekdays, 1 = Monday ... 7 = Sunday; 1-7 entries |
| `weekStartsOn` | WEEK only. 0 = Sunday ... 6 = Saturday, the user's week-start preference when the rule was saved. Decides where a week begins when `interval > 1`; default 1 |
| `monthDays` | MONTH only. 1-31, or -1 for the last day; 1-32 entries |
| `dates` | YEAR only. `MM-DD`, a day that exists in a leap year (`02-29` allowed); 1-366 entries |

Canonical form: only the unit's own field is present, arrays are de-duplicated
and sorted ascending (`-1` sorts last in `monthDays`). `normalizeCustomRecurrence`
returns the canonical rule or the reason the input is invalid; both the DTO
validator and the stepper call it, so a rule the API accepted is one the
stepper can walk.

## 3. Stepping

`nextCustomDate(ymd, rule, startDate)` is the first rule date **strictly after**
`ymd`; `customDateOnOrAfter(ymd, rule, startDate)` is `ymd` itself when it is a
rule date, else the first one after it (the snap of section 5). Both exist in
both layers and throw on an invalid rule.
`calculateNextDueDate(ymd, "CUSTOM", anchorDay, custom)` dispatches to the
former, where `custom = { rule, startDate }`. In the backend, a walk over many
slots takes `customStepper(rule, startDate)`, which normalizes the rule once
and steps without normalizing again; `expandOccurrenceSlots` uses it.

- **Periods.** The interval counts periods from the one containing `startDate`:
  the week (beginning on `weekStartsOn`), the calendar month or the calendar
  year. A period whose distance from it is a multiple of `interval` is active.
- **Short months.** A day of the month past the month's end falls on its last
  day, as `MONTHLY` already clamps (31 becomes 30 April, 28 or 29 February).
- **Collisions.** Days that resolve to the same date produce one occurrence:
  30 and 31 in February are one slot on the 28th.
- **Last day.** `-1` is the month's last day, separate from 31.
- **29 February** falls on 28 February in a common year.
- **Off-pattern cursor.** A `next_due_date` the user moved off the pattern
  steps to the next rule date after it, so the pattern resumes.
- `anchorDay` is ignored for `CUSTOM`.

Without a rule, a `CUSTOM` step throws: a schedule that cannot step is a defect,
and silently returning the same date would loop every walker until its guard.
`calculateNextDueDate` and the schedule cursor keep throwing, so posting or
skipping such a row refuses. The backend expander (`expandOccurrenceSlots`)
does not: it yields the row's cursor slot alone, as if the schedule were
one-time, and logs a warning naming the schedule id, so one broken row cannot
take a user's forecast or a cross-user cron down. The bill-reminder fan-out also
isolates each bill and each user (`docs/backend/cron-and-background-work.md`).
The loan calendar's `scheduleCadenceMatchesLoan` answers `false` for `CUSTOM`,
which the settlement plan reports as its `scheduleCalendar` refusal; the loan
pricing and fee paths still throw (`assertFixedCadence`), because pricing a
Custom row at a guessed cadence would be wrong silently.

## 4. Cadence figures

- `FREQUENCY_CYCLE_DAYS.CUSTOM` and `OCCURRENCES_PER_YEAR.CUSTOM` are `0`: there
  is no fixed cycle. Callers that need a figure call the rule-aware helpers.
- `customOccurrencesPerYear(rule)` (both layers): distinct dates per year over
  `interval`. A weekly rule is `weekdays.length * 365.25 / 7 / interval`
  (weekdays cannot collide). A monthly or yearly rule counts the distinct dates
  it produces in 2024-2027, four calendar years including a leap year, divided
  by 4 and by `interval`: days that land on one date are one occurrence. So
  `[31, -1]` is 12 a year, `[30, 31]` 19, `[29, 30, 31]` 30 (every year,
  leap or not), and the dates `["02-28", "02-29"]` 1.25.
  `monthlyEquivalent` uses it on the bills page and in the recurring-expenses
  report.
- `customMinGapDays(rule)` (backend only): the shortest gap between
  consecutive rule dates, walked over four years, memoized per canonical rule.
  The trade-match window (`tradeScheduleWindowDays`) uses it in place of the
  mean, so a Monday and Tuesday schedule gets a zero-day window rather than a
  three-day one that would match the wrong occurrence.

## 5. Writes

- **Create.** `custom_recurrence` is required when frequency is `CUSTOM` and
  refused otherwise. A `next_due_date` that does not fall on the pattern is
  snapped to the first rule date on or after it, periods counted from
  `start_date`. The form shows that date as "First occurrence" under Next Due
  Date (it has no separate start-date field).
- **Update.** Changing away from `CUSTOM` clears the rule. Changing the rule,
  or `start_date` while Custom, re-snaps `next_due_date` the same way: forward
  from the current `next_due_date`, never back to the start date. The pairing,
  the snap and the prune below are decided from the row read under the
  update's row lock (`resolvePatternUpdate`), and whenever the request writes
  `frequency` it writes `custom_recurrence` with it, so no interleaving of two
  edits leaves `CUSTOM` without a rule or a rule beside another frequency.
- **Edited occurrences that no longer fit.** The pattern changed when the
  frequency, the rule or `start_date` changed, for any frequency: a month-based
  step reads its day from the start date (`anchorDayOf`), so a new start can
  orphan a month-end override. Then, in the same transaction as the update:
  - the candidates are the overrides with
    `original_date >= min(stored next_due_date, new next_due_date)`;
  - a candidate is an orphan when its `original_date` is not a slot of the new
    schedule walked from the new `next_due_date` (through the last candidate,
    at most `OCCURRENCE_WALK_GUARD` steps), so one the new cursor left behind is
    an orphan too;
  - a candidate beyond a walk the guard cut short is kept: nothing proved it
    orphaned.

  Orphans are deleted. Overrides are keyed on the slot
  (`uq_sched_txn_overrides_occurrence`), so an orphan is one no surface can
  reach. The form names them before saving, by the same rule.
- **Undo and redo.** An undo or redo of a schedule's create, update or delete
  writes `frequency` and `custom_recurrence` back as a pair
  (`withPairedScheduleRecurrence`): a `CUSTOM` snapshot with its canonical
  rule, any other frequency with `NULL`. A `CUSTOM` snapshot without a valid
  rule is refused with a translated message before anything is written.
  **Limitation:** undo does not restore overrides. An update that pruned
  orphaned overrides, undone, puts the old pattern back without them, and
  overrides added under the new pattern stay even where the old one no longer
  holds their slot. This is the existing behaviour of every override prune: a
  deleted schedule's overrides go with it (`ON DELETE CASCADE`) and its undo
  reinserts the schedule alone, and the overrides a post or skip consumes are
  not restored by undoing it either. A history that carries overrides is a
  separate change.
- **Payroll rules.** A deduction rule's create and update lock the bill row
  (`FOR UPDATE`, the lock the schedule update takes first) before reading its
  frequency, so a concurrent switch to `CUSTOM` and a new rule cannot both
  commit: whichever takes the lock second sees the other and refuses.
- **Not offered** for a loan or mortgage payment schedule or a payroll schedule;
  amortisation and deduction pooling assume a fixed cadence. The API refuses it
  there with a translated message.

## 6. Display

`describeCustomRecurrence(rule, locale)` writes the summary with `Intl` weekday
and month names. The bills list, calendar and every other surface that labels a
frequency show it for a Custom schedule instead of the word "Custom".

## 7. Test matrix

Both layers' specs cover the same cases:

| Rule | From | Next |
| --- | --- | --- |
| WEEK 1 [1,3,5] | 2026-11-11 (Wed) | 2026-11-13 |
| WEEK 1 [1,3,5] | 2026-11-13 (Fri) | 2026-11-16 |
| WEEK 2 [2,4] start 2026-11-11, weekStartsOn 1 | 2026-11-12 | 2026-11-24 |
| MONTH 1 [5,20,-1] | 2026-11-20 | 2026-11-30 |
| MONTH 1 [30,31] | 2027-01-31 | 2027-02-28 |
| MONTH 1 [30,31] | 2027-02-28 | 2027-03-30 |
| MONTH 3 [15] start 2026-11-15 | 2026-11-15 | 2027-02-15 |
| YEAR 1 [02-29] | 2026-03-01 | 2027-02-28 |
| YEAR 1 [02-29] | 2027-02-28 | 2028-02-29 |
| YEAR 2 [06-01] start 2026-01-10 | 2026-06-01 | 2028-06-01 |

## 8. Decisions

1. Orphaned future overrides are deleted when the pattern changes, and the form
   warns first (section 5).
2. The interval ships now.
3. Payroll and loan schedules cannot be Custom in this release.
4. "Nth weekday of a month" rules are out of scope.
