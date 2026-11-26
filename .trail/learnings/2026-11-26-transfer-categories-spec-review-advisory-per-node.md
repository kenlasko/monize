---
title: "Transfer categories spec review: advisory per-owner lock for the FIT backstop, and renames already wait on the FK"
author: Node
date: 2026-11-26
branch: claude/issue-2452
cost: { minutes: 12, tokens: 103246 }
touches:
  - docs/future-plans/transfer-categories-tasks.md
  - docs/future-plans/transfer-categories.md
  - docs/specs/transfer-categories.md
  - docs/system-invariants.md
---

## Decided
- The FIT backstop's serialization against a type change is proposed as an advisory lock per category owner (shared in every category write's first statement and again, re-entrantly, in the BEFORE trigger; exclusive in a type change or move), replacing the earlier FOR SHARE row lock. Measured cost is the same within noise (round 3: chunked +3% / single +1% medians; paired chunked 7.5% vs 5.9% for the row lock).
- The type backfill keeps each category's own is_income: mismatched children exist today, and re-typing them would move figures. INV-CATEGORY-003 is scoped to writes from PR 2 on.
- Settings that later get copied onto category rows (payee default, asset category, loan interest/fee, payroll deduction rule) must refuse a Transfer category in PR 2, or a PR-2-only release breaks saves and imports on the backstop.

## Tried and ruled out
- FOR SHARE on the category row in the trigger: every edit of the category row (colour, icon) waits for an open import, and a type change cascading over a subtree can deadlock with an import whatever the service does.
- Mapping SQLSTATE 23514 to 400 wholesale: it hides real CHECK violations (they mark defects as 500s). Map only the trigger's own constraint name.

## Watch out
- A category rename already waits today for any open write using the category: `name` is in UNIQUE(user_id, name, parent_id), so it is a key column and conflicts with the FK check's FOR KEY SHARE. A colour change does not wait.
- A budget names an account on at most one transfer line, outgoing or income (assertOneTransferLinePerAccount); worked examples must respect it.
- CategoriesService.update re-types only a moved category; its children keep their flag. The Money writer stores each category's own flag.
