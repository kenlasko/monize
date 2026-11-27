---
title: Transactions calendar month and register date range follow each other at the switch (issue 2473)
author: Node
date: 2026-11-27
branch: claude/issue-2473
cost: { minutes: 14, tokens: 125125 }
touches:
  - docs/specs/calendar-view.md
  - website/docs/search-index.json
  - website/docs/transactions.html
  - website/docs/transactions.md
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/calendar/TransactionsCalendarView.test.tsx
  - frontend/src/components/calendar/TransactionsCalendarView.tsx
  - frontend/src/hooks/useRegisterCalendarMonth.test.ts
  - frontend/src/hooks/useRegisterCalendarMonth.ts
---

## Decided
- The calendar opens on monthForDateRange(start, end, today): today's month clamped into the register's range (one-month range -> that month, no range -> today's). Lives in frontend/src/lib/calendar-month.ts with monthDateRange.
- The page holds the month (useRegisterCalendarMonth); TransactionsCalendarView takes optional `month` / `onMonthChange` and keeps its own state when uncontrolled (the investments and bills calendars and the view's own tests use it that way).
- The range is written only on the switch back to Table (handleViewChange in app/transactions/page.tsx), and only when the reader turned the calendar off the month it opened on, so an untouched round trip refetches nothing.

## Tried and ruled out
- Writing the range on every calendar month turn: it would refetch the chart above and the hidden register, and push a URL entry per arrow click.

## Watch out
- page.test.tsx's Table / Calendar test leaves the date range in localStorage (transactions.filter.startDate/endDate/timePeriod); it removes those keys at the end or the next tests open filtered.
- The dynamic() mock in page.test.tsx renders the calendar as `dynamic-component` with `data-month` and a "Turn to February 2025" button.
