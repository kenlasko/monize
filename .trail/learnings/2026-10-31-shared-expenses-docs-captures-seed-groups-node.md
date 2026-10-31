---
title: Shared Expenses docs captures seed groups idempotently by name
author: Node
date: 2026-10-31
branch: claude/issue-1960
cost: { minutes: 11, tokens: 198434 }
touches:
  - e2e/docs-screenshots/shared-expenses.spec.ts
  - website/docs/search-index.json
  - website/docs/shared-expenses.html
  - website/docs/shared-expenses.md
  - e2e/tests/shared-expenses-tour.spec.ts
  - frontend/src/i18n/messages/en/navigation.json
  - frontend/src/i18n/messages/en/tours.json
  - frontend/src/i18n/messages/id/navigation.json
  - frontend/src/i18n/messages/id/tours.json
  - frontend/src/i18n/messages/tr/navigation.json
---

## Decided
- e2e/docs-screenshots/shared-expenses.spec.ts seeds two groups ("Lake cabin weekend", "Apartment bills") in beforeAll, looked up by name among active groups and created only when missing (the warranties.spec.ts pattern). Per-test group creation duplicated "Mountain trip" in the overview across the dark and light runs.
- Archived groups still count in the overview's Owed to You / You Owe (shared-summary.ts), so archiving test groups would not hide them from the overview picture.

## Watch out
- A new shared entry's expectedRevision is 0 (the entry's own revision); a REPAYMENT also needs expectedGroupRevision = group.financialRevision and empty shares/contributions, and is refused above the suggested amount unless acknowledgeOverpayment.
- The Tools menu label is "Shared Expenses" (title case), the tour's name in Guided tours stays "Shared expenses"; e2e selectors use both.
