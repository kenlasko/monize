---
title: New schedule-from-transaction defaults Next Due Date to template date + 1 month
author: Node
date: 2026-11-12
branch: claude/issue-2133
cost: { minutes: 7, tokens: 102160 }
touches:
  - frontend/src/components/scheduled-transactions/ScheduledTransactionForm.test.tsx
  - frontend/src/components/scheduled-transactions/ScheduledTransactionForm.tsx
  - frontend/src/lib/frequency.ts
---

## Decided
Issue #2133: right-click "Schedule as Recurring" on a transaction opened ScheduledTransactionForm with templateTransaction set, but the Next Due Date default ignored the transaction's own date and used today's date (getLocalDateString()) instead. Fixed by stepping templateTransaction.transactionDate forward by the default frequency (MONTHLY) via the existing `advanceByFrequency` (frontend/src/lib/frequency.ts) — the one place the frontend steps a recurrence forward, already used by the cash-flow forecast, occurrence picker, bills calendar and upcoming-bills report. Falls back to getLocalDateString() when transactionDate is absent (defensive only; real Transaction rows always carry it, but several existing template test fixtures omit it).

## Tried and ruled out
Nothing ruled out here; advanceByFrequency was an exact match for "transaction date + the schedule's step", so no custom addMonths helper was needed.

## Watch out
Any future default frequency on the templateTransaction branch (currently hardcoded to 'MONTHLY') should keep using advanceByFrequency(date, frequency) rather than a literal one-month add, so the two stay in sync.
