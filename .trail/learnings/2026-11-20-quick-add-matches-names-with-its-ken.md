---
title: "Quick Add matches names with its own reader, so punctuation is dropped from the names, never from the typed line"
author: Ken
date: 2026-11-20
branch: main
cost: { minutes: 5, tokens: 45693 }
id: l-4b3617f4
scope: repo
status: active
src: agent
touches:
  - backend/src/transactions/quick-add/quick-add-names.util.ts
  - backend/src/transactions/quick-add/quick-add-parse.util.spec.ts
  - backend/src/transactions/quick-add/quick-add-parse.util.ts
  - backend/src/transactions/quick-add/quick-add-text.util.ts
---

## Decided
Quick Add does not use the shared search helpers: its backend reader finds payee, category and account names inside the typed line with its own fold (case, NFKC, diacritics). To let "zehrs" find "Zehr's Supermarket", each payee name, plain alias and category name gets a second, punctuation-free phrase, and the partial payee match retries against punctuation-free names only when the names as written start nothing. The typed line's units are left as typed.

## Tried and ruled out
Stripping punctuation from the typed line (the unit folds): the amount, date and category-path steps read the same units, so "45.20" would fold to "4520", "11/20" would lose its separator and "Food: Groceries" its colon. Changing foldForComparison globally: it also folds wildcard aliases, and stripping "*" would break glob aliases.

## Watch out
A fix to the search helpers alone does not reach Quick Add; check both when matching rules change. Each extra phrase spends the per-reading span budget, so add variants only when they differ from the name. Accounts and a name stored without punctuation but typed with it ("Zehrs" typed as "zehr's") still do not match.

In the code:
- backend/src/transactions/quick-add/quick-add-text.util.ts withoutPunctuation
- quick-add-names.util.ts collectMatches (extra phrases, looseFoldedPayeeNames)
- quick-add-parse.util.ts partialPayee (refold parameter, second call as fallback)
