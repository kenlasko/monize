---
title: "is:provisional in the transaction search (issue 2393)"
author: Node
date: 2026-11-25
branch: claude/issue-2393
cost: { minutes: 6, tokens: 95731 }
touches:
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/es/transactions.json
  - frontend/src/i18n/messages/fr/transactions.json
  - frontend/src/i18n/messages/hi/transactions.json
  - frontend/src/i18n/messages/id/transactions.json
  - frontend/src/i18n/messages/it/transactions.json
  - frontend/src/i18n/messages/ja/transactions.json
  - frontend/src/i18n/messages/ko/transactions.json
  - frontend/src/i18n/messages/nl/transactions.json
  - frontend/src/i18n/messages/pl/transactions.json
---

## Decided
- The `is:` grammar lives in `transaction-search-query.util.ts` (`SEARCH_ENUM_VALUES`) and its SQL in `transaction-search.util.ts` (`enumCondition`); `transaction-search-parse.util.ts` only reads amounts and dates despite its name. `is:provisional` is `<alias>.amount_is_provisional = true`, never the description text; negation comes free from the `NOT COALESCE(...)` wrapper in `buildTransactionSearchWhere`.
- The frontend echo key is `transactions.searchInterpretation.enum.is.<value>`; a new `is:` value needs that key in every locale or the line shows a raw key. Wording "Estimated amounts" follows the plan's open question 1 default.
- Website pages telling readers to search the memo for PENDING IMPORT were left for B4/Q, since the importer still writes the note.

## Tried and ruled out
- Changing `SearchSyntaxHelp`: it lists one `is:split` example, not the values, so the issue's "if it lists the is: values" condition did not apply.

## Watch out
- The worktree had no node_modules; `npm ci` in backend and frontend first. Integration spec runs against `docker run mirror.gcr.io/library/postgres:18-alpine` with `POSTGRES_USER=monize_user POSTGRES_PASSWORD=monize_password` and `DATABASE_PORT` set; the schema is synchronized from entities.
- `trail check` flagged 6 keyword-overlap conflicts (importer/analytics learnings) on these files; none applied.
