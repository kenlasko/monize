---
title: "A payroll deduction rule keeps its figures per period, so next year's maximum is entered without touching this year's"
author: Ken
date: 2026-11-10
branch: feat/ux-batch-nov10
id: l-44eb7e98
scope: repo
status: active
src: agent
touches:
  - backend/src/backup/backup-format.ts
  - backend/src/backup/export-table-queries.ts
  - backend/src/backup/restore-plan.ts
  - backend/src/backup/restore-references.ts
  - backend/src/backup/restore-wipe.ts
  - backend/src/backup/support-backup/support-backup-integrity.ts
  - backend/src/backup/support-backup/support-backup-rules.ts
  - backend/src/payroll-deductions/dto/create-payroll-deduction-rule.dto.ts
  - backend/src/payroll-deductions/entities/payroll-deduction-rule-period.entity.ts
  - backend/src/payroll-deductions/entities/payroll-deduction-rule.entity.ts
---

## Decided
- Ken entered 2027's maximums in November and this year's room and report percentage moved, because a rule held one `yearly_maximum` read for every period. A rule's figures now live per period in `payroll_deduction_rule_periods` (rule_id, period_start, yearly_maximum, expected_per_paycheque). The period starting on P uses the row with the greatest period_start <= P, so a period without a row carries the previous one forward. A rule with no row at all falls back to its own columns.
- The rule's columns are kept as "the figures last entered for a current period" and are never a next period's. Old readers and rules created before the table keep working, and no backfill migration was needed.
- A closed period is "recorded" only when a row covers it. The report shows a closed period's maximum only when every rule on the category is recorded for it; otherwise it still says "Not recorded".
- PATCH: `yearlyMaximum`/`expectedPerPaycheque` upsert the current period's row plus the columns. `nextYearlyMaximum` upserts the row at the current `nextResetOn` (its expected amount defaults to the current entered one). `nextYearlyMaximum: null` deletes that row. Every refusal runs before the first write.
- The forecast refills a pool at the reset with the lowest `nextPeriod.yearlyMaximum`, and from the reset each bill spends `nextPeriod.expectedPerPaycheque`.

## Tried and ruled out
- Pending `next_*` columns on the rule: less code, but no history, and the report could never show a past year's maximum.
- A JSONB column of figures: money must be NUMERIC(24,8).

## Watch out
- Existing rules edited before this shipped have the NEXT year's figure in their columns. Re-edit them: put this year's figure under This period and next year's under Next period.
- The form's next-period fields open on their own inside the two-month reminder window, so a form test that does not pin `useFinancialToday` changes behaviour with the calendar. The next fields carry their own labels ("Next period's maximum") so `getByLabelText('Yearly maximum')` stays unique.
- A new user-owned table needs: the migration with its RLS enable and policy, `schema.sql` (table plus the direct_tables list), export-table-queries, restore-plan, restore-references, restore-wipe (an explicit DELETE, or restore-plan.spec fails), support-backup rules and integrity, backup-format, and frontend restore-labels.

In the code: backend/src/payroll-deductions/payroll-deduction-rule-periods.ts (figuresForPeriod), payroll-deduction-cap.ts (nextPeriod on the figures), frontend/src/lib/payroll-period.ts, frontend/src/lib/forecast.ts (DeductionPool.nextMaximum), docs/specs/payroll-deductions.md section 11.
