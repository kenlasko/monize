---
title: An importer maps every source feature that has a home in Monize; payee matching rules from KMyMoney become payee aliases
author: Ken
date: 2026-11-18
branch: feat/kmymoney-import
cost: { minutes: 39, tokens: 82334 }
id: l-9c0b88d4
scope: repo
status: active
src: agent
touches:
  - docs/future-plans/kmymoney-import-tasks.md
  - docs/future-plans/kmymoney-import.md
  - docs/kmymoney-data-model.md
  - docs/specs/kmymoney-import.md
  - README.md
  - backend/src/import/kmy/README.md
  - docs/system-invariants.md
  - frontend/src/lib/docs-links.ts
  - website/assets/js/app.js
  - website/docs/accounts.html
---

## Decided
When designing the KMyMoney importer, the first design listed payee matching rules, payee default categories and payee details as "not imported". Ken overruled that: if a source feature can be mapped onto something Monize already has, map it; "not imported" is only for things with no home at all (budgets, reports, cost centers, VAT) or sensitive data (account numbers, online-banking settings).

KMyMoney payee matching rules map to Monize payee aliases; the default category goes to the payee's default category; notes, email, address and phone go to the payee's existing columns. No migration was needed.

## Tried and ruled out
- Dropping matching rules because KMyMoney keys are regular expressions and Monize aliases only support `*`: rejected. Translate the keys that are exactly expressible (anchors at the ends, literal text, `.*`) and skip only the individual keys that are not, each with a warning naming the payee and the key.
- Transaction rules as the receiver instead of aliases: rejected in the spec (section 14.6).

## Watch out
- Never import a rule that would match differently from the source without telling the user: case-sensitive keys are imported (aliases ignore case) with a "wider match" warning.
- Imported aliases must not be applied retroactively to the rows of the same import; those rows already carry the payee KMyMoney assigned.
- On an alias clash between two payees the first by file order is kept; keeping the more specific one was left open pending a real file.

In the code:
- Spec: docs/specs/kmymoney-import.md (payee section and 14.6); plan: docs/future-plans/kmymoney-import-tasks.md, work package WP3c.
- Receiver: table payee_aliases (unique on user_id, LOWER(alias)), column payees.default_category_id.
- Warning codes: payeeMatchKeyNotImported, payeeMatchCaseWidened, payeeMatchKeyConflict, payeeMatchKeyOverlap, payeeDetailsKept.
