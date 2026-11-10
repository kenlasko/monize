---
title: "A payroll deduction rule keeps its figures per period, so next year's maximum is entered without touching this year's"
author: Ken
date: 2026-11-10
branch: feat/ux-batch-nov10
id: l-2677776d
scope: repo
status: active
replaces: l-44eb7e98
src: agent
touches:
  - backend/src/backup/backup-format.ts
  - backend/src/backup/export-table-queries.ts
  - backend/src/backup/restore-plan.ts
  - backend/src/backup/restore-references.ts
  - backend/src/backup/restore-wipe.ts
  - backend/src/backup/support-backup/support-backup-integrity.ts
  - backend/src/backup/support-backup/support-backup-rules.ts
  - backend/src/payroll-deductions/dto/create-payroll-deduction-rule.dto.spec.ts
  - backend/src/payroll-deductions/dto/create-payroll-deduction-rule.dto.ts
  - backend/src/payroll-deductions/entities/payroll-deduction-rule-period.entity.ts
---

## Decided
- Ken entered 2027's maximums in November and this year's room and report percentage moved: a rule held one `yearly_maximum` for every period. Figures now live per period in `payroll_deduction_rule_periods`. The period starting on P uses the row with the greatest period_start <= P; a rule with no such row reads its own columns. No backfill was done.
- Every edit writes the current period's row and both columns as one pair. An empty next field means "this period's figure". Clearing both deletes every row after the current period's start. A changed reset date moves the current and next figures onto the new anniversaries.
- The forecast refills at the reset with the lowest next maximum, and projects a rule whose expected amount is positive in either period.

## Tried and ruled out
- Pending `next_*` columns on the rule: no history, and the report could never show a past year's maximum.

## Watch out
- Rules edited before this shipped hold next year's figure in their columns; re-edit them.
- The form's next fields open on their own inside the two-month reminder window, so a form test must pin `useFinancialToday`.
- `""` passes `@ValidateIf` untouched; the nullable money fields carry `@Transform(emptyAsNull)`.

In the code: backend/src/payroll-deductions/payroll-deduction-rule-periods.ts, payroll-deductions.service.ts (nextPeriodFigures), frontend/src/lib/payroll-period.ts, docs/specs/payroll-deductions.md section 11.
