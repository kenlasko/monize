---
title: "Payee, category and tag name search ignores case and punctuation, matched in code rather than in SQL"
author: Ken
date: 2026-11-20
branch: main
cost: { minutes: 20, tokens: 105578 }
id: l-02c9e7d9
scope: repo
status: active
src: agent
touches:
  - backend/src/categories/categories.service.spec.ts
  - backend/src/categories/categories.service.ts
  - backend/src/common/helpers/search-match.spec.ts
  - backend/src/common/helpers/search-match.ts
  - backend/src/payees/payees.service.spec.ts
  - backend/src/payees/payees.service.ts
  - backend/src/tags/tags.service.ts
  - frontend/src/app/categories/page.tsx
  - frontend/src/app/payees/page.tsx
  - frontend/src/app/tags/page.tsx
---

## Decided
Name lookups for payees, categories and tags (frontend pickers and list filters, the AI assistant and MCP filters, the payee search and autocomplete endpoints) lower-case and strip punctuation and symbols from both the name and the query, keeping spaces. "zehrs" finds "Zehr's Supermarket". A query of only punctuation falls back to a plain lower-cased match so it does not match everything.

## Tried and ruled out
Doing it in SQL with regexp_replace(lower(name), '[[:punct:]]', '', 'g'): Postgres [[:punct:]] depends on the database locale and does not line up with JavaScript's \p{P}\p{S}, so curly apostrophes and symbols would match differently on the server than in the pickers. The payee endpoints now filter the user's active payees in memory instead; a personal payee list is small enough. If it ever is not, add a stored normalized-name column rather than a second regex.

## Watch out
There are two copies of the rule, one per layer, and they must stay identical. The old SQL LIKE was case-sensitive in Postgres, so an endpoint test asserting a case-sensitive miss would be asserting the old defect.

In the code:
- frontend/src/lib/helpers/search-match.ts and backend/src/common/helpers/search-match.ts (searchIncludes, searchStartsWith, normalizeForSearch)
- PayeesService.search / autocomplete use findActiveWithCategory then filter and slice
- Transaction free-text search (transaction-search.util.ts, ILIKE) was deliberately left literal
