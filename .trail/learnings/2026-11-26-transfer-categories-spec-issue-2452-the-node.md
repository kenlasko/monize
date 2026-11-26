---
title: "Transfer categories spec (issue 2452): the DB backstop shape, the funding split and the breakdown rows"
author: Node
date: 2026-11-26
branch: claude/issue-2452
cost: { minutes: 30, tokens: 268504 }
touches:
  - docs/future-plans/transfer-categories-tasks.md
  - docs/specs/transfer-categories.md
  - docs/system-invariants.md
  - docs/future-plans/transfer-categories.md
  - docs/verification-contract.md
---

## Decided
- The FIT backstop is a BEFORE row trigger that locks the category FOR SHARE, not a constraint trigger. Measured on PostgreSQL 18.7 (50,000-row chunked insert, 5,000 single-row inserts): BEFORE+lock ~+2% / +8%; a constraint trigger made correct (re-read the row, lock the category) ~+24% / +27%. It ships with the type in PR 2 so no release between PR 2 and PR 3 lets an ordinary row take a Transfer category.
- Budget funding is split by line, not by row: Actual Income = income lines on Income/Expense categories; Transfer Funding = transfer income lines + Transfer-category income lines + the transfersInAsIncome toggle; their sum is today's totalIncome / actual_income. The overlap rule applies only to Transfer categories.
- The breakdown gives a Transfer category an outgoing and an incoming row: a single net row reads zero whenever both accounts are in scope, which defeats issue 740.
- A transfer measure in a custom report reads transfer legs only; saved reports (no measure) are unchanged.

## Tried and ruled out
- A FIT check with no lock on the category: a type change and a row write both pass on their own snapshots. The FK's FOR KEY SHARE does not conflict with an update of a non-key column.
- Mixing a NET transfer measure with direction-judged category cells in one group: signed and unsigned figures in one sum.

## Watch out
- transactions.is_transfer, scheduled_transactions.is_transfer and categories.is_income are nullable: a WHEN of `NOT NEW.is_transfer` skips NULL rows; use IS NOT TRUE.
- UPDATE OF col fires whenever col is in the SET list, even unchanged; compare OLD and NEW in the WHEN.
- A budget line on an Expense category and a per-account transfer line both count a transfer holding that category, today and after.
- Category detail drops every split transfer line today; grouped totals drop them too. Both need the line once it can hold a category (PR 4).
- The deleted-split undo restore names no `kind` (reported by the sweep, not reproduced).
