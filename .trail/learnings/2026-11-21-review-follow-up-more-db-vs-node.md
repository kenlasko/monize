---
title: "Review follow-up: more DB-vs-API length-cap mismatches found by a second pass"
author: Node
date: 2026-11-21
branch: claude/issue-2314
cost: { minutes: 7, tokens: 73107 }
touches:
  - backend/src/bonds/dto/fetch-bond-series.dto.ts
  - backend/src/common/validators/is-number-locale.validator.ts
  - backend/src/investment-reports/dto/create-investment-report.dto.ts
  - backend/src/reports/dto/create-custom-report.dto.ts
  - backend/src/shared-expenses/dto/shared-finance.dto.ts
  - backend/src/users/dto/update-preferences.dto.spec.ts
  - backend/src/payees/dto/create-payee.dto.spec.ts
  - backend/src/accounts/dto/create-account.dto.ts
  - backend/src/accounts/dto/update-account.dto.ts
  - backend/src/ai/query/tool-input-schemas.ts
---

## Decided
A second (reviewer) pass over issue #2314 found three more real mismatches the first audit missed, all fixed the same way (DB as master):
- `custom_reports.name`/`investment_reports.name` are both `VARCHAR(255)` (database/schema.sql) but `CreateCustomReportDto.name`/`CreateInvestmentReportDto.name` were `MaxLength(100)` -- widened to 255.
- `EnableSharedFinanceDto.accountName` (shared-finance.dto.ts) was `@Length(1, 120)` but `SharedFinanceService.enableFinance` inserts it straight into `accounts.name VARCHAR(255)` via a raw INSERT -- widened to 255. This is the same column `create-account.dto.ts`/`update-account.dto.ts` already got right in the first pass; a raw-SQL write path duplicating a DTO's column assumption is easy to miss by grepping only `*.dto.ts` files.
- `FetchBondSeriesDto.seriesCode` (MaxLength 16) vs `bond_instruments.series_code VARCHAR(40)`: reviewed and left alone -- 16 is a deliberate bound on the two supported adapters' official code formats (PL's ~7-char codes, the US's 9-char CUSIP), not a copy of the column's generic ceiling. Added a one-line comment saying so, since the PR's premise ("DB is master") makes an unexplained narrower cap look like an oversight even when it isn't.
Also added DTO-level boundary tests the first pass skipped: `create-payee.dto.spec.ts` (255/256, new file -- there was no existing spec for this DTO), and a `user_preferences` length-cap describe block in the existing `update-preferences.dto.spec.ts` for the three fields the first pass *tightened* (dateFormat/numberFormat 20, timezone 50) -- numberFormat also carries `@IsNumberLocale`, so its boundary value has to be a syntactically valid BCP 47 tag (built from private-use subtags to hit an exact length), not an arbitrary repeated character.

## Tried and ruled out
Widening every `*.dto.ts` `MaxLength(100)` across the whole repo in one more sweep: the first pass's lookup-by-name-filter exclusion (list_accounts/list_transactions filter arguments) still holds and is correct; the misses here were specifically a raw-SQL write path outside any DTO's normal grep pattern, and two genuine DTO entities (custom/investment reports) the original Explore-agent sweep's entity list (payees/categories/accounts/tags/transactions/scheduled_transactions/securities/institutions/budgets/currencies/users/warranties/email_receipt_mailboxes/delegation/emergency_access/bank_sync/loan_fees) simply did not include.

## Watch out
`trail check` on this follow-up flags 14 conflicts, all lexical false positives against my own first-pass learning (`2026-11-21-payee-and-transaction-name-caps-widened-node.md`) matching on shared numbers ("255", "100") and phrases ("left cap", "typed line") rather than shared subject matter -- same pattern as the first pass, not a new class of problem. If a reviewer pass finds yet more misses in this area, check for raw SQL `INSERT`/`UPDATE` statements against `accounts`/`payees`/`categories`/`transactions` outside the `*.dto.ts` files before calling a sweep complete -- `grep` for the table name in `.service.ts` files, not just the DTOs.
