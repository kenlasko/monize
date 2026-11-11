---
title: Custom bill schedules plug into the steppers only; the pattern snaps forward from the next due date
author: Ken
date: 2026-11-11
branch: feat/custom-recurrence
id: l-31471421
scope: repo
status: active
src: agent
touches:
  - docs/specs/custom-recurrence.md
  - backend/src/common/custom-recurrence.ts
  - frontend/src/lib/custom-recurrence.ts
  - backend/src/scheduled-transactions/custom-recurrence-write.ts
  - frontend/src/lib/calendar-month.ts
  - frontend/src/lib/frequency.ts
  - backend/src/common/ymd-calendar.ts
---

## Decided
- Overrides, skip, post and the occurrence picker all key on recurrence slots (override identity is the original date), so a Custom frequency needed only the two steppers (backend and frontend) to learn the rule. No per-occurrence code changed.
- When a Custom schedule's next due date is off the pattern, it snaps to the first rule date ON OR AFTER the next due date, with interval periods counted from the start date. Snapping to the first date after the start date was dropped because it puts an existing schedule back in the past.
- No CHECK constraint ties frequency to the rule column in this release: an expanding migration must not add one while previous-release pods still write rows. The service enforces the pairing, and a later contract migration can add the CHECK.
- Custom is refused for loan/mortgage payment schedules, payroll schedules, and split schedules that transfer into a loan-like account (installment pricing assumes 12 periods a year). The frontend hides it only for the first two; the server refuses the third.
- Defaults Ken accepted: the interval ships; editing the pattern deletes future overrides that no longer fit, after a form warning; no "Nth weekday" rules.

## Watch out
- The backend duplicate-functions guard scans frontend files too. A local `daysInMonth` or YMD formatter in a new frontend lib file fails it; reuse the shared helpers.
- A CUSTOM row with no valid rule throws in every walker by design. Any cross-user fan-out (for example bill reminders) needs per-row isolation.

In the code:
- spec: docs/specs/custom-recurrence.md
- engine: backend/src/common/custom-recurrence.ts, mirrored in frontend/src/lib/custom-recurrence.ts
- write rules: backend/src/scheduled-transactions/custom-recurrence-write.ts (snapToCustomPattern, orphanedOverrides, assertCustomFrequencyAllowed)
- shared helpers for the guard: frontend/src/lib/calendar-month.ts daysInMonth, frontend/src/lib/frequency.ts localYmd; backend/src/common/ymd-calendar.ts
