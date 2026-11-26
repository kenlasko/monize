---
title: "Transfer category type (discussion 2387): the maintainer's twelve product choices and what the code sweep found"
author: Ken
date: 2026-11-26
branch: main
cost: { minutes: 44, tokens: 179539 }
id: l-85bcf2d3
scope: repo
status: active
src: agent
touches:
  - docs/verification-contract.md
  - backend/src/accounts/account-balances-report.service.ts
  - backend/src/accounts/accounts.service.ts
  - backend/src/accounts/daily-balance-totals.service.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/backup/restore-legacy-normalizations.ts
  - backend/src/budgets/budget-spending.util.ts
  - backend/src/common/ledger-balance-sql.spec.ts
  - backend/src/common/ledger-balance.sql.ts
  - backend/src/common/provisional-count.util.ts
---

## Decided
Ken's answers on 2026-11-26, recorded in the plan (section 3):
- Strict both ways: a transfer takes only a Transfer category, an ordinary row or split category line only Income/Expense; conversion clears a wrong-type category.
- One category per same-owner transfer. The migration resolves a transfer whose two sides hold different categories by keeping the outgoing side's. Cross-owner transfers keep one category per owner, because a category belongs to one person.
- Migration copies used categories under a top-level "Transfer" parent and leaves originals untouched.
- Budgets: a line may name a Transfer category, the category line wins over a per-account transfer line, and income is shown as Actual Income / Transfer Funding / Total Budget Funding.
- Monthly Category Breakdown: categorized transfers under their Transfer category, the rest by account.
- Split transfer lines carry a category in the first release.
- Custom reports get Transfer categories in filters/groups plus Outgoing / Incoming / Net.
- Wire shape: new `type` field is the truth; `isIncome` stays as a read-only derived field.
- Default Transfer set for new users only. Rules may set a Transfer category on a transfer; payee default stays Income/Expense and off transfers.
- Delivery: phased PRs into one integration branch, one release.
- For the transfer category type (discussion 2387), Ken first chose an integration branch, then on 2026-11-26 chose PRs straight into main once it was clear the workers branch every sub-issue from main. No release is cut between the PR that starts refusing mismatched categories and the last PR.
- Ken wants few PRs: group a plan's tasks into PRs by area (six here), with the tasks as commits inside each, not one PR per task.
- Sub-issues were created and linked unqueued; Ken labels the tracker himself. Merging the specification PR is his approval for the rest, so no sub-issue carries the automerge label.

## Tried and ruled out
- Advisory-only or transfers-only strictness: leaves the ambiguity the discussion is about.
- Per-side transfer categories: a net by category would depend on the side looked at.
- Converting a transfer-only category in place, or same-name copies at top level with type in the unique key: Ken chose the copy under a parent as proposed.
- Replacing `isIncome` outright, or adding an `isTransfer` boolean: breaks external API/MCP clients, or leaves two flags every reader must test.
- Stopping budget category lines from counting transfers; a by-category/by-account switch on the breakdown; a second payee default.
- Telling each issue body to branch from and target an integration branch: nobody could confirm the worker script supports a base other than main (the cluster was not reachable from the session), so the sequence might stall.

## Watch out
- Before this work, the Monthly Category Breakdown excludes categorized transfers (`t.is_transfer = false`), although the transfer form hint, CreateTransferDto and the MCP tool text say the category makes them appear there.
- Before this work, the plain PATCH /transactions/:id, bulk update (deliberately, per its comment) and the assistant's categorize action write one side of a transfer only; no constraint keeps the sides equal.
- A budget category line counts whole-row transfers carrying that category (queryCategorySpending has no is_transfer filter), so the migration moves budget figures.
- Many readers use `!isIncome` to mean expense; a Transfer category would be counted as spending by any reader the sweep misses.
- QIF import puts the payee default category on a transfer's source side; the Money importer passes the row's category through on transfers.
- The plan's section 12 holds questions the maintainer was not asked, each with a default: parent name, budget line migration, database backstop, Money import, reversal, user notice.

In the code:
- docs/future-plans/transfer-categories.md, docs/future-plans/transfer-categories-tasks.md
- backend/src/built-in-reports/monthly-category-breakdown.service.ts, backend/src/budgets/budget-spending.util.ts, backend/src/transactions/transaction-bulk-update.service.ts, backend/src/transactions/transfer-leg-columns.ts
- database/schema.sql: chk_split_kind_exclusive, categories.is_income
- With every PR based on main the order is strictly sequential, so work planned as parallel (reports and budgets beside the write-path rules) becomes serial.
- A PR that makes the server refuse data existing rows still hold must keep reads working until the migration PR merges.

- docs/future-plans/transfer-categories.md (section 3, item 12), docs/future-plans/transfer-categories-tasks.md
- tracker #2451, sub-issues #2452 to #2457
